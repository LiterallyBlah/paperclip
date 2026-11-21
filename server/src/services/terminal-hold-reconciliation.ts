import { and, asc, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  heartbeatRuns,
  issueComments,
  issueExecutionDecisions,
  issueRecoveryActions,
  issues,
  issueThreadInteractions,
  projects,
  toolInvocations,
  type Db,
} from "@paperclipai/db";
import type { ExecutionReconciliation } from "@paperclipai/shared";
import { hasWorkspaceRestoreFailure } from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { budgetService } from "./budgets.js";
import { executionBlockerPredicate, getExecutionBlocker } from "./execution-blocker.js";
import {
  markExecutionReconciliation,
  pendingStageRecoveryWakeKey,
  validateExecutionReconciliation,
  type PendingStageParticipantDeliveryOwner,
} from "./execution-recovery-resolution.js";
import { buildPendingStageParticipantWakeup } from "./execution-stage-wake-wait.js";
import { issueApprovalService } from "./issue-approvals.js";
import { normalizeIssueExecutionPolicy, parseIssueExecutionState } from "./issue-execution-policy.js";
import { activeIssueInteractionCondition } from "./issue-question-context.js";
import { issueTreeControlService } from "./issue-tree-control.js";
import { issueService } from "./issues.js";
import { LEGACY_RECOVERY_CAUSE } from "./legacy-execution-recovery.js";
import { readSystemRecovery } from "./system-recovery-state.js";
import { hasRequiredWorkspaceRecovery } from "./workspace-restore-recovery-state.js";

/**
 * Automatic settlement of a no-replay hold whose source run is terminal and
 * whose only recorded effect is a review verdict that has already been applied.
 *
 * A reviewer's verdict stops the reviewer's own legacy run before the task
 * update commits (the run is cancelled as `issue_reassigned`). At that moment
 * the task is still the reviewer's pending stage, so the stop raises a
 * no-replay hold naming the reviewer as review participant. Once the verdict
 * commits, the hold blocks the next owner even though nothing of the stopped
 * run needs to be repeated. This sweep settles exactly that case and nothing
 * else: it never infers safety from a terminal status alone.
 */
export const TERMINAL_HOLD_RECONCILIATION_POLICY = "terminal_source_verdict_v1";
export const TERMINAL_HOLD_RECONCILIATION_ACTOR = "system:terminal-hold-reconciliation";

/** Agent activity a stopped run can leave without an effect beyond Paperclip's own records. */
const REPEATABLE_ACTIONS = new Set([
  "environment.lease_acquired", "environment.lease_released",
  "tool_gateway.discovery", "issue.checked_out", "issue.read_marked",
]);
/** Agent activity on the source task itself that the applied verdict accounts for. */
const VERDICT_TASK_ACTIONS = new Set([
  "issue.updated", "issue.comment_added", "issue.released", "issue.execution_returned_to_executor",
]);
const ACTIVE_APPROVAL_STATUSES = new Set(["pending", "revision_requested"]);
const LIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"];

type Action = typeof issueRecoveryActions.$inferSelect;
type Run = typeof heartbeatRuns.$inferSelect;
type Task = typeof issues.$inferSelect;

export type TerminalHoldBasis = "changes_requested_hand_back" | "approved_stage_advance";

export type RecordedEffectInventory = {
  comments: number;
  agentActivity: number;
  toolInvocations: number;
  unaccounted: Array<{ kind: "comment" | "activity" | "tool_invocation"; id: string; detail: string }>;
};

export type TerminalHoldAssessment =
  | { settle: false; reason: string; detail?: Record<string, unknown> }
  | {
      settle: true;
      basis: TerminalHoldBasis;
      continuationAgentId: string;
      decisionId: string;
      effects: RecordedEffectInventory;
      stage?: { stageId: string; changesRequestedCount: number };
    };

const keep = (reason: string, detail?: Record<string, unknown>): TerminalHoldAssessment =>
  ({ settle: false, reason, ...(detail ? { detail } : {}) });

