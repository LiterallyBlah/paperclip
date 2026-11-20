import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  approvals,
  companies,
  heartbeatRuns,
  issueApprovals,
  issues,
  issueThreadInteractions,
  projects,
  type Db,
} from "@paperclipai/db";
import { readRunCancellation } from "./run-cancellation.js";
import { parseIssueExecutionState } from "./issue-execution-policy.js";
import { buildPendingStageParticipantWakeup, readExecutionStageId } from "./execution-stage-wake-wait.js";
import { isAutomaticRecoverySuppressedByPauseHold } from "./recovery/pause-hold-guard.js";
import { SUBTREE_PAUSE_HOLD_WAKE_CANCEL_REASON } from "./issue-tree-control.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import type { WakeupOptions } from "./heartbeat/run-preparation.js";

/**
 * Maintenance-exit re-dispatch.
 *
 * A maintenance operation is one instance task drain: it starts with the
 * `instance.task_drain.started` audit row and ends with the next
 * `instance.task_drain.stopped` row, the next drain start, the drain TTL, or
 * (for a drain a restart ended) the boot marker this module writes. Runs and
 * stage wakes the window ended are the only candidates, and each eligible
 * task gets at most one wake per operation: the wake's idempotency key is
 * `maintenance_redispatch:<operationId>:<issueId>`, checked before dispatch
 * and enforced by a partial unique index over every wake status.
 */

export const MAINTENANCE_REDISPATCH_WAKE_REASON = "maintenance_redispatch";
export const MAINTENANCE_REDISPATCH_KEY_PREFIX = "maintenance_redispatch:";
export const MAINTENANCE_REDISPATCH_IDEMPOTENCY_INDEX = "agent_wakeup_requests_maintenance_redispatch_uq";
export const TASK_DRAIN_STARTED_ACTION = "instance.task_drain.started";
export const TASK_DRAIN_STOPPED_ACTION = "instance.task_drain.stopped";
/** A boot never auto-dispatches for a drain that ended longer ago than this. */
export const BOOT_REDISPATCH_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const ACTIVE_ISSUE_STATUSES = ["todo", "in_progress", "in_review"] as const;
const LOST_WAKE_STATUSES = ["cancelled", "skipped", "deferred_issue_execution"] as const;
const OPEN_WAKE_STATUSES = ["queued", "claimed"] as const;
const LIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const UNEXPECTED_CANCELLATION_SOURCES = new Set(["shutdown", "controller_lease", "transport", "provider", "unknown"]);
const INTENTIONAL_ERROR_CODES = new Set(["issue_cancelled", "issue_reassigned", "operator_interrupted"]);

export type MaintenanceOperationEnd = "stop" | "next_drain" | "expiry" | "restart";

export interface MaintenanceOperation {
  operationId: string;
  startedAt: Date;
  expiresAt: Date | null;
  /** Null while the drain is still active in this process. */
  endedAt: Date | null;
  endedBy: MaintenanceOperationEnd | null;
  /** Window end used for membership: endedAt, or `now` while still active. */
  windowEnd: Date;
}

export type MaintenanceRedispatchDecision =
  | "dispatched"
  | "would_dispatch"
  | "already_dispatched"
  | "skipped";

export interface MaintenanceManifestEntry {
  issueId: string;
  issueIdentifier: string | null;
  companyId: string;
  kind: "task" | "review_participant";
  agentId: string | null;
  evidence: {
    runId: string | null;
    runStatus: string | null;
    runErrorCode: string | null;
    runFinishedAt: string | null;
    cancellationSource: string | null;
    wakeId: string | null;
    wakeStatus: string | null;
    stageId: string | null;
  };
  decision: MaintenanceRedispatchDecision;
  skipReason: string | null;
  wakeId: string | null;
  wakeStatus: string | null;
  idempotencyKey: string;
}

export interface MaintenanceManifest {
  operation: MaintenanceOperation;
  dryRun: boolean;
  generatedAt: string;
  counts: Record<MaintenanceRedispatchDecision, number>;
  entries: MaintenanceManifestEntry[];
}

type WakeupFn = (agentId: string, opts: WakeupOptions) => Promise<{ id?: string } | null | undefined>;

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readDate(value: unknown) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Operation id of a started row. Drains recorded before operation ids existed
 * are addressed by their start time so the first exit after install is covered.
 */
