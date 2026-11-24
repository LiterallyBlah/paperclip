import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issueRelations,
  issues,
} from "@paperclipai/db";
import type { ExecutionReconciliation } from "@paperclipai/shared";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { deliverReconciledExecutions } from "../services/execution-recovery-resolution.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0, signal: null, timedOut: false, errorMessage: null,
    summary: "Record-only settlement test run.", provider: "test", model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })),
  };
});

// BLA-4737. Synthetic fixtures shaped like the live holds: a retained,
// resolved `preserve_without_replay_v1` hold (outcome `blocked`, replay
// `blocked`) on (a) a `done` task whose legacy source run was interrupted by
// shutdown (BLA-4442) and (b) a `blocked` task with no stages, waiting on an
// unresolved child, whose source run failed (BLA-1055). The board records the
// reconciliation; nothing else changes and nothing is woken.
const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("record-only settlement of retained no-replay holds (BLA-4737)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    if (external) db = createDb(external);
    else {
      database = await startEmbeddedPostgresTestDatabase("record-only-no-replay-");
      db = createDb(database.connectionString);
    }
  }, 30_000);
  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    mockAdapterExecute.mockClear();
  });
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  type Shape = "done" | "cancelled" | "blocked" | "blocked_stage";
  async function seed(shape: Shape) {
    const companyId = randomUUID(), ownerId = randomUUID(), reviewerId = randomUUID();
    const issueId = randomUUID(), childId = randomUUID(), sourceRunId = randomUUID(), holdId = randomUUID();
    const stageId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Record-only settlement", issuePrefix: `R${companyId.slice(0, 6)}`,
      requireBoardApprovalForNewAgents: false });
    const agentRow = (id: string, name: string) => ({ id, companyId, name, role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true } },
      permissions: { canCreateAgents: false, canAssignTasks: true } });
    await db.insert(agents).values([agentRow(ownerId, "Owner"), agentRow(reviewerId, "Reviewer")]);
    const ownerUserId = `owner-${companyId}`;
    await db.insert(authUsers).values({ id: ownerUserId, name: ownerUserId, email: `${ownerUserId}@example.test`,
      createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: ownerUserId,
      status: "active", membershipRole: "owner" });
    const ref = (agentId: string) => ({ type: "agent", agentId, userId: null });
    const status = shape === "blocked_stage" ? "blocked" : shape;
    const executionPolicy = shape === "blocked_stage"
      ? { mode: "normal", commentRequired: true, maxReviewRounds: 2, stages: [
        { id: stageId, type: "review", approvalsNeeded: 1, participants: [{ id: randomUUID(), ...ref(ownerId) }] }] }
      : null;
    const executionState = shape === "blocked_stage"
      ? { status: "pending", currentStageId: stageId, currentStageIndex: 0, currentStageType: "review",
        currentParticipant: ref(ownerId), returnAssignee: ref(reviewerId), reviewRequest: null,
        completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null, monitor: null, changesRequestedCount: 0 }
      : null;
    await db.insert(issues).values({ id: issueId, companyId, title: `Retained hold on ${shape}`, status, priority: "high",
      assigneeAgentId: ownerId, executionPolicy, executionState, statusVersion: 7, unblockDescriptor: null,
      ...(status === "done" ? { completedAt: new Date("2000-01-01T00:03:00Z") } : {}),
      ...(status === "cancelled" ? { cancelledAt: new Date("2000-01-01T00:03:00Z") } : {}) });
    if (status === "blocked") {
      await db.insert(issues).values({ id: childId, companyId, title: "Unresolved child", status: "todo", priority: "high",
        parentId: issueId });
      await db.insert(issueRelations).values({ companyId, issueId: childId, relatedIssueId: issueId, type: "blocks" });
    }
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId: ownerId, runtimeMode: "legacy",
      status: shape === "done" ? "interrupted" : "failed", errorCode: shape === "done" ? "process_lost" : "adapter_failed",
      invocationSource: "assignment", triggerDetail: "system", contextSnapshot: { issueId },
      startedAt: new Date("2000-01-01T00:00:00Z"), finishedAt: new Date("2000-01-01T00:01:00Z") });
    const automaticRecovery = { policy: "preserve_without_replay_v1", runId: sourceRunId, replay: "blocked",
      actionOutcome: "unknown", recordedAt: "2000-01-01T00:02:00.000Z" };
    await db.insert(issueRecoveryActions).values({ id: holdId, companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      cause: "legacy_execution_requires_reconciliation", fingerprint: `legacy-execution:${sourceRunId}`,
      status: "resolved", outcome: "blocked", ownerType: "board", returnOwnerAgentId: ownerId,
      nextAction: "Automatic recovery stopped.", resolvedAt: new Date("2000-01-01T00:02:00Z"),
      evidence: { runId: sourceRunId, attempt: 1, automaticRecovery } });
    const decision: ExecutionReconciliation = { runId: sourceRunId, providerStopped: true, actionOutcome: "mixed",
      outcomeEvidence: "Outcome unverified; the refusal is preserved and nothing was retried." };
    return { companyId, ownerId, issueId, childId, sourceRunId, holdId, decision, automaticRecovery, status };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;

  const board = { type: "board", userId: "board-user", source: "local_implicit", isInstanceAdmin: true };
  function app(actor: Record<string, unknown> = board) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => { (req as any).actor = actor; next(); });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use(errorHandler);
    return testApp;
  }
  const body = (f: Fixture) => f.status === "blocked"
    ? { actionId: f.holdId, outcome: "blocked", sourceIssueStatus: "blocked", executionReconciliation: f.decision }
    : { actionId: f.holdId, outcome: "restored", sourceIssueStatus: f.status, executionReconciliation: f.decision };
  const resolve = (f: Fixture, extra: Record<string, unknown> = {}, actor?: Record<string, unknown>) =>
    request(app(actor)).post(`/api/issues/${f.issueId}/recovery-actions/resolve`).send({ ...body(f), ...extra });

  async function snapshot(f: Fixture) {
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const holds = await db.select().from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, f.issueId)).orderBy(issueRecoveryActions.createdAt);
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    const runs = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
    const relations = await db.select().from(issueRelations).where(eq(issueRelations.companyId, f.companyId));
    return { task: task!, holds, wakes, runs, relations };
  }
  const taskFields = (task: Awaited<ReturnType<typeof snapshot>>["task"]) => JSON.stringify({
    status: task.status, statusVersion: task.statusVersion, assigneeAgentId: task.assigneeAgentId,
    executionPolicy: task.executionPolicy, executionState: task.executionState, unblockDescriptor: task.unblockDescriptor,
    checkoutRunId: task.checkoutRunId, executionRunId: task.executionRunId, completedAt: task.completedAt,
    cancelledAt: task.cancelledAt, updatedAt: task.updatedAt,
  });

  async function expectRecordOnly(shape: Shape) {
    const f = await seed(shape);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
    const before = await snapshot(f);

    const res = await resolve(f);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.recordOnly).toBe(true);

    const after = await snapshot(f);
    expect(taskFields(after.task)).toBe(taskFields(before.task));
    expect(after.task.status).toBe(f.status);
    expect(after.wakes).toHaveLength(0);
    expect(after.runs).toHaveLength(before.runs.length);
    expect(after.relations).toEqual(before.relations);
    expect(after.holds).toHaveLength(1);
    const [hold] = after.holds;
    // The action row keeps its settled status, outcome and resolution time.
    expect(hold).toMatchObject({ id: f.holdId, status: "resolved", outcome: "blocked",
      resolvedAt: before.holds[0]!.resolvedAt });
    expect(hold!.evidence.automaticRecovery).toBeUndefined();
    expect(hold!.evidence).toMatchObject({ runId: f.sourceRunId, continuationDelivery: "not_requested",
      previousAutomaticRecovery: f.automaticRecovery,
      executionReconciliation: { runId: f.sourceRunId, providerStopped: true, actionOutcome: "mixed", actorId: "board-user" } });
    expect(hold!.evidence.continuationDeliveryOwner).toBeUndefined();
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    const detail = await request(app()).get(`/api/issues/${f.issueId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.executionBlocker ?? null).toBeNull();

    // The generic reconciled-execution worker has nothing to deliver.
    const wake = vi.fn(async () => null);
    await deliverReconciledExecutions(db, wake as any);
    expect(wake).not.toHaveBeenCalled();

    const activity = await db.select().from(activityLog).where(sql`${activityLog.entityId} = ${f.issueId}
      and ${activityLog.action} = 'issue.recovery_action_resolved'`);
    expect(activity).toHaveLength(1);
    expect(activity[0]!.details).toMatchObject({ recordOnly: true, recoveryActionId: f.holdId,
      continuationDelivery: "not_requested", sourceIssueStatus: f.status });

    // A second call is a no-write replay: no wake, no reopening, no retry.
    const replay = await resolve(f);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.recordOnly).toBeUndefined();
    const final = await snapshot(f);
    expect(taskFields(final.task)).toBe(taskFields(before.task));
    expect(final.holds).toEqual(after.holds);
    expect(final.wakes).toHaveLength(0);
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    expect((await snapshot(f)).runs).toHaveLength(before.runs.length);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    return { f, before, after };
  }

  async function expectRefused(f: Fixture, extra: Record<string, unknown>, expected: { status?: number; code?: string },
    actor?: Record<string, unknown>) {
    const before = await snapshot(f);
    const res = await resolve(f, extra, actor);
    expect(res.status, JSON.stringify(res.body)).toBe(expected.status ?? 409);
    if (expected.code) expect(res.body.details?.code, JSON.stringify(res.body)).toBe(expected.code);
    const after = await snapshot(f);
    expect(taskFields(after.task)).toBe(taskFields(before.task));
    expect(after.holds).toEqual(before.holds);
    expect(after.wakes).toHaveLength(before.wakes.length);
    return res;
  }

  it("settles a done task's retained hold as a record only", async () => {
    await expectRecordOnly("done");
  });

  it("settles a cancelled task's retained hold as a record only", async () => {
    await expectRecordOnly("cancelled");
  });

  it("settles a stage-less blocked task's hold, keeping it blocked behind its child", async () => {
    const { f, after } = await expectRecordOnly("blocked");
    expect(after.task.status).toBe("blocked");
    expect(after.relations).toMatchObject([{ issueId: f.childId, relatedIssueId: f.issueId, type: "blocks" }]);
    const [child] = await db.select().from(issues).where(eq(issues.id, f.childId));
    expect(child!.status).toBe("todo");
  });

  it("leaves a blocked task with a pending agent stage on the existing stage path", async () => {
    const f = await seed("blocked_stage");
    // `blocked` outcome on a pending stage: the stage path refuses, unchanged.
    await expectRefused(f, {}, { code: "stage_recovery_outcome_invalid" });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
  });

  it("never replays the source run's own wake and offers no retry", async () => {
    const f = await seed("done");
    expect((await resolve(f)).status).toBe(200);
    // A todo restore after the record-only settlement is not a replay route.
    const retry = await request(app()).post(`/api/issues/${f.issueId}/recovery-actions/resolve`).send({
      actionId: f.holdId, outcome: "restored", sourceIssueStatus: "todo", executionReconciliation: f.decision });
    expect(retry.status).toBe(200);
    const after = await snapshot(f);
    expect(after.task.status).toBe("done");
    expect(after.holds[0]).toMatchObject({ status: "resolved", outcome: "blocked" });
    expect(after.holds[0]!.evidence.continuationDelivery).toBe("not_requested");
    expect(after.wakes).toHaveLength(0);
    expect(after.runs).toHaveLength(1);
  });

  it("refuses a non-board actor", async () => {
    const f = await seed("done");
    await expectRefused(f, {}, { status: 403 },
      { type: "agent", agentId: f.ownerId, companyId: f.companyId, runId: randomUUID(), source: "agent_jwt" });
  });

  it("refuses while a competing recovery action is active", async () => {
    const f = await seed("done");
    const competingId = randomUUID();
    await db.insert(issueRecoveryActions).values({ id: competingId, companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", fingerprint: `legacy-execution:${randomUUID()}`,
      status: "active", ownerType: "board", returnOwnerAgentId: f.ownerId, nextAction: "Inspect.",
      evidence: { runId: randomUUID(), attempt: 1 } });
    await expectRefused(f, {}, { code: "recovery_record_only_competing_action" });
  });

  it("refuses a status that is not the stored status, or a mismatched source run", async () => {
    const f = await seed("done");
    await expectRefused(f, { sourceIssueStatus: "cancelled" }, {});
    await expectRefused(f, { executionReconciliation: { ...f.decision, runId: randomUUID() } }, {});
  });
});