/** Every record Paperclip holds of what the run did. Anything not explained by the verdict is unaccounted. */
export async function inventoryRecordedEffects(db: Db, run: Run, issueId: string): Promise<RecordedEffectInventory> {
  const comments = await db.select({ id: issueComments.id, issueId: issueComments.issueId }).from(issueComments).where(and(
    eq(issueComments.companyId, run.companyId),
    or(eq(issueComments.createdByRunId, run.id), eq(issueComments.derivedCreatedByRunId, run.id)),
  ));
  const activity = await db.select({ id: activityLog.id, action: activityLog.action, entityType: activityLog.entityType,
    entityId: activityLog.entityId }).from(activityLog).where(and(
    eq(activityLog.companyId, run.companyId), eq(activityLog.runId, run.id), eq(activityLog.actorType, "agent"),
  ));
  const invocations = await db.select({ id: toolInvocations.id }).from(toolInvocations).where(and(
    eq(toolInvocations.companyId, run.companyId), eq(toolInvocations.runId, run.id),
  ));
  const unaccounted: RecordedEffectInventory["unaccounted"] = [];
  for (const comment of comments) {
    if (comment.issueId !== issueId) unaccounted.push({ kind: "comment", id: comment.id, detail: "comment on another task" });
  }
  for (const entry of activity) {
    if (REPEATABLE_ACTIONS.has(entry.action)) continue;
    if (entry.entityType === "issue" && entry.entityId === issueId && VERDICT_TASK_ACTIONS.has(entry.action)) continue;
    unaccounted.push({ kind: "activity", id: entry.id, detail: entry.action });
  }
  // A gateway tool call may have changed something outside Paperclip.
  for (const invocation of invocations) unaccounted.push({ kind: "tool_invocation", id: invocation.id, detail: "tool call" });
  return { comments: comments.length, agentActivity: activity.length, toolInvocations: invocations.length, unaccounted };
}

/**
 * Decide, from durable state only, whether the hold may be settled. Callers
 * pass rows they have locked. Returns a recorded reason whenever it keeps the hold.
 */
