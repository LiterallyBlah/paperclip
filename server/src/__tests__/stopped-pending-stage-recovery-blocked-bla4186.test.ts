import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueExecutionDecisions,
  issueRecoveryActions,
  issueRelations,
  issues,
} from "@paperclipai/db";
import type { ExecutionReconciliation } from "@paperclipai/shared";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0, signal: null, timedOut: false, errorMessage: null,
    summary: "Stopped stage recovery test run.", provider: "test", model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })),
  };
});

// BLA-4186. Synthetic fixture shaped like BLA-3978: two review stages, the
// first completed, the second pending on the review-cap escalation holder (an
// agent), who is also the assignee and the hold's return owner. That agent's
// legacy source run was cancelled (issue_reassigned), and the automatic
// no-replay settlement of its hold moved the task from in_review to blocked.
const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("stopped pending stage recovery of a settlement-blocked task (BLA-4186)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    if (external) db = createDb(external);
    else {
      database = await startEmbeddedPostgresTestDatabase("stopped-stage-blocked-recovery-");
      db = createDb(database.connectionString);
    }
  }, 30_000);
  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    mockAdapterExecute.mockClear();
  });
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), holderId = randomUUID(), reviewerId = randomUUID(), executorId = randomUUID();
    const issueId = randomUUID(), blockerIssueId = randomUUID(), sourceRunId = randomUUID();
    const stage1Id = randomUUID(), stage2Id = randomUUID(), decisionId = randomUUID(), holdId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Blocked stage recovery", issuePrefix: `B${companyId.slice(0, 6)}`,
      requireBoardApprovalForNewAgents: false });
    const agentRow = (id: string, name: string) => ({ id, companyId, name, role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true } },
      permissions: { canCreateAgents: false, canAssignTasks: true } });
    await db.insert(agents).values([agentRow(holderId, "Escalation holder"), agentRow(reviewerId, "Reviewer"),
      agentRow(executorId, "Executor")]);
    const ownerUserId = `owner-${companyId}`;
    await db.insert(authUsers).values({ id: ownerUserId, name: ownerUserId, email: `${ownerUserId}@example.test`,
      createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: ownerUserId,
      status: "active", membershipRole: "owner" });
    const ref = (agentId: string) => ({ type: "agent", agentId, userId: null });
    const holder = ref(holderId);
    const executionPolicy = { mode: "normal", commentRequired: true, maxReviewRounds: 3, stages: [
      { id: stage1Id, type: "review", approvalsNeeded: 1, participants: [{ id: randomUUID(), ...ref(reviewerId) }] },
      { id: stage2Id, type: "review", approvalsNeeded: 1, participants: [{ id: randomUUID(), ...ref(reviewerId) }] },
    ] };
    const executionState = {
      status: "pending", currentStageId: stage2Id, currentStageIndex: 1, currentStageType: "review",
      currentParticipant: holder, returnAssignee: ref(executorId), escalationHolder: holder,
      reviewRequest: null, completedStageIds: [stage1Id], lastDecisionId: decisionId,
      lastDecisionOutcome: "changes_requested", monitor: null, changesRequestedCount: 3,
    };
    await db.insert(issues).values([
      { id: blockerIssueId, companyId, title: "Independent prerequisite", status: "done", priority: "high" },
      // statusVersion 12: the settlement's own in_review -> blocked projection.
      { id: issueId, companyId, title: "Escalated pending review", status: "blocked", priority: "high",
        assigneeAgentId: holderId, executionPolicy, executionState, statusVersion: 12, unblockDescriptor: null },
    ]);
    await db.insert(issueRelations).values({ companyId, issueId: blockerIssueId, relatedIssueId: issueId, type: "blocks" });
    await db.insert(issueExecutionDecisions).values({ id: decisionId, companyId, issueId, stageId: stage2Id, stageType: "review",
      actorAgentId: reviewerId, outcome: "changes_requested", body: "Round 3" });
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId: holderId, runtimeMode: "legacy",
      status: "cancelled", errorCode: "issue_reassigned", invocationSource: "assignment", triggerDetail: "system",
      contextSnapshot: { issueId }, startedAt: new Date("2000-01-01T00:00:00Z"), finishedAt: new Date("2000-01-01T00:01:00Z") });
    const automaticRecovery = { policy: "preserve_without_replay_v1", runId: sourceRunId, replay: "blocked",
      actionOutcome: "unknown", recordedAt: "2000-01-01T00:02:00.000Z" };
    await db.insert(issueRecoveryActions).values({ id: holdId, companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      cause: "legacy_execution_requires_reconciliation", fingerprint: `legacy-execution:${sourceRunId}`,
      status: "resolved", outcome: "blocked", ownerType: "board", returnOwnerAgentId: holderId,
      nextAction: "Automatic recovery stopped.", resolvedAt: new Date("2000-01-01T00:02:00Z"),
      evidence: { runId: sourceRunId, attempt: 1, automaticRecovery } });
    const decision: ExecutionReconciliation = { runId: sourceRunId, providerStopped: true, actionOutcome: "completed",
      outcomeEvidence: "The cancelled source run left no external action in flight." };
    return { companyId, holderId, reviewerId, issueId, blockerIssueId, sourceRunId, stage2Id, holdId, decision,
      executionPolicy, executionState };
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
  const resolve = (f: Fixture, extra: Record<string, unknown> = {}, actor?: Record<string, unknown>) =>
    request(app(actor)).post(`/api/issues/${f.issueId}/recovery-actions/resolve`).send({
      actionId: f.holdId, outcome: "restored", sourceIssueStatus: "blocked",
      resolutionNote: "Verified: the stopped source run is reconciled; resume the same review stage.",
      executionReconciliation: f.decision, ...extra,
    });

  async function snapshot(f: Fixture) {
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const holds = await db.select().from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, f.issueId)).orderBy(issueRecoveryActions.createdAt);
    const decisions = await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, f.issueId));
    const wakes = await db.select().from(agentWakeupRequests).where(sql`${agentWakeupRequests.payload}->>'issueId' = ${f.issueId}`);
    return { task: task!, holds, decisions, wakes };
  }
  const taskFields = (task: Awaited<ReturnType<typeof snapshot>>["task"]) => JSON.stringify({
    status: task.status, statusVersion: task.statusVersion, assigneeAgentId: task.assigneeAgentId,
    executionPolicy: task.executionPolicy, executionState: task.executionState, unblockDescriptor: task.unblockDescriptor,
  });

  async function expectRefused(f: Fixture, extra: Record<string, unknown>, expected: { status?: number; code?: string },
    actor?: Record<string, unknown>) {
    const before = await snapshot(f);
    const res = await resolve(f, extra, actor);
    expect(res.status, JSON.stringify(res.body)).toBe(expected.status ?? 409);
    if (expected.code) expect(res.body.details?.code, JSON.stringify(res.body)).toBe(expected.code);
    const after = await snapshot(f);
    expect(taskFields(after.task)).toBe(taskFields(before.task));
    expect(after.holds).toEqual(before.holds);
    expect(after.decisions).toHaveLength(before.decisions.length);
    expect(after.wakes).toHaveLength(before.wakes.length);
    return res;
  }

  it("reconciles only the holds and wakes the pending participant once, keeping the task blocked", async () => {
    const f = await seed();
    expect(await getExecutionBlocker(db, f.companyId, f.issueId, { admittingAgentId: f.holderId })).not.toBeNull();
    const before = await snapshot(f);

    const res = await resolve(f);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const key = `stopped-stage-recovery:${f.issueId}:${f.stage2Id}:3`;
    expect(res.body.stageRecovery).toMatchObject({ participantAgentId: f.holderId, idempotencyKey: key,
      clearedHoldIds: [f.holdId] });

    const after = await snapshot(f);
    // Status, owner, policy, execution state and counters are byte-equal.
    expect(after.task.status).toBe("blocked");
    expect(taskFields(after.task)).toBe(taskFields(before.task));
    expect(JSON.stringify(after.task.executionState)).toBe(JSON.stringify(before.task.executionState));
    expect(JSON.stringify(after.task.executionPolicy)).toBe(JSON.stringify(before.task.executionPolicy));
    expect(after.decisions).toHaveLength(1);
    const [hold] = after.holds;
    expect(after.holds).toHaveLength(1);
    expect(hold).toMatchObject({ id: f.holdId, status: "resolved", outcome: "restored" });
    expect(hold!.evidence.automaticRecovery).toBeUndefined();
    expect(hold!.evidence).toMatchObject({ runId: f.sourceRunId, continuationDelivery: "delegated",
      continuationDeliveryOwner: { kind: "pending_stage_participant", agentId: f.holderId, stageId: f.stage2Id,
        changesRequestedCount: 3, idempotencyKey: key },
      executionReconciliation: { runId: f.sourceRunId, providerStopped: true, actorId: "board-user" } });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId, { admittingAgentId: f.holderId })).toBeNull();
    expect(after.wakes).toHaveLength(1);
    expect(after.wakes[0]).toMatchObject({ agentId: f.holderId, idempotencyKey: key, reason: "execution_review_requested",
      payload: expect.objectContaining({ issueId: f.issueId,
        executionStage: expect.objectContaining({ stageId: f.stage2Id }) }) });

    // A second call is a no-write replay: no second wake, no state change.
    const replay = await resolve(f);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.stageRecovery).toBeUndefined();
    const final = await snapshot(f);
    expect(final.wakes.filter((wake) => wake.idempotencyKey === key)).toHaveLength(1);
    expect(final.holds.map((h) => h.evidence)).toEqual(after.holds.map((h) => h.evidence));
    expect(final.decisions).toHaveLength(1);
    // The woken participant run itself does not check out or move the task.
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    const drained = await snapshot(f);
    expect(drained.task.status).toBe("blocked");
    expect(JSON.stringify(drained.task.executionState)).toBe(JSON.stringify(before.task.executionState));
  });

  it("redelivers the keyed wake once on replay when the first post-commit wake failed", async () => {
    const f = await seed();
    const key = `stopped-stage-recovery:${f.issueId}:${f.stage2Id}:3`;
    await db.delete(companyMemberships).where(eq(companyMemberships.companyId, f.companyId));
    const first = await resolve(f);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.stageRecovery.continuationRunId).toBeNull();
    expect((await snapshot(f)).wakes).toHaveLength(0);
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user",
      principalId: `owner-${f.companyId}`, status: "active", membershipRole: "owner" });
    const retry = await resolve(f);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body.stageRecovery).toMatchObject({ participantAgentId: f.holderId, idempotencyKey: key });
    const again = await resolve(f);
    expect(again.status).toBe(200);
    expect(again.body.stageRecovery).toBeUndefined();
    const after = await snapshot(f);
    expect(after.wakes.filter((wake) => wake.idempotencyKey === key)).toHaveLength(1);
    expect(after.task.status).toBe("blocked");
    expect(after.task.executionState).toEqual(f.executionState);
  });

  it("refuses a redelivery once an unblock descriptor is set", async () => {
    const f = await seed();
    await db.delete(companyMemberships).where(eq(companyMemberships.companyId, f.companyId));
    expect((await resolve(f)).status).toBe(200);
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user",
      principalId: `owner-${f.companyId}`, status: "active", membershipRole: "owner" });
    await db.update(issues).set({ unblockDescriptor: { owner: { type: "user", userId: "board-user" },
      action: "Decide the scope." } as any }).where(eq(issues.id, f.issueId));
    const res = await resolve(f);
    expect(res.status).toBe(200);
    expect(res.body.stageRecovery).toBeUndefined();
    expect((await snapshot(f)).wakes).toHaveLength(0);
  });

  it("refuses an unblock descriptor", async () => {
    const f = await seed();
    await db.update(issues).set({ unblockDescriptor: { owner: { type: "user", userId: "board-user" },
      action: "Decide the scope." } as any }).where(eq(issues.id, f.issueId));
    await expectRefused(f, {}, { code: "stage_recovery_block_unverified" });
  });

  it("refuses an unresolved dependency blocker", async () => {
    const f = await seed();
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, f.blockerIssueId));
    await expectRefused(f, {}, { code: "stage_recovery_blocked" });
  });

  it("refuses a sourceIssueStatus that is not the stored status", async () => {
    const f = await seed();
    await expectRefused(f, { sourceIssueStatus: "in_review" }, {});
    await expectRefused(f, { sourceIssueStatus: "todo" }, { code: "recovery_governed_stage_pending" });
  });

  it("refuses a settled action whose outcome is not blocked", async () => {
    const f = await seed();
    await db.update(issueRecoveryActions).set({ outcome: "cancelled" }).where(eq(issueRecoveryActions.id, f.holdId));
    await expectRefused(f, {}, { code: "stage_recovery_block_unverified" });
  });

  it("refuses an automatic record that names another run or none", async () => {
    const f = await seed();
    const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.holdId));
    const automatic = hold!.evidence.automaticRecovery as Record<string, unknown>;
    await db.update(issueRecoveryActions).set({ evidence: { ...hold!.evidence,
      automaticRecovery: { ...automatic, runId: randomUUID() } } }).where(eq(issueRecoveryActions.id, f.holdId));
    await expectRefused(f, {}, { code: "stage_recovery_block_unverified" });
    const { runId: _runId, ...withoutRun } = automatic;
    await db.update(issueRecoveryActions).set({ evidence: { ...hold!.evidence,
      automaticRecovery: withoutRun } }).where(eq(issueRecoveryActions.id, f.holdId));
    await expectRefused(f, {}, { code: "stage_recovery_block_unverified" });
  });

  it("refuses a non-board actor, even the participant", async () => {
    const f = await seed();
    await expectRefused(f, {}, { status: 403 },
      { type: "agent", agentId: f.holderId, companyId: f.companyId, runId: randomUUID(), source: "agent_jwt" });
  });

  it("keeps refusing a blocked restore outside the settled stage recovery", async () => {
    const f = await seed();
    // An active (unsettled) hold: the generic path never restores at blocked.
    await db.update(issueRecoveryActions).set({ status: "active", outcome: null, resolvedAt: null })
      .where(eq(issueRecoveryActions.id, f.holdId));
    await expectRefused(f, {}, { status: 422, code: "recovery_restore_status_invalid" });
    // A settled hold that is not an automatic no-replay settlement.
    const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.holdId));
    const { automaticRecovery: _automatic, ...evidence } = hold!.evidence;
    await db.update(issueRecoveryActions).set({ status: "resolved", outcome: "blocked", resolvedAt: new Date(), evidence })
      .where(eq(issueRecoveryActions.id, f.holdId));
    await expectRefused(f, {}, { status: 422, code: "recovery_restore_status_invalid" });
  });

  it("refuses a blocked task without a pending stage", async () => {
    const f = await seed();
    await db.update(issues).set({ executionState: { ...f.executionState, status: "idle" } }).where(eq(issues.id, f.issueId));
    await expectRefused(f, {}, { code: "stage_recovery_stage_not_pending" });
  });
});
