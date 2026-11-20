import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import type { ExecutionReconciliation } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import {
  deliverReconciledExecutions,
  markExecutionReconciliation,
  validateExecutionReconciliation,
} from "./execution-recovery-resolution.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

// A reviewer's changes-requested verdict reassigned the task to its executor
// and cancelled the reviewer's own legacy run as issue_reassigned; the run was
// then held for reconciliation with the reviewer as its return owner. The
// executor named as the review's return assignee must be able to continue.
const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("reviewer hand-back reconciliation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    if (external) db = createDb(external);
    else {
      database = await startEmbeddedPostgresTestDatabase("reviewer-hand-back-reconciliation-");
      db = createDb(database.connectionString);
    }
  }, 30_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed(options: {
    executionState?: (ids: { reviewerId: string; executorId: string; thirdId: string }) => Record<string, unknown>;
    issueStatus?: string;
    reviewParticipantAgentId?: (ids: { reviewerId: string; thirdId: string }) => string | undefined;
  } = {}) {
    const companyId = randomUUID(), reviewerId = randomUUID(), executorId = randomUUID(), thirdId = randomUUID();
    const issueId = randomUUID(), sourceRunId = randomUUID(), actionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Hand-back", issuePrefix: `H${companyId.slice(0, 6)}` });
    await db.insert(agents).values([
      { id: reviewerId, companyId, name: "Reviewer", role: "ceo", adapterType: "hermes_gateway" },
      { id: executorId, companyId, name: "Executor", role: "engineer", adapterType: "claude_local" },
      { id: thirdId, companyId, name: "Other", role: "engineer", adapterType: "claude_local" },
    ]);
    const ids = { reviewerId, executorId, thirdId };
    const reviewStageId = randomUUID();
    // The live BLA-1039 policy shape: one review stage held by the reviewer, two rounds.
    const executionPolicy = { mode: "normal", commentRequired: true, maxReviewRounds: 2,
      stages: [{ id: reviewStageId, type: "review", approvalsNeeded: 1,
        participants: [{ type: "agent", agentId: reviewerId }] }] };
    const executionState = options.executionState?.(ids) ?? {
      status: "changes_requested", monitor: null, reviewRequest: null, currentStageId: reviewStageId,
      lastDecisionId: randomUUID(), returnAssignee: { type: "agent", userId: null, agentId: executorId },
      currentStageType: "review", completedStageIds: [], currentStageIndex: 0,
      currentParticipant: { type: "agent", userId: null, agentId: reviewerId },
      lastDecisionOutcome: "changes_requested", changesRequestedCount: 1,
    };
    await db.insert(issues).values({ id: issueId, companyId, title: "Reviewed task", status: options.issueStatus ?? "blocked",
      assigneeAgentId: executorId, executionPolicy, executionState });
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId: reviewerId, runtimeMode: "legacy",
      status: "cancelled", errorCode: "issue_reassigned", error: "Cancelled before issue reassignment",
      contextSnapshot: { issueId }, startedAt: new Date("2000-01-01T00:00:00Z"), finishedAt: new Date("2000-01-01T00:01:00Z"),
      resultJson: { reassignmentStopConfirmed: true } });
    const reviewParticipantAgentId = options.reviewParticipantAgentId
      ? options.reviewParticipantAgentId({ reviewerId, thirdId }) : reviewerId;
    await db.insert(issueRecoveryActions).values({ id: actionId, companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation",
      fingerprint: `legacy-execution:${sourceRunId}`, status: "resolved", outcome: "blocked", returnOwnerAgentId: reviewerId,
      nextAction: "Reconcile the reviewer's cancelled run before continuing.",
      evidence: { runId: sourceRunId, attempt: 1, originalFailureCode: "issue_reassigned",
        ...(reviewParticipantAgentId ? { reviewParticipantAgentId } : {}), automaticRecovery: { replay: "blocked" } },
    });
    const decision: ExecutionReconciliation = { runId: sourceRunId, providerStopped: true, actionOutcome: "completed",
      outcomeEvidence: "The reviewer's verdict comment was posted; the reassignment stopped its run before any other action." };
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, actionId));
    return { companyId, issueId, sourceRunId, actionId, decision, action: action!, executionState, ...ids };
  }

  function validate(f: Awaited<ReturnType<typeof seed>>, admission?: { continuationAgentId?: string }, agentId = f.executorId) {
    return validateExecutionReconciliation({ db, companyId: f.companyId, issueId: f.issueId, agentId,
      sourceRunId: f.sourceRunId, decision: f.decision, recoveryAction: f.action, admission });
  }

  it("admits the return assignee, records the continuation agent and delivers to it without touching the review", async () => {
    const f = await seed();
    const admission: { continuationAgentId?: string } = {};
    await expect(validate(f, admission)).resolves.toMatchObject({ id: f.sourceRunId });
    expect(admission.continuationAgentId).toBe(f.executorId);
    await markExecutionReconciliation(db, f.action, f.decision, "board", undefined,
      { continuationAgentId: admission.continuationAgentId });
    const [marked] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId));
    expect(marked).toMatchObject({ returnOwnerAgentId: f.reviewerId,
      evidence: { runId: f.sourceRunId, reviewParticipantAgentId: f.reviewerId, continuationAgentId: f.executorId,
        continuationDelivery: "pending", executionReconciliation: { runId: f.sourceRunId, actorId: "board" } } });
    // The route resolves the hold as restored in the same transaction.
    await db.update(issueRecoveryActions).set({ status: "resolved", outcome: "restored" }).where(eq(issueRecoveryActions.id, f.actionId));
    const continuationRunId = randomUUID();
    const wake = vi.fn(async () => ({ id: continuationRunId }) as never);
    await deliverReconciledExecutions(db, wake);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith(f.executorId, expect.objectContaining({ reason: "issue_recovery_action_restored",
      contextSnapshot: expect.objectContaining({ retryOfRunId: f.sourceRunId, previousRunId: f.sourceRunId }) }));
    const [delivered] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId));
    expect(delivered.evidence).toMatchObject({ continuationDelivery: "delivered", continuationRunId,
      reviewParticipantAgentId: f.reviewerId, runId: f.sourceRunId });
    expect(delivered.returnOwnerAgentId).toBe(f.reviewerId);
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(task.executionState).toEqual(f.executionState);
    expect(task.assigneeAgentId).toBe(f.executorId);
  });

  it("keeps rejecting the hand-back source when the recovery action is not supplied", async () => {
    const f = await seed();
    await expect(validateExecutionReconciliation({ db, companyId: f.companyId, issueId: f.issueId, agentId: f.executorId,
      sourceRunId: f.sourceRunId, decision: f.decision })).rejects.toThrow("source or task owner changed");
  });

  it.each([
    ["an in_review pending review whose current participant is someone else", {
      issueStatus: "in_review",
      executionState: ({ executorId, thirdId }: { executorId: string; thirdId: string }) => ({
        status: "pending", currentStageId: randomUUID(), currentStageIndex: 0, currentStageType: "review",
        currentParticipant: { type: "agent", userId: null, agentId: thirdId },
        returnAssignee: { type: "agent", userId: null, agentId: executorId }, reviewRequest: null,
        completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null }) }],
    ["an approved outcome", {
      executionState: ({ reviewerId, executorId }: { reviewerId: string; executorId: string }) => ({
        status: "changes_requested", currentStageId: randomUUID(), currentStageIndex: 0, currentStageType: "review",
        currentParticipant: { type: "agent", userId: null, agentId: reviewerId },
        returnAssignee: { type: "agent", userId: null, agentId: executorId }, reviewRequest: null,
        completedStageIds: [], lastDecisionId: randomUUID(), lastDecisionOutcome: "approved" }) }],
    ["a return assignee other than the assignee", {
      executionState: ({ reviewerId, thirdId }: { reviewerId: string; thirdId: string }) => ({
        status: "changes_requested", currentStageId: randomUUID(), currentStageIndex: 0, currentStageType: "review",
        currentParticipant: { type: "agent", userId: null, agentId: reviewerId },
        returnAssignee: { type: "agent", userId: null, agentId: thirdId }, reviewRequest: null,
        completedStageIds: [], lastDecisionId: randomUUID(), lastDecisionOutcome: "changes_requested" }) }],
    ["a missing reviewParticipantAgentId", { reviewParticipantAgentId: () => undefined }],
    ["a reviewParticipantAgentId that is not the source run's agent", {
      reviewParticipantAgentId: ({ thirdId }: { thirdId: string }) => thirdId }],
    ["a done task", { issueStatus: "done" }],
  ] as const)("rejects %s", async (_label, options) => {
    const f = await seed(options as Parameters<typeof seed>[0]);
    const admission: { continuationAgentId?: string } = {};
    await expect(validate(f, admission)).rejects.toThrow("source or task owner changed");
    expect(admission.continuationAgentId).toBeUndefined();
  });

  it("rejects a hand-back while the reviewer's provider is still running", async () => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ processPid: process.pid }).where(eq(heartbeatRuns.id, f.sourceRunId));
    await expect(validate(f)).rejects.toThrow("previous provider is still running");
  });

  it("invalidates the delivery when the assignee changed to a third agent after reconciliation", async () => {
    const f = await seed();
    const admission: { continuationAgentId?: string } = {};
    await validate(f, admission);
    await markExecutionReconciliation(db, f.action, f.decision, "board", undefined,
      { continuationAgentId: admission.continuationAgentId });
    await db.update(issueRecoveryActions).set({ outcome: "restored" }).where(eq(issueRecoveryActions.id, f.actionId));
    await db.update(issues).set({ assigneeAgentId: f.thirdId }).where(eq(issues.id, f.issueId));
    const wake = vi.fn(async () => ({ id: randomUUID() }) as never);
    await deliverReconciledExecutions(db, wake);
    expect(wake).not.toHaveBeenCalled();
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId));
    expect(action.evidence.continuationDelivery).toBe("invalidated");
  });

  function routeApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).actor = actor; next(); });
    app.use("/api", issueRoutes(db, {} as any, {}));
    app.use(errorHandler);
    return app;
  }

  function resolveBody(f: Awaited<ReturnType<typeof seed>>) {
    return { actionId: f.actionId, outcome: "restored", sourceIssueStatus: "todo",
      resolutionNote: "Reconcile the reviewer's cancelled verdict run.", executionReconciliation: f.decision };
  }

  it("rejects the hand-back reconciliation from a non-board actor, even the return assignee", async () => {
    const f = await seed();
    const app = routeApp({ type: "agent", agentId: f.executorId, companyId: f.companyId, runId: randomUUID(), source: "agent_jwt" });
    const res = await request(app).post(`/api/issues/${f.issueId}/recovery-actions/resolve`).send(resolveBody(f));
    expect(res.status).toBe(403);
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId));
    expect(action).toMatchObject({ status: "resolved", outcome: "blocked", returnOwnerAgentId: f.reviewerId });
    expect(action.evidence.executionReconciliation).toBeUndefined();
    expect(action.evidence.continuationAgentId).toBeUndefined();
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(task).toMatchObject({ status: "blocked", assigneeAgentId: f.executorId, executionState: f.executionState });
  });

  it("lets the board reconcile the hand-back through the resolve route and records the continuation agent", async () => {
    const f = await seed();
    const app = routeApp({ type: "board", userId: "board-user", source: "local_implicit", isInstanceAdmin: true });
    const res = await request(app).post(`/api/issues/${f.issueId}/recovery-actions/resolve`).send(resolveBody(f));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId));
    expect(action).toMatchObject({ status: "resolved", outcome: "restored", returnOwnerAgentId: f.reviewerId,
      evidence: { runId: f.sourceRunId, reviewParticipantAgentId: f.reviewerId, continuationAgentId: f.executorId,
        executionReconciliation: { runId: f.sourceRunId } } });
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(task.assigneeAgentId).toBe(f.executorId);
    expect(task.executionState).toMatchObject({ status: "changes_requested", lastDecisionOutcome: "changes_requested",
      lastDecisionId: f.executionState.lastDecisionId, changesRequestedCount: 1,
      currentParticipant: { type: "agent", agentId: f.reviewerId } });
  });
});