export async function assessTerminalSourceHold(db: Db, input: { action: Action; run: Run | undefined; task: Task | undefined }):
Promise<TerminalHoldAssessment> {
  const { action, run, task } = input;
  if (action.cause !== LEGACY_RECOVERY_CAUSE || action.kind !== "active_run_watchdog") return keep("not_legacy_execution_hold");
  if (action.evidence.executionReconciliation !== undefined) return keep("already_reconciled");
  if (readSystemRecovery(action.evidence)) return keep("system_recovery_owned");
  if (hasWorkspaceRestoreFailure(action.evidence) || hasRequiredWorkspaceRecovery(action.evidence)) return keep("workspace_repair_required");
  const automatic = action.evidence.automaticRecovery as { replay?: unknown } | undefined;
  if (!["active", "escalated"].includes(action.status) && automatic?.replay !== "blocked") return keep("hold_not_effective");
  if (!run || !task) return keep("source_missing");
  const runId = action.evidence.runId;
  if (runId !== run.id || (run.nativeIssueId ?? run.contextSnapshot?.issueId) !== task.id) return keep("source_mismatch");
  if (run.runtimeMode !== "legacy") return keep("not_legacy_run");
  if (hasWorkspaceRestoreFailure(run.resultJson) || hasRequiredWorkspaceRecovery(run.resultJson)) return keep("workspace_repair_required");

  // The source must be a reviewer whose own verdict stopped its run.
  const reviewerId = action.evidence.reviewParticipantAgentId;
  if (typeof reviewerId !== "string" || reviewerId !== run.agentId) return keep("not_reviewer_source");
  if (run.status !== "cancelled" || run.errorCode !== "issue_reassigned" ||
      run.resultJson?.reassignmentStopConfirmed !== true || typeof run.resultJson?.issueMutationStopId !== "string") {
    return keep("not_verdict_stop", { status: run.status, errorCode: run.errorCode });
  }
  if (["done", "cancelled"].includes(task.status)) return keep("task_closed");
  if (task.status === "blocked") return keep("task_blocked");

  // The verdict must be applied: it is the task's latest decision, made by this run.
  const state = parseIssueExecutionState(task.executionState);
  if (!state?.lastDecisionId || !state.lastDecisionOutcome) return keep("verdict_not_applied");
  const [latest] = await db.select().from(issueExecutionDecisions).where(and(
    eq(issueExecutionDecisions.companyId, task.companyId), eq(issueExecutionDecisions.issueId, task.id),
  )).orderBy(desc(issueExecutionDecisions.createdAt), desc(issueExecutionDecisions.id)).limit(1);
  if (!latest || latest.id !== state.lastDecisionId || latest.createdByRunId !== run.id ||
      latest.actorAgentId !== run.agentId || latest.actorUserId || latest.outcome !== state.lastDecisionOutcome) {
    return keep("verdict_not_applied");
  }

  let basis: TerminalHoldBasis;
  let continuationAgentId: string;
  let stage: { stageId: string; changesRequestedCount: number } | undefined;
  if (state.status === "changes_requested" && latest.outcome === "changes_requested") {
    if (state.returnAssignee?.type !== "agent" || !state.returnAssignee.agentId) return keep("human_return_assignee");
    if (task.assigneeAgentId !== state.returnAssignee.agentId || task.assigneeAgentId === run.agentId) {
      return keep("owner_changed");
    }
    basis = "changes_requested_hand_back";
    continuationAgentId = task.assigneeAgentId;
  } else if (state.status === "pending" && latest.outcome === "approved" && task.status === "in_review") {
    if (state.currentParticipant?.type !== "agent" || !state.currentParticipant.agentId) return keep("human_participant");
    if (task.assigneeAgentId !== state.currentParticipant.agentId || task.assigneeAgentId === run.agentId ||
        !state.currentStageId) return keep("owner_changed");
    const policy = normalizeIssueExecutionPolicy(task.executionPolicy ?? null);
    if (!policy?.stages.some((candidate) => candidate.id === state.currentStageId)) return keep("stage_missing");
    basis = "approved_stage_advance";
    continuationAgentId = task.assigneeAgentId;
    stage = { stageId: state.currentStageId, changesRequestedCount: state.changesRequestedCount ?? 0 };
  } else {
    return keep("not_verdict_hand_back", { executionStatus: state.status, outcome: latest.outcome });
  }

  // Liveness: no checkout, execution binding or queued/running run on the task.
  if ((task.checkoutRunId && task.checkoutRunId !== run.id) || (task.executionRunId && task.executionRunId !== run.id)) {
    return keep("live_execution", { checkoutRunId: task.checkoutRunId, executionRunId: task.executionRunId });
  }
  const [liveRun] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, task.companyId), inArray(heartbeatRuns.status, LIVE_RUN_STATUSES),
    or(eq(heartbeatRuns.nativeIssueId, task.id), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${task.id}`),
  )).limit(1);
  if (liveRun) return keep("live_execution", { runId: liveRun.id });

  // Any other open or effective recovery on the task stays authoritative.
  const [competing] = await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, task.companyId), eq(issueRecoveryActions.sourceIssueId, task.id),
    ne(issueRecoveryActions.id, action.id),
    or(inArray(issueRecoveryActions.status, ["active", "escalated"]), executionBlockerPredicate()),
  )).limit(1);
  if (competing) return keep("competing_recovery", { recoveryActionId: competing.id });

  // Human and resource stops.
  const [interaction] = await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, task.companyId), eq(issueThreadInteractions.issueId, task.id),
    eq(issueThreadInteractions.status, "pending"), activeIssueInteractionCondition(),
  )).limit(1);
  if (interaction) return keep("interaction_pending", { interactionId: interaction.id });
  const approvals = await issueApprovalService(db).listApprovalsForIssue(task.id);
  if (approvals.some((approval) => ACTIVE_APPROVAL_STATUSES.has(String(approval.status)))) return keep("approval_pending");
  const pauseHold = await issueTreeControlService(db).getActivePauseHoldGate(task.companyId, task.id);
  if (pauseHold) return keep("pause_hold", { holdId: pauseHold.holdId });
  if (task.projectId) {
    const [project] = await db.select({ pausedAt: projects.pausedAt }).from(projects).where(and(
      eq(projects.companyId, task.companyId), eq(projects.id, task.projectId),
    ));
    if (project?.pausedAt) return keep("project_paused");
  }
  const [owner] = await db.select({ status: agents.status }).from(agents).where(and(
    eq(agents.companyId, task.companyId), eq(agents.id, continuationAgentId),
  ));
  if (!owner || owner.status === "paused" || owner.status === "terminated") return keep("continuation_agent_unavailable");
  if (await budgetService(db).getInvocationBlock(task.companyId, continuationAgentId,
    { issueId: task.id, projectId: task.projectId })) return keep("budget_blocked");
  const readiness = await issueService(db).getDependencyReadiness(task.id, db);
  if (readiness.unresolvedBlockerCount > 0) return keep("dependency_blocked");
  if (stage) {
    const [delivered] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, task.companyId), eq(agentWakeupRequests.agentId, continuationAgentId),
      eq(agentWakeupRequests.idempotencyKey, pendingStageRecoveryWakeKey(task.id, stage)),
    )).limit(1);
    if (delivered) return keep("stage_round_already_resumed", { wakeupRequestId: delivered.id });
  }

  // Recorded effects: only the verdict on this task.
  const effects = await inventoryRecordedEffects(db, run, task.id);
  if (effects.unaccounted.length) return keep("unaccounted_effects", { unaccounted: effects.unaccounted.slice(0, 10) });

  // Provider stop, process, coordinator, lease and owner checks: the same validation the board uses.
  const decision = reconciliationRecord(run.id, basis, latest.id);
  try {
    await validateExecutionReconciliation({
      db, companyId: task.companyId, issueId: task.id, agentId: continuationAgentId, sourceRunId: run.id,
      decision, recoveryAction: action, admitApprovedAdvance: basis === "approved_stage_advance",
    });
  } catch (error) {
    if (error instanceof HttpError) return keep("source_unverified", { message: error.message });
    throw error;
  }
  return { settle: true, basis, continuationAgentId, decisionId: latest.id, effects, ...(stage ? { stage } : {}) };
}

function reconciliationRecord(runId: string, basis: TerminalHoldBasis, decisionId: string): ExecutionReconciliation {
  return {
    runId,
    providerStopped: true,
    actionOutcome: "completed",
    outcomeEvidence: `Automatic: the source run stopped for its own ${basis === "approved_stage_advance" ? "approval" : "changes-requested"} verdict (decision ${decisionId}), which is applied. No other recorded effect. External effects of local tools are not observable and were not reconciled.`,
  };
}

function candidateHolds() {
  return and(
    eq(issueRecoveryActions.cause, LEGACY_RECOVERY_CAUSE),
    eq(issueRecoveryActions.kind, "active_run_watchdog"),
    sql`${issueRecoveryActions.evidence} ? 'reviewParticipantAgentId'`,
    sql`not (${issueRecoveryActions.evidence} ? 'executionReconciliation')`,
    sql`not (${issueRecoveryActions.evidence} ? 'systemRecovery')`,
    or(
      inArray(issueRecoveryActions.status, ["active", "escalated"]),
      sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`,
    ),
  );
}