export function operationIdFromDrainDetails(details: Record<string, unknown> | null | undefined, createdAt: Date) {
  const explicit = readString(details?.operationId);
  if (explicit) return explicit;
  const startedAt = readDate(details?.startedAt) ?? createdAt;
  return `legacy-${startedAt.getTime()}`;
}

export function buildMaintenanceRedispatchKey(operationId: string, issueId: string) {
  return `${MAINTENANCE_REDISPATCH_KEY_PREFIX}${operationId}:${issueId}`;
}

export function isMaintenanceRedispatchIdempotencyConflict(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; constraint_name?: unknown; message?: unknown; cause?: unknown };
    const constraint = candidate.constraint ?? candidate.constraint_name;
    if (candidate.code === "23505" && (constraint === MAINTENANCE_REDISPATCH_IDEMPOTENCY_INDEX ||
      (typeof candidate.message === "string" && candidate.message.includes(MAINTENANCE_REDISPATCH_IDEMPOTENCY_INDEX)))) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

/**
 * Classify why a run in the window ended. Only recorded evidence counts: the
 * run status, its error code and its server-written cancellation record.
 */
export function classifyWindowRun(run: Pick<typeof heartbeatRuns.$inferSelect, "status" | "errorCode" | "resultJson">):
  | { lost: true; cause: "process_lost" | "shutdown_interrupted" | "cancelled_by_window" }
  | { lost: false; reason: string } {
  const cancellation = readRunCancellation(run.resultJson);
  if (run.errorCode && INTENTIONAL_ERROR_CODES.has(run.errorCode)) {
    return { lost: false, reason: `intentional_stop:${run.errorCode}` };
  }
  if (cancellation?.expected && (cancellation.initiator.type === "user" || cancellation.initiator.type === "agent")) {
    return { lost: false, reason: cancellation.initiator.type === "user" ? "human_stop" : "intentional_stop:agent" };
  }
  if (run.status === "failed" && run.errorCode === "process_lost") return { lost: true, cause: "process_lost" };
  if ((run.status === "interrupted" || run.status === "cancelled") && run.errorCode === "server_shutdown_interrupted") {
    return { lost: true, cause: "shutdown_interrupted" };
  }
  if ((run.status === "cancelled" || run.status === "interrupted") && cancellation &&
      (!cancellation.expected || UNEXPECTED_CANCELLATION_SOURCES.has(cancellation.source))) {
    return { lost: true, cause: "cancelled_by_window" };
  }
  if (run.status === "cancelled" || run.status === "interrupted") {
    return { lost: false, reason: cancellation ? "intentional_stop:system" : "no_window_cancellation_evidence" };
  }
  return { lost: false, reason: `not_a_maintenance_stop:${run.status}${run.errorCode ? `:${run.errorCode}` : ""}` };
}

