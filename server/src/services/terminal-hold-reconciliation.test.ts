import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueExecutionDecisions,
  issueRecoveryActions,
  issues,
  issueThreadInteractions,
  issueTreeHolds,
  projects,
  toolInvocations,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { deliverReconciledExecutions, pendingStageRecoveryWakeKey, settleUnrecoverableExecutions } from "./execution-recovery-resolution.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { terminalizeLegacyExecution } from "./legacy-execution-recovery.js";
import {
  reconcileTerminalSourceHolds,
  TERMINAL_HOLD_RECHECK_MS,
  TERMINAL_HOLD_RECONCILIATION_ACTOR,
  TERMINAL_HOLD_RECONCILIATION_POLICY,
} from "./terminal-hold-reconciliation.js";

// A reviewer's verdict stops the reviewer's own legacy run before the task
// update commits, so the stop raises a no-replay hold against the pending
// stage. After the verdict is applied the hold blocks the next owner although
// nothing of the stopped run is to be repeated. All data here is synthetic.
const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("terminal-source hold reconciliation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    if (external) db = createDb(external);
    else {
      database = await startEmbeddedPostgresTestDatabase("terminal-hold-reconciliation-");
      db = createDb(database.connectionString);
    }
  }, 240_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  const later = (ms = TERMINAL_HOLD_RECHECK_MS + 1_000) => new Date(Date.now() + ms);

  /**
   * Build the real sequence: a pending stage held by the reviewer, the
   * reviewer's run stopped for its own verdict (raising the hold through the
   * production terminal path), then the committed verdict.
   */
  async function seed(options: {
    verdict?: "changes_requested" | "approved" | "none";
    returnAssigneeUser?: boolean;
  } = {}) {
    const verdict = options.verdict ?? "changes_requested";
    const companyId = randomUUID(), reviewerId = randomUUID(), executorId = randomUUID(), approverId = randomUUID();
    const issueId = randomUUID(), runId = randomUUID(), otherIssueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Hold", issuePrefix: `T${companyId.slice(0, 6)}` });
    await db.insert(agents).values([
      { id: reviewerId, companyId, name: "Reviewer", role: "engineer", adapterType: "claude_local" },
      { id: executorId, companyId, name: "Executor", role: "engineer", adapterType: "claude_local" },
      { id: approverId, companyId, name: "Approver", role: "engineer", adapterType: "claude_local" },
    ]);
    const reviewStageId = randomUUID(), approvalStageId = randomUUID();
    const executionPolicy = { mode: "normal", commentRequired: true, stages: [
      { id: reviewStageId, type: "review", approvalsNeeded: 1, participants: [{ type: "agent", agentId: reviewerId }] },
      { id: approvalStageId, type: "approval", approvalsNeeded: 1, participants: [{ type: "agent", agentId: approverId }] },
    ] };
    const pendingReview = {
      status: "pending", monitor: null, reviewRequest: null, currentStageId: reviewStageId, currentStageIndex: 0,
      currentStageType: "review", currentParticipant: { type: "agent", userId: null, agentId: reviewerId },
      returnAssignee: options.returnAssigneeUser ? { type: "user", userId: "user-1", agentId: null }
        : { type: "agent", userId: null, agentId: executorId },
      completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null, changesRequestedCount: 0,
    };
    await db.insert(issues).values([
      { id: issueId, companyId, title: "Reviewed task", status: "in_review", assigneeAgentId: reviewerId,
        executionPolicy, executionState: pendingReview },
      { id: otherIssueId, companyId, title: "Unrelated task", status: "todo" },
    ]);
    const [running] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: reviewerId,
      runtimeMode: "legacy", status: "running", contextSnapshot: { issueId },
      startedAt: new Date(Date.now() - 120_000) }).returning();
    // The reviewer posted its verdict comment from this run.
    await db.insert(issueComments).values({ companyId, issueId, authorType: "agent", authorAgentId: reviewerId,
      body: "Changes requested: fix the failing check.", createdByRunId: runId });
    await db.insert(activityLog).values([
      { companyId, actorType: "agent", actorId: reviewerId, agentId: reviewerId, runId, action: "issue.read_marked",
        entityType: "issue", entityId: issueId },
      { companyId, actorType: "agent", actorId: reviewerId, agentId: reviewerId, runId, action: "issue.comment_added",
        entityType: "issue", entityId: issueId },
    ]);
    // The mutation stops its own run first; this raises the production hold.
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const stopped = await terminalizeLegacyExecution({ db, run: running!, status: "cancelled", reconcileIfNeeded: true,
      fromStatuses: ["running"], patch: { errorCode: "issue_reassigned", error: "Cancelled before issue reassignment",
        finishedAt: new Date(), resultJson: { reassignmentStopConfirmed: true, issueMutationStopId: randomUUID() } } });
    expect(stopped?.status).toBe("cancelled");
    const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(hold).toMatchObject({ status: "active", cause: "legacy_execution_requires_reconciliation",
      returnOwnerAgentId: reviewerId, evidence: expect.objectContaining({ runId, reviewParticipantAgentId: reviewerId }) });

    let executionState: Record<string, unknown> = pendingReview;
    let decisionId: string | null = null;
    if (verdict !== "none") {
      const [decision] = await db.insert(issueExecutionDecisions).values({ companyId, issueId, stageId: reviewStageId,
        stageType: "review", actorAgentId: reviewerId, outcome: verdict, body: "Verdict", createdByRunId: runId }).returning();
      decisionId = decision!.id;
      executionState = verdict === "changes_requested" ? {
        ...pendingReview, status: "changes_requested", lastDecisionId: decisionId,
        lastDecisionOutcome: "changes_requested", changesRequestedCount: 1,
      } : {
        ...pendingReview, currentStageId: approvalStageId, currentStageIndex: 1, currentStageType: "approval",
        currentParticipant: { type: "agent", userId: null, agentId: approverId }, completedStageIds: [reviewStageId],
        lastDecisionId: decisionId, lastDecisionOutcome: "approved",
      };
      const assigneeAgentId = verdict === "approved" ? approverId
        : options.returnAssigneeUser ? null : executorId;
      await db.update(issues).set({ executionState, assigneeAgentId,
        assigneeUserId: options.returnAssigneeUser ? "user-1" : null,
        status: verdict === "approved" ? "in_review" : "in_progress" }).where(eq(issues.id, issueId));
    }
    return { companyId, reviewerId, executorId, approverId, issueId, runId, otherIssueId, holdId: hold!.id,
      decisionId, executionState, reviewStageId, approvalStageId };
  }

  async function hold(id: string) {
    return (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, id)))[0]!;
  }
  async function task(id: string) {
    return (await db.select().from(issues).where(eq(issues.id, id)))[0]!;
  }
  // The sweep is global: count only the wakes for this fixture's task.
  type WakeMock = { mock: { calls: unknown[][] } };
  const wakesFor = (wake: WakeMock, issueId: string) => wake.mock.calls.filter((call) => {
    const opts = call[1] as { payload?: { issueId?: string } } | undefined;
    return opts?.payload?.issueId === issueId;
  });
  const keptReason = async (id: string) =>
    ((await hold(id)).evidence.automaticReconciliationReview as { reason?: string } | undefined)?.reason;

  it("settles a verdict-only hand-back once and continues once to the return executor", async () => {
    const f = await seed();
    // The hold blocks the executor before settlement.
    expect(await getExecutionBlocker(db, f.companyId, f.issueId, { admittingAgentId: f.executorId })).not.toBeNull();
    const before = await task(f.issueId);
    const wake = vi.fn(async () => ({ id: randomUUID() }) as never);

    await reconcileTerminalSourceHolds(db, wake, later());
    const settled = await hold(f.holdId);
    expect(settled).toMatchObject({ status: "resolved", outcome: "restored", returnOwnerAgentId: f.reviewerId });
    expect(settled.evidence).toMatchObject({
      runId: f.runId, reviewParticipantAgentId: f.reviewerId, originalFailureCode: "issue_reassigned",
      continuationAgentId: f.executorId, continuationDelivery: "pending",
      executionReconciliation: { runId: f.runId, providerStopped: true, actorId: TERMINAL_HOLD_RECONCILIATION_ACTOR },
      automaticReconciliation: { policy: TERMINAL_HOLD_RECONCILIATION_POLICY, outcome: "settled",
        basis: "changes_requested_hand_back", sourceRunId: f.runId, decisionId: f.decisionId,
        continuationAgentId: f.executorId, previousStatus: "active", externalEffects: "not_observable",
        recordedEffects: { comments: 1, agentActivity: 2, toolInvocations: 0 } },
    });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId, { admittingAgentId: f.executorId })).toBeNull();

    await deliverReconciledExecutions(db, wake);
    await reconcileTerminalSourceHolds(db, wake, later(3 * TERMINAL_HOLD_RECHECK_MS));
    await deliverReconciledExecutions(db, wake);
    expect(wakesFor(wake, f.issueId)).toHaveLength(1);
    expect(wake).toHaveBeenCalledWith(f.executorId, expect.objectContaining({
      reason: "issue_recovery_action_restored", idempotencyKey: `execution-reconciliation:${f.holdId}`,
      contextSnapshot: expect.objectContaining({ previousRunId: f.runId, retryOfRunId: f.runId }) }));
    expect((await hold(f.holdId)).evidence).toMatchObject({ continuationDelivery: "delivered" });

    // Stage, verdict and counters are untouched.
    const after = await task(f.issueId);
    expect(after.executionState).toEqual(before.executionState);
    expect(after).toMatchObject({ status: before.status, assigneeAgentId: f.executorId });
    expect(after.executionState).toMatchObject({ changesRequestedCount: 1, lastDecisionId: f.decisionId,
      lastDecisionOutcome: "changes_requested" });
    const decisions = await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, f.issueId));
    expect(decisions).toEqual([expect.objectContaining({ id: f.decisionId, outcome: "changes_requested", createdByRunId: f.runId })]);
    const [audit] = await db.select().from(activityLog).where(eq(activityLog.entityId, f.issueId))
      .then((rows) => rows.filter((row) => row.action === "issue.recovery_action_resolved"));
    expect(audit).toMatchObject({ actorType: "system", runId: f.runId,
      details: expect.objectContaining({ recoveryActionId: f.holdId, outcome: "restored" }) });
  });

  it("settles a hold the disposition sweep already closed without replay", async () => {
    const f = await seed();
    await settleUnrecoverableExecutions(db);
    expect((await hold(f.holdId)).evidence).toMatchObject({ automaticRecovery: { replay: "blocked" } });
    const wake = vi.fn(async () => ({ id: randomUUID() }) as never);
    await reconcileTerminalSourceHolds(db, wake, later());
    const settled = await hold(f.holdId);
    expect(settled).toMatchObject({ status: "resolved", outcome: "restored" });
    expect(settled.evidence.automaticRecovery).toBeUndefined();
    expect(settled.evidence).toMatchObject({ automaticReconciliation: {
      previousAutomaticRecovery: { policy: "preserve_without_replay_v1", replay: "blocked" } } });
    await deliverReconciledExecutions(db, wake);
    expect(wakesFor(wake, f.issueId)).toHaveLength(1);
    expect(wake).toHaveBeenCalledWith(f.executorId, expect.anything());
  });

  it("delivers an approved advance as one stage wake for the next participant", async () => {
    const f = await seed({ verdict: "approved" });
    const wake = vi.fn(async () => ({ id: randomUUID() }) as never);
    await reconcileTerminalSourceHolds(db, wake, later());
    const key = pendingStageRecoveryWakeKey(f.issueId, { stageId: f.approvalStageId, changesRequestedCount: 0 });
    expect(wakesFor(wake, f.issueId)).toHaveLength(1);
    expect(wake).toHaveBeenCalledWith(f.approverId, expect.objectContaining({
      reason: "execution_approval_requested", idempotencyKey: key }));
    expect((await hold(f.holdId)).evidence).toMatchObject({ continuationDelivery: "delegated",
      continuationDeliveryOwner: { kind: "pending_stage_participant", agentId: f.approverId, idempotencyKey: key },
      automaticReconciliation: { basis: "approved_stage_advance" } });
    await reconcileTerminalSourceHolds(db, wake, later(3 * TERMINAL_HOLD_RECHECK_MS));
    await deliverReconciledExecutions(db, wake);
    expect(wakesFor(wake, f.issueId)).toHaveLength(1);
    expect((await task(f.issueId)).executionState).toEqual(f.executionState);
  });

  it.each([
    ["a comment on another task", "unaccounted_effects", async (f: Awaited<ReturnType<typeof seed>>) => {
      await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.otherIssueId, authorType: "agent",
        authorAgentId: f.reviewerId, body: "Side note", createdByRunId: f.runId });
    }],
    ["activity outside the verdict", "unaccounted_effects", async (f: Awaited<ReturnType<typeof seed>>) => {
      await db.insert(activityLog).values({ companyId: f.companyId, actorType: "agent", actorId: f.reviewerId,
        runId: f.runId, action: "issue.child_created", entityType: "issue", entityId: f.issueId });
    }],
    ["a gateway tool call", "unaccounted_effects", async (f: Awaited<ReturnType<typeof seed>>) => {
      await db.insert(toolInvocations).values({ companyId: f.companyId, runId: f.runId, issueId: f.issueId,
        toolName: "external_write" });
    }],
    ["a source run that is not terminal", "not_verdict_stop", async (f: Awaited<ReturnType<typeof seed>>) => {
      await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, f.runId));
    }],
    ["a provider process that is still alive", "source_unverified", async (f: Awaited<ReturnType<typeof seed>>) => {
      await db.update(heartbeatRuns).set({ processPid: process.pid }).where(eq(heartbeatRuns.id, f.runId));
    }],
    ["a live execution on the task", "live_execution", async (f: Awaited<ReturnType<typeof seed>>) => {
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.executorId, runtimeMode: "legacy",
        status: "running", contextSnapshot: { issueId: f.issueId } });
    }],
    ["a competing active recovery", "competing_recovery", async (f: Awaited<ReturnType<typeof seed>>) => {
      // The two-record case: the hold was settled without replay, then a separate stranded-owner recovery opened.
      await settleUnrecoverableExecutions(db);
      await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
        kind: "stranded_assigned_issue", cause: "stranded_assigned_issue", fingerprint: `stranded:${randomUUID()}`,
        status: "active", ownerType: "board", returnOwnerAgentId: f.executorId, evidence: {}, nextAction: "Board decides." });
    }],
    ["a pending human question", "interaction_pending", async (f: Awaited<ReturnType<typeof seed>>) => {
      await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId,
        kind: "request_confirmation", status: "pending", continuationPolicy: "wake_assignee_on_accept",
        payload: { version: 1, prompt: "Proceed?" } });
    }],
    ["a subtree pause hold", "pause_hold", async (f: Awaited<ReturnType<typeof seed>>) => {
      await db.insert(issueTreeHolds).values({ companyId: f.companyId, rootIssueId: f.issueId, mode: "pause",
        status: "active", createdByActorType: "user", createdByUserId: "user-1",
        releasePolicy: { strategy: "manual", note: "pause" } });
    }],
    ["a paused project", "project_paused", async (f: Awaited<ReturnType<typeof seed>>) => {
      const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Paused",
        pausedAt: new Date() }).returning();
      await db.update(issues).set({ projectId: project!.id }).where(eq(issues.id, f.issueId));
    }],
    ["a paused continuation agent", "continuation_agent_unavailable", async (f: Awaited<ReturnType<typeof seed>>) => {
      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.executorId));
    }],
    ["a task the board blocked", "task_blocked", async (f: Awaited<ReturnType<typeof seed>>) => {
      await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, f.issueId));
    }],
    ["a later review round", "verdict_not_applied", async (f: Awaited<ReturnType<typeof seed>>) => {
      await db.insert(issueExecutionDecisions).values({ companyId: f.companyId, issueId: f.issueId,
        stageId: f.reviewStageId, stageType: "review", actorUserId: "user-1", outcome: "changes_requested",
        body: "Human verdict", createdAt: new Date(Date.now() + 1_000) });
    }],
  ] as const)("keeps the hold for %s and records why", async (_label, reason, mutate) => {
    const f = await seed();
    await mutate(f);
    const wake = vi.fn(async () => ({ id: randomUUID() }) as never);
    await reconcileTerminalSourceHolds(db, wake, later());
    await deliverReconciledExecutions(db, wake);
    expect(wakesFor(wake, f.issueId)).toHaveLength(0);
    const kept = await hold(f.holdId);
    expect(kept.evidence.executionReconciliation).toBeUndefined();
    expect(kept.status === "active" || (kept.evidence.automaticRecovery as { replay?: string })?.replay === "blocked").toBe(true);
    expect(await keptReason(f.holdId)).toBe(reason);
    expect((await task(f.issueId)).executionState).toEqual(f.executionState);
  });

  it("keeps the hold while the verdict is not applied", async () => {
    const f = await seed({ verdict: "none" });
    const wake = vi.fn(async () => ({ id: randomUUID() }) as never);
    await reconcileTerminalSourceHolds(db, wake, later());
    expect(await keptReason(f.holdId)).toBe("verdict_not_applied");
    expect((await hold(f.holdId)).status).toBe("active");
    expect(wakesFor(wake, f.issueId)).toHaveLength(0);
  });

  it("keeps the hold when the return assignee is a person", async () => {
    const f = await seed({ returnAssigneeUser: true });
    await reconcileTerminalSourceHolds(db, null, later());
    expect(await keptReason(f.holdId)).toBe("human_return_assignee");
  });

  it("re-checks a kept hold later and settles it once the competing recovery is resolved", async () => {
    const f = await seed();
    await settleUnrecoverableExecutions(db);
    const [competing] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "stranded_assigned_issue", cause: "stranded_assigned_issue", fingerprint: `stranded:${randomUUID()}`,
      status: "active", ownerType: "board", returnOwnerAgentId: f.executorId, evidence: {}, nextAction: "Board decides." }).returning();
    const first = later();
    await reconcileTerminalSourceHolds(db, null, first);
    expect(await keptReason(f.holdId)).toBe("competing_recovery");
    await db.update(issueRecoveryActions).set({ status: "resolved", outcome: "cancelled" })
      .where(eq(issueRecoveryActions.id, competing!.id));
    // Not due yet: no re-check inside the window.
    await reconcileTerminalSourceHolds(db, null, new Date(first.getTime() + 1_000));
    expect((await hold(f.holdId)).evidence.executionReconciliation).toBeUndefined();
    await reconcileTerminalSourceHolds(db, null, new Date(first.getTime() + TERMINAL_HOLD_RECHECK_MS + 1_000));
    expect((await hold(f.holdId)).evidence).toMatchObject({ automaticReconciliation: { outcome: "settled" } });
  });

  it("does not wake when the review moved on between settlement and delivery", async () => {
    const f = await seed();
    await reconcileTerminalSourceHolds(db, null, later());
    expect((await hold(f.holdId)).evidence).toMatchObject({ continuationDelivery: "pending" });
    await db.update(issues).set({ executionState: { ...f.executionState, lastDecisionId: randomUUID() } })
      .where(eq(issues.id, f.issueId));
    const wake = vi.fn(async () => ({ id: randomUUID() }) as never);
    await deliverReconciledExecutions(db, wake);
    expect(wakesFor(wake, f.issueId)).toHaveLength(0);
    expect((await hold(f.holdId)).evidence).toMatchObject({ continuationDelivery: "invalidated" });
  });

  it("leaves holds that do not name a reviewer source untouched", async () => {
    const f = await seed();
    await db.update(issueRecoveryActions).set({ evidence: { runId: f.runId, attempt: 1 } })
      .where(eq(issueRecoveryActions.id, f.holdId));
    await reconcileTerminalSourceHolds(db, null, later());
    const untouched = await hold(f.holdId);
    expect(untouched.evidence).toEqual({ runId: f.runId, attempt: 1 });
    expect(untouched.status).toBe("active");
  });

  it("two-record case: the board resolves the stranded recovery, then the verdict hold settles with one continuation", async () => {
    const f = await seed();
    await settleUnrecoverableExecutions(db);
    // The executor's stranding opened a separate board-owned recovery and blocked the task.
    const [stranded] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "stranded_assigned_issue", cause: "stranded_assigned_issue", fingerprint: `stranded:${randomUUID()}`,
      status: "active", ownerType: "board", previousOwnerAgentId: f.executorId, returnOwnerAgentId: f.executorId,
      evidence: { routingPolicy: "board_escalation_no_takeover_v1" }, nextAction: "Board decides." }).returning();
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, f.issueId));
    const routeWake = vi.fn(async () => ({ id: randomUUID() }) as never);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", userId: "board-user", source: "local_implicit", isInstanceAdmin: true };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, { recoveryActionEnqueueWakeup: routeWake }));
    app.use(errorHandler);
    const decision = { runId: f.runId, providerStopped: true, actionOutcome: "completed",
      outcomeEvidence: "The reviewer's verdict was applied; the stop ended its run." };

    // The settled hold cannot be reopened while the other recovery is active.
    const refused = await request(app).post(`/api/issues/${f.issueId}/recovery-actions/resolve`).send({
      actionId: f.holdId, outcome: "restored", sourceIssueStatus: "todo", executionReconciliation: decision });
    expect(refused.status).toBe(409);
    expect((await hold(f.holdId)).evidence.executionReconciliation).toBeUndefined();
    // The sweep keeps it too, and says why (the stranding blocked the task).
    await reconcileTerminalSourceHolds(db, null, later());
    expect(await keptReason(f.holdId)).toBe("task_blocked");

    // Supported step 1: restore the stranded recovery to the executor. Its hand-back wake cannot start past the hold.
    const restored = await request(app).post(`/api/issues/${f.issueId}/recovery-actions/resolve`).send({
      actionId: stranded!.id, outcome: "restored", sourceIssueStatus: "todo",
      resolutionNote: "The stranding came from the reviewer's verdict hold." });
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect((await task(f.issueId)).status).toBe("todo");
    // The route asks for its usual hand-back wake. With the hold still effective, wake
    // admission records it as a skipped execution wait, so it starts nothing.
    expect(routeWake).toHaveBeenCalledTimes(1);
    expect(routeWake).toHaveBeenCalledWith(f.executorId, expect.objectContaining({ reason: "issue_recovery_action_restored" }));
    expect(await getExecutionBlocker(db, f.companyId, f.issueId, { admittingAgentId: f.executorId })).not.toBeNull();

    // Step 2 is automatic: the next due sweep settles the verdict hold and continues once.
    const wake = vi.fn(async () => ({ id: randomUUID() }) as never);
    await reconcileTerminalSourceHolds(db, wake, later(3 * TERMINAL_HOLD_RECHECK_MS));
    await deliverReconciledExecutions(db, wake);
    expect((await hold(f.holdId)).evidence).toMatchObject({ automaticReconciliation: { outcome: "settled" },
      continuationDelivery: "delivered" });
    expect(wakesFor(wake, f.issueId)).toHaveLength(1);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId, { admittingAgentId: f.executorId })).toBeNull();
    expect((await task(f.issueId)).executionState).toEqual(f.executionState);
  });
});