/** A kept hold is checked again after this long; state that kept it may have changed. */
export const TERMINAL_HOLD_RECHECK_MS = 60_000;

/** Candidate holds that are due for a (re)check at `now`. */
export function terminalHoldReviewDue(now = new Date()) {
  const cutoff = new Date(now.getTime() - TERMINAL_HOLD_RECHECK_MS).toISOString();
  return and(candidateHolds(), sql`coalesce(${issueRecoveryActions.evidence}->'automaticReconciliationReview'->>'checkedAt', '') < ${cutoff}`);
}

/** Earliest time a candidate hold becomes due, or null when there is none. */
export async function nextTerminalHoldReviewAt(db: Db): Promise<Date | null> {
  const [row] = await db.select({ checkedAt: sql<string | null>`${issueRecoveryActions.evidence}->'automaticReconciliationReview'->>'checkedAt'` })
    .from(issueRecoveryActions).where(candidateHolds())
    .orderBy(sql`${issueRecoveryActions.evidence}->'automaticReconciliationReview'->>'checkedAt' asc nulls first`).limit(1);
  if (!row) return null;
  const checkedAt = row.checkedAt ? Date.parse(row.checkedAt) : Number.NaN;
  return Number.isFinite(checkedAt) ? new Date(checkedAt + TERMINAL_HOLD_RECHECK_MS) : new Date();
}