export function maintenanceRedispatchService(db: Db, deps: { wakeup?: WakeupFn; now?: () => Date } = {}) {
  const now = () => deps.now?.() ?? new Date();

  async function listDrainRows(action: string, since?: Date) {
    return db.select({ createdAt: activityLog.createdAt, details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.action, action),
        eq(activityLog.entityType, "instance_settings"),
        since ? gte(activityLog.createdAt, since) : undefined,
      ))
      .orderBy(asc(activityLog.createdAt));
  }

  /**
   * Resolve one operation (default: the latest drain). `activeOperationId` is
   * the operation id of the drain live in this process, if any.
   */
  async function resolveOperation(input: { operationId?: string | null; activeOperationId?: string | null } = {}):
    Promise<MaintenanceOperation | null> {
    const started = await listDrainRows(TASK_DRAIN_STARTED_ACTION);
    const starts = new Map<string, { startedAt: Date; expiresAt: Date | null; firstRowAt: Date }>();
    for (const row of started) {
      const id = operationIdFromDrainDetails(row.details, row.createdAt);
      if (!starts.has(id)) {
        starts.set(id, {
          startedAt: readDate(row.details?.startedAt) ?? row.createdAt,
          expiresAt: readDate(row.details?.expiresAt),
          firstRowAt: row.createdAt,
        });
      }
    }
    const ordered = [...starts.entries()].sort((a, b) => a[1].firstRowAt.getTime() - b[1].firstRowAt.getTime());
    const index = input.operationId
      ? ordered.findIndex(([id]) => id === input.operationId)
      : ordered.length - 1;
    if (index < 0) return null;
    const [operationId, start] = ordered[index]!;
    const nextStart = ordered[index + 1]?.[1].firstRowAt ?? null;
    const stops = await listDrainRows(TASK_DRAIN_STOPPED_ACTION, start.firstRowAt);
    const stop = stops.find((row) => {
      const stopOp = readString(row.details?.operationId);
      if (stopOp) return stopOp === operationId;
      return !nextStart || row.createdAt.getTime() <= nextStart.getTime();
    }) ?? null;
    const candidates: Array<{ at: Date; by: MaintenanceOperationEnd }> = [];
    if (stop) {
      candidates.push({ at: stop.createdAt, by: readString(stop.details?.endedBy) === "restart" ? "restart" : "stop" });
    }
    if (nextStart) candidates.push({ at: nextStart, by: "next_drain" });
    if (start.expiresAt && start.expiresAt.getTime() <= now().getTime()) {
      candidates.push({ at: start.expiresAt, by: "expiry" });
    }
    candidates.sort((a, b) => a.at.getTime() - b.at.getTime());
    let end = candidates[0] ?? null;
    if (!end && input.activeOperationId !== operationId) {
      // No stop row and the drain is not live here: a restart ended it and the
      // boot marker has not been written yet. The window runs to now.
      end = { at: now(), by: "restart" };
    }
    return {
      operationId,
      startedAt: start.startedAt,
      expiresAt: start.expiresAt,
      endedAt: end?.at ?? null,
      endedBy: end?.by ?? null,
      windowEnd: end?.at ?? now(),
    };
  }

  async function findDispatchedWake(companyId: string, key: string) {
    const [wake] = await db.select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.idempotencyKey, key)))
      .orderBy(asc(agentWakeupRequests.requestedAt))
      .limit(1);
    return wake ?? null;
  }

  const issueRunMatch = (issueId: string) => or(
    eq(heartbeatRuns.issueId, issueId),
    eq(heartbeatRuns.nativeIssueId, issueId),
    sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
  );

  /** Shared gates. Returns a skip reason, or null when the agent may be woken. */
  async function gateSkipReason(issue: typeof issues.$inferSelect, agentId: string, excludeWakeId: string | null) {
    const [liveRun] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, issue.companyId),
      issueRunMatch(issue.id),
      inArray(heartbeatRuns.status, [...LIVE_RUN_STATUSES]),
    )).limit(1);
    if (liveRun) return "live_run_or_scheduled_retry";
    const [openWake] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, issue.companyId),
      sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issue.id}`,
      or(
        inArray(agentWakeupRequests.status, [...OPEN_WAKE_STATUSES]),
        and(eq(agentWakeupRequests.status, "deferred_issue_execution"),
          excludeWakeId ? sql`${agentWakeupRequests.id} <> ${excludeWakeId}` : undefined),
      ),
    )).limit(1);
    if (openWake) return "queued_continuation";
    if (await isAutomaticRecoverySuppressedByPauseHold(db, issue.companyId, issue.id)) return "pause_hold";
    const [agent] = await db.select({ status: agents.status, pausedAt: agents.pausedAt }).from(agents)
      .where(and(eq(agents.companyId, issue.companyId), eq(agents.id, agentId))).limit(1);
    if (!agent) return "agent_missing";
    if (agent.status === "terminated") return "agent_terminated";
    if (agent.status === "paused" || agent.pausedAt) return "agent_paused";
    const [company] = await db.select({ status: companies.status, pausedAt: companies.pausedAt }).from(companies)
      .where(eq(companies.id, issue.companyId)).limit(1);
    if (company && (company.status === "paused" || company.pausedAt)) return "company_paused";
    if (issue.projectId) {
      const [project] = await db.select({ pausedAt: projects.pausedAt }).from(projects)
        .where(eq(projects.id, issue.projectId)).limit(1);
      if (project?.pausedAt) return "project_paused";
    }
    const [pendingApproval] = await db.select({ id: approvals.id }).from(issueApprovals)
      .innerJoin(approvals, eq(approvals.id, issueApprovals.approvalId))
      .where(and(eq(issueApprovals.issueId, issue.id), eq(approvals.status, "pending"))).limit(1);
    if (pendingApproval) return "pending_approval";
    const [pendingInteraction] = await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions)
      .where(and(eq(issueThreadInteractions.issueId, issue.id), eq(issueThreadInteractions.status, "pending"))).limit(1);
    if (pendingInteraction) return "pending_interaction";
    const blocker = await getExecutionBlocker(db, issue.companyId, issue.id, { admittingAgentId: agentId });
    if (blocker) return "no_replay_hold";
    return null;
  }

  async function latestIssueRun(issue: typeof issues.$inferSelect) {
    const [run] = await db.select().from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, issue.companyId), issueRunMatch(issue.id)))
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
      .limit(1);
    return run ?? null;
  }

  type Candidate = {
    issue: typeof issues.$inferSelect;
    run: typeof heartbeatRuns.$inferSelect | null;
    wake: typeof agentWakeupRequests.$inferSelect | null;
  };

  async function collectCandidates(op: MaintenanceOperation): Promise<Candidate[]> {
    const byIssue = new Map<string, Candidate>();
    const windowRuns = await db.select().from(heartbeatRuns).where(and(
      gte(heartbeatRuns.finishedAt, op.startedAt),
      lte(heartbeatRuns.finishedAt, op.windowEnd),
      inArray(heartbeatRuns.status, ["cancelled", "interrupted", "failed"]),
    )).orderBy(asc(heartbeatRuns.finishedAt));
    const runIssueId = (run: typeof heartbeatRuns.$inferSelect) =>
      run.issueId ?? run.nativeIssueId ?? readString(run.contextSnapshot?.issueId);
    const issueIds = new Set<string>();
    for (const run of windowRuns) {
      const issueId = runIssueId(run);
      if (issueId) issueIds.add(issueId);
    }
    const windowWakes = await db.select().from(agentWakeupRequests).where(and(
      inArray(agentWakeupRequests.status, [...LOST_WAKE_STATUSES]),
      isNull(agentWakeupRequests.runId),
      or(
        and(gte(agentWakeupRequests.requestedAt, op.startedAt), lte(agentWakeupRequests.requestedAt, op.windowEnd)),
        and(gte(agentWakeupRequests.updatedAt, op.startedAt), lte(agentWakeupRequests.updatedAt, op.windowEnd)),
      ),
      sql`${agentWakeupRequests.payload} ->> 'issueId' is not null`,
    )).orderBy(asc(agentWakeupRequests.requestedAt));
    for (const wake of windowWakes) {
      const issueId = readString(wake.payload?.issueId);
      if (issueId) issueIds.add(issueId);
    }
    if (issueIds.size === 0) return [];
    const rows = await db.select().from(issues).where(inArray(issues.id, [...issueIds]));
    for (const issue of rows) {
      const run = [...windowRuns].reverse().find((r) => runIssueId(r) === issue.id && r.companyId === issue.companyId) ?? null;
      const wake = [...windowWakes].reverse().find((w) => w.payload?.issueId === issue.id && w.companyId === issue.companyId) ?? null;
      byIssue.set(issue.id, { issue, run, wake });
    }
    return [...byIssue.values()];
  }

  type Plan = {
    entry: MaintenanceManifestEntry;
    dispatch: { agentId: string; opts: WakeupOptions } | null;
  };

  async function planCandidate(op: MaintenanceOperation, candidate: Candidate): Promise<Plan> {
    const { issue } = candidate;
    const key = buildMaintenanceRedispatchKey(op.operationId, issue.id);
    const state = parseIssueExecutionState(issue.executionState);
    const participantAgentId = issue.status === "in_review" && state?.status === "pending" &&
      state.currentParticipant?.type === "agent" ? state.currentParticipant.agentId ?? null : null;
    const kind: MaintenanceManifestEntry["kind"] = issue.status === "in_review" ? "review_participant" : "task";
    const targetAgentId = kind === "review_participant" ? participantAgentId : issue.assigneeAgentId;
    const run = candidate.run;
    const wake = candidate.wake && (!targetAgentId || candidate.wake.agentId === targetAgentId) ? candidate.wake : null;
    const entry: MaintenanceManifestEntry = {
      issueId: issue.id,
      issueIdentifier: issue.identifier ?? null,
      companyId: issue.companyId,
      kind,
      agentId: targetAgentId,
      evidence: {
        runId: run?.id ?? null,
        runStatus: run?.status ?? null,
        runErrorCode: run?.errorCode ?? null,
        runFinishedAt: run?.finishedAt?.toISOString() ?? null,
        cancellationSource: run ? readRunCancellation(run.resultJson)?.source ?? null : null,
        wakeId: wake?.id ?? null,
        wakeStatus: wake?.status ?? null,
        stageId: kind === "review_participant" ? state?.currentStageId ?? null : null,
      },
      decision: "skipped",
      skipReason: null,
      wakeId: null,
      wakeStatus: null,
      idempotencyKey: key,
    };
    const skip = (reason: string): Plan => ({ entry: { ...entry, skipReason: reason }, dispatch: null });

    const existing = await findDispatchedWake(issue.companyId, key);
    if (existing) {
      return { entry: { ...entry, decision: "already_dispatched", wakeId: existing.id, wakeStatus: existing.status }, dispatch: null };
    }
    if (!(ACTIVE_ISSUE_STATUSES as readonly string[]).includes(issue.status)) return skip(`issue_status:${issue.status}`);
    if (!targetAgentId) return skip(kind === "review_participant" ? "no_pending_agent_participant" : "no_agent_assignee");

    // Window evidence: the latest run on the task is the one the window ended,
    // run by the agent that would be woken; or, for a review stage, the
    // current participant's latest wake for this stage ended with no run.
    let evidence: "run" | "wake" | null = null;
    let evidenceReason: string | null = null;
    if (run) {
      const latest = await latestIssueRun(issue);
      const cls = classifyWindowRun(run);
      if (latest && latest.id !== run.id) {
        evidenceReason = (LIVE_RUN_STATUSES as readonly string[]).includes(latest.status)
          ? "live_run_or_scheduled_retry" : "superseded_by_later_run";
      }
      else if (!cls.lost) evidenceReason = cls.reason;
      else if (run.agentId !== targetAgentId) evidenceReason = "owner_changed_since_run";
      else if (kind === "review_participant" &&
        readExecutionStageId(run.contextSnapshot) !== null &&
        readExecutionStageId(run.contextSnapshot) !== state?.currentStageId) evidenceReason = "stage_changed_since_run";
      else evidence = "run";
    }
    if (!evidence && kind === "review_participant" && wake) {
      if (wake.status === "cancelled" && (wake.error ?? "") === SUBTREE_PAUSE_HOLD_WAKE_CANCEL_REASON) {
        evidenceReason = "pause_hold";
      } else if (readExecutionStageId(wake.payload) !== state?.currentStageId) {
        evidenceReason = evidenceReason ?? "stage_changed_since_wake";
      } else {
        const [later] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
          eq(heartbeatRuns.companyId, issue.companyId),
          eq(heartbeatRuns.agentId, targetAgentId),
          issueRunMatch(issue.id),
          gte(heartbeatRuns.createdAt, wake.requestedAt),
        )).limit(1);
        if (later) evidenceReason = "participant_ran_after_wake";
        else evidence = "wake";
      }
    }
    if (!evidence) return skip(evidenceReason ?? (kind === "task" ? "no_window_evidence_for_assignee" : "no_window_evidence_for_participant"));

    const gate = await gateSkipReason(issue, targetAgentId, evidence === "wake" ? wake?.id ?? null : null);
    if (gate) return skip(gate);

    const common = {
      maintenanceOperationId: op.operationId,
      maintenanceRedispatch: true,
      ...(run && evidence === "run" ? { maintenanceSourceRunId: run.id } : {}),
      ...(wake && evidence === "wake" ? { maintenanceSourceWakeId: wake.id } : {}),
    };
    if (kind === "review_participant") {
      const stageWake = state ? buildPendingStageParticipantWakeup(issue.id, state) : null;
      if (!stageWake || stageWake.agentId !== targetAgentId) return skip("no_pending_agent_participant");
      return {
        entry: { ...entry, decision: "would_dispatch" },
        dispatch: {
          agentId: targetAgentId,
          opts: {
            source: "assignment",
            triggerDetail: "system",
            reason: stageWake.reason,
            payload: { ...stageWake.payload, ...common },
            contextSnapshot: { ...stageWake.contextSnapshot, ...common },
            requestedByActorType: "system",
            requestedByActorId: "maintenance-redispatch",
            idempotencyKey: key,
          },
        },
      };
    }
    const payload = { issueId: issue.id, taskId: issue.id, mutation: "maintenance_redispatch", ...common };
    return {
      entry: { ...entry, decision: "would_dispatch" },
      dispatch: {
        agentId: targetAgentId,
        opts: {
          source: "automation",
          triggerDetail: "system",
          reason: MAINTENANCE_REDISPATCH_WAKE_REASON,
          payload,
          contextSnapshot: { ...payload, wakeReason: MAINTENANCE_REDISPATCH_WAKE_REASON, source: "maintenance.redispatch" },
          requestedByActorType: "system",
          requestedByActorId: "maintenance-redispatch",
          idempotencyKey: key,
          // Ownership and status are re-checked at admission, not only here.
          issueStateGuard: { statuses: [issue.status], assigneeAgentId: targetAgentId },
        },
      },
    };
  }

  function countEntries(entries: MaintenanceManifestEntry[]) {
    const counts: Record<MaintenanceRedispatchDecision, number> = {
      dispatched: 0, would_dispatch: 0, already_dispatched: 0, skipped: 0,
    };
    for (const entry of entries) counts[entry.decision] += 1;
    return counts;
  }

  /**
   * Build the manifest; with `apply`, dispatch each eligible task once.
   * Apply refuses an operation whose drain is still active.
   */
  async function run(input: {
    operationId?: string | null;
    activeOperationId?: string | null;
    apply?: boolean;
  } = {}): Promise<MaintenanceManifest | null> {
    const op = await resolveOperation(input);
    if (!op) return null;
    const apply = Boolean(input.apply);
    if (apply && !op.endedAt) throw new Error("maintenance operation is still active");
    if (apply && !deps.wakeup) throw new Error("maintenance redispatch needs a wakeup function to apply");
    const candidates = await collectCandidates(op);
    const entries: MaintenanceManifestEntry[] = [];
    for (const candidate of candidates) {
      const plan = await planCandidate(op, candidate);
      if (!apply || !plan.dispatch) {
        entries.push(plan.entry);
        continue;
      }
      try {
        const queued = await deps.wakeup!(plan.dispatch.agentId, plan.dispatch.opts);
        const stored = await findDispatchedWake(plan.entry.companyId, plan.entry.idempotencyKey);
        entries.push(stored
          ? { ...plan.entry, decision: "dispatched", wakeId: stored.id, wakeStatus: stored.status }
          : { ...plan.entry, decision: "skipped", skipReason: queued ? "wake_coalesced_without_key" : "wake_refused_at_admission" });
      } catch (error) {
        if (!isMaintenanceRedispatchIdempotencyConflict(error)) throw error;
        const stored = await findDispatchedWake(plan.entry.companyId, plan.entry.idempotencyKey);
        entries.push({ ...plan.entry, decision: "already_dispatched", wakeId: stored?.id ?? null, wakeStatus: stored?.status ?? null });
      }
    }
    entries.sort((a, b) => a.issueId.localeCompare(b.issueId));
    return { operation: op, dryRun: !apply, generatedAt: now().toISOString(), counts: countEntries(entries), entries };
  }

  /**
   * At boot: a drain recorded as started with no stop row was ended by the
 * restart (or lapsed by its TTL before it).
   * Write its end marker (one row per company, like the stop route), then
   * apply once. Drains that ended longer ago than the max age are only marked.
   */
  async function closeDrainEndedByRestart(companyIds: string[]) {
    const op = await resolveOperation({ activeOperationId: null });
    if (!op || (op.endedBy !== "restart" && op.endedBy !== "expiry")) return { operation: op, marked: false, manifest: null };
    const [marker] = await db.select({ id: activityLog.id }).from(activityLog).where(and(
      eq(activityLog.action, TASK_DRAIN_STOPPED_ACTION),
      sql`${activityLog.details} ->> 'operationId' = ${op.operationId}`,
    )).limit(1);
    if (marker) return { operation: op, marked: false, manifest: null };
    const at = now();
    await db.transaction(async (tx) => {
      for (const companyId of companyIds) {
        await tx.insert(activityLog).values({
          companyId,
          actorType: "system",
          actorId: "maintenance-redispatch",
          action: TASK_DRAIN_STOPPED_ACTION,
          entityType: "instance_settings",
          entityId: "default",
          details: { wasActive: true, operationId: op.operationId, endedBy: "restart" },
          createdAt: at,
        });
      }
    });
    const closed = await resolveOperation({ operationId: op.operationId, activeOperationId: null });
    if (!closed?.endedAt || at.getTime() - closed.endedAt.getTime() > BOOT_REDISPATCH_MAX_AGE_MS) {
      return { operation: closed, marked: true, manifest: null };
    }
    const manifest = await run({ operationId: op.operationId, activeOperationId: null, apply: true });
    return { operation: closed, marked: true, manifest };
  }

  return { resolveOperation, run, closeDrainEndedByRestart };
}