type StageWake = {
  actionId: string;
  companyId: string;
  issueId: string;
  owner: PendingStageParticipantDeliveryOwner;
};

/**
 * One pass of the sweep. A changes-requested hand-back is settled as a
 * pending reconciled continuation that `deliverReconciledExecutions` delivers
 * once to the return executor. An approved advance is delivered here as the
 * stage wake for the current participant, keyed by stage round.
 */
export async function reconcileTerminalSourceHolds(
  db: Db,
  wake: ReturnType<typeof import("./heartbeat.js").heartbeatService>["wakeup"] | null,
  now = new Date(),
  limit = 25,
) {
  const candidates = await db.select({ id: issueRecoveryActions.id, companyId: issueRecoveryActions.companyId,
    sourceIssueId: issueRecoveryActions.sourceIssueId }).from(issueRecoveryActions).where(terminalHoldReviewDue(now))
    .orderBy(sql`${issueRecoveryActions.evidence}->'automaticReconciliationReview'->>'checkedAt' asc nulls first`,
      asc(issueRecoveryActions.createdAt))
    .limit(limit);
  const settled: string[] = [];
  const stageWakes: StageWake[] = [];
  for (const candidate of candidates) {
    try {
      const outcome = await db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('statement_timeout', '15000', true), set_config('lock_timeout', '1000', true)`);
        const txDb = tx as unknown as Db;
        const [task] = await tx.select().from(issues).where(and(
          eq(issues.companyId, candidate.companyId), eq(issues.id, candidate.sourceIssueId))).for("update");
        const [action] = await tx.select().from(issueRecoveryActions).where(and(
          eq(issueRecoveryActions.companyId, candidate.companyId), eq(issueRecoveryActions.id, candidate.id),
          candidateHolds())).for("update");
        if (!action) return null;
        const runId = typeof action.evidence.runId === "string" ? action.evidence.runId : null;
        const [run] = runId ? await tx.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.companyId, action.companyId), eq(heartbeatRuns.id, runId))).for("update") : [];
        const assessment = await assessTerminalSourceHold(txDb, { action, run, task });
        if (!assessment.settle) {
          const previous = action.evidence.automaticReconciliationReview as { reason?: unknown; reasonChangedAt?: unknown } | undefined;
          // Record why the hold stays. An unchanged reason keeps its first-seen time.
          await tx.update(issueRecoveryActions).set({
            evidence: sql`${issueRecoveryActions.evidence} || ${JSON.stringify({ automaticReconciliationReview: {
              policy: TERMINAL_HOLD_RECONCILIATION_POLICY, outcome: "kept", reason: assessment.reason,
              ...(assessment.detail ? { detail: assessment.detail } : {}), checkedAt: now.toISOString(),
              reasonChangedAt: previous?.reason === assessment.reason && typeof previous.reasonChangedAt === "string"
                ? previous.reasonChangedAt : now.toISOString(),
            } })}::jsonb`,
          }).where(eq(issueRecoveryActions.id, action.id));
          return null;
        }
        const decision = reconciliationRecord(run!.id, assessment.basis, assessment.decisionId);
        const owner: PendingStageParticipantDeliveryOwner | undefined = assessment.stage ? {
          kind: "pending_stage_participant", agentId: assessment.continuationAgentId,
          stageId: assessment.stage.stageId, changesRequestedCount: assessment.stage.changesRequestedCount,
          idempotencyKey: pendingStageRecoveryWakeKey(task!.id, assessment.stage),
        } : undefined;
        await markExecutionReconciliation(txDb, action, decision, TERMINAL_HOLD_RECONCILIATION_ACTOR, owner,
          owner ? undefined : { continuationAgentId: assessment.continuationAgentId });
        const record = {
          policy: TERMINAL_HOLD_RECONCILIATION_POLICY,
          outcome: "settled",
          basis: assessment.basis,
          recordedAt: now.toISOString(),
          sourceRunId: run!.id,
          decisionId: assessment.decisionId,
          continuationAgentId: assessment.continuationAgentId,
          previousStatus: action.status,
          previousOutcome: action.outcome,
          ...(action.evidence.automaticRecovery ? { previousAutomaticRecovery: action.evidence.automaticRecovery } : {}),
          verified: [
            "source_run_terminal_verdict_stop", "verdict_is_latest_decision_by_source_run",
            "no_live_checkout_execution_or_run", "provider_process_coordinator_and_lease_released",
            "no_competing_recovery", "no_human_or_resource_stop", "recorded_effects_accounted",
          ],
          recordedEffects: { comments: assessment.effects.comments, agentActivity: assessment.effects.agentActivity,
            toolInvocations: assessment.effects.toolInvocations },
          // Paperclip cannot see local tool calls made by a legacy CLI. They are not claimed as reconciled.
          externalEffects: "not_observable",
        };
        await tx.update(issueRecoveryActions).set({
          status: "resolved", outcome: "restored", resolvedAt: now, updatedAt: now, wakePolicy: null, monitorPolicy: null,
          resolutionNote: "Settled automatically: the stopped source run's only recorded effect is its applied review verdict.",
          evidence: sql`${issueRecoveryActions.evidence} || ${JSON.stringify({ automaticReconciliation: record })}::jsonb`,
        }).where(eq(issueRecoveryActions.id, action.id));
        await logActivity(txDb, {
          companyId: action.companyId, actorType: "system", actorId: "execution-recovery",
          action: "issue.recovery_action_resolved", entityType: "issue", entityId: task!.id, agentId: null, runId: run!.id,
          details: { recoveryActionId: action.id, outcome: "restored", automaticReconciliation: {
            policy: TERMINAL_HOLD_RECONCILIATION_POLICY, basis: assessment.basis,
            continuationAgentId: assessment.continuationAgentId } },
        });
        return { actionId: action.id, owner };
      });
      if (!outcome) continue;
      settled.push(outcome.actionId);
      if (outcome.owner) stageWakes.push({ actionId: outcome.actionId, companyId: candidate.companyId,
        issueId: candidate.sourceIssueId, owner: outcome.owner });
    } catch (err) {
      logger.warn({ err, recoveryActionId: candidate.id }, "Terminal-source hold reconciliation remains pending");
    }
  }
  if (wake) await deliverStageContinuations(db, wake, stageWakes);
  return { settled };
}

/** Find approved-advance settlements whose stage wake has not been delivered yet (for example after a crash). */
async function undeliveredStageContinuations(db: Db): Promise<StageWake[]> {
  const rows = await db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.cause, LEGACY_RECOVERY_CAUSE),
    eq(issueRecoveryActions.status, "resolved"),
    sql`${issueRecoveryActions.evidence}->'automaticReconciliation'->>'policy' = ${TERMINAL_HOLD_RECONCILIATION_POLICY}`,
    sql`${issueRecoveryActions.evidence}->'continuationDeliveryOwner'->>'kind' = 'pending_stage_participant'`,
    sql`${issueRecoveryActions.evidence}->>'continuationDelivery' = 'delegated'`,
    sql`not (${issueRecoveryActions.evidence} ? 'continuationRunId')`,
  )).limit(25);
  return rows.map((row) => ({ actionId: row.id, companyId: row.companyId, issueId: row.sourceIssueId,
    owner: row.evidence.continuationDeliveryOwner as PendingStageParticipantDeliveryOwner }));
}

async function deliverStageContinuations(
  db: Db,
  wake: ReturnType<typeof import("./heartbeat.js").heartbeatService>["wakeup"],
  fresh: StageWake[],
) {
  const seen = new Set(fresh.map((entry) => entry.actionId));
  const pending = [...fresh, ...(await undeliveredStageContinuations(db)).filter((entry) => !seen.has(entry.actionId))];
  for (const entry of pending) {
    try {
      // Re-check immediately before waking: the settlement, stage round,
      // participant and owner must be unchanged, nothing may hold the
      // participant, and the keyed wake must not exist yet.
      const [action] = await db.select().from(issueRecoveryActions).where(and(
        eq(issueRecoveryActions.companyId, entry.companyId), eq(issueRecoveryActions.id, entry.actionId)));
      const [task] = await db.select().from(issues).where(and(
        eq(issues.companyId, entry.companyId), eq(issues.id, entry.issueId)));
      const state = task ? parseIssueExecutionState(task.executionState) : null;
      const owner = entry.owner;
      if (!action || !task || !state || action.status !== "resolved" || action.evidence.continuationRunId ||
          action.evidence.continuationDelivery !== "delegated" ||
          (action.evidence.continuationDeliveryOwner as { idempotencyKey?: unknown } | undefined)?.idempotencyKey !== owner.idempotencyKey ||
          owner.idempotencyKey !== pendingStageRecoveryWakeKey(task.id, owner) ||
          task.status !== "in_review" || state.status !== "pending" || state.currentStageId !== owner.stageId ||
          (state.changesRequestedCount ?? 0) !== owner.changesRequestedCount ||
          state.currentParticipant?.type !== "agent" || state.currentParticipant.agentId !== owner.agentId ||
          task.assigneeAgentId !== owner.agentId || task.checkoutRunId || task.executionRunId) continue;
      const [delivered] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, task.companyId), eq(agentWakeupRequests.agentId, owner.agentId),
        eq(agentWakeupRequests.idempotencyKey, owner.idempotencyKey))).limit(1);
      if (delivered) continue;
      if (await getExecutionBlocker(db, task.companyId, task.id, { admittingAgentId: owner.agentId })) continue;
      const stageWake = buildPendingStageParticipantWakeup(task.id, state);
      if (!stageWake || stageWake.agentId !== owner.agentId) continue;
      const run = await wake(owner.agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: stageWake.reason,
        payload: stageWake.payload,
        idempotencyKey: owner.idempotencyKey,
        requestedByActorType: "system",
        requestedByActorId: "execution-recovery",
        contextSnapshot: stageWake.contextSnapshot,
      });
      if (run) {
        await db.update(issueRecoveryActions).set({
          evidence: sql`${issueRecoveryActions.evidence} || ${JSON.stringify({ continuationRunId: run.id })}::jsonb`,
        }).where(and(eq(issueRecoveryActions.companyId, entry.companyId), eq(issueRecoveryActions.id, entry.actionId),
          sql`not (${issueRecoveryActions.evidence} ? 'continuationRunId')`));
      }
    } catch (err) {
      logger.warn({ err, recoveryActionId: entry.actionId }, "Stage continuation after automatic hold settlement remains pending");
    }
  }
}
