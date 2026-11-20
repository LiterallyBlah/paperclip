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
  environmentLeases,
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
import { isApprovedStageAdvanceSource } from "../services/execution-recovery-resolution.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0, signal: null, timedOut: false, errorMessage: null,
    summary: "Approved advance recovery test run.", provider: "test", model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })),
  };
});

// BLA-2425. Synthetic fixture of the "approved advance" shape: stage 1's
// reviewer (agent A) approved, the policy moved to stage 2, and stage 2's
// reviewer (agent B) is the current participant and assignee. A's source run
// stopped and a resolved no-replay hold on that run stops B's wake.
const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("approved advance stage recovery (BLA-2425)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    if (external) db = createDb(external);
    else {
      database = await startEmbeddedPostgresTestDatabase("approved-advance-stage-recovery-");
      db = createDb(database.connectionString);
    }
  }, 30_000);
  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    mockAdapterExecute.mockClear();
  });
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), executorId = randomUUID(), reviewerAId = randomUUID(), reviewerBId = randomUUID();
    const otherId = randomUUID();
    const issueId = randomUUID(), blockerIssueId = randomUUID(), sourceRunId = randomUUID();
    const stage1Id = randomUUID(), stage2Id = randomUUID(), decisionId = randomUUID();
    const reviewerHoldId = randomUUID(), settledHoldId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Approved advance", issuePrefix: `A${companyId.slice(0, 6)}`,
      requireBoardApprovalForNewAgents: false });
    const agentRow = (id: string, name: string) => ({ id, companyId, name, role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true } },
      permissions: { canCreateAgents: false, canAssignTasks: true } });
    await db.insert(agents).values([agentRow(executorId, "Executor"), agentRow(reviewerAId, "Reviewer A"),
      agentRow(reviewerBId, "Reviewer B"), agentRow(otherId, "Other")]);
    const ownerUserId = `owner-${companyId}`;
    await db.insert(authUsers).values({ id: ownerUserId, name: ownerUserId, email: `${ownerUserId}@example.test`,
      createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: ownerUserId,
      status: "active", membershipRole: "owner" });
    const principal = (agentId: string) => ({ type: "agent", agentId, userId: null });
    const executionPolicy = { mode: "normal", commentRequired: true, maxReviewRounds: 2, stages: [
      { id: stage1Id, type: "review", approvalsNeeded: 1, participants: [{ id: randomUUID(), ...principal(reviewerAId) }] },
      { id: stage2Id, type: "review", approvalsNeeded: 1, participants: [{ id: randomUUID(), ...principal(reviewerBId) }] },
    ] };
    const executionState = {
      status: "pending", currentStageId: stage2Id, currentStageIndex: 1, currentStageType: "review",
      currentParticipant: principal(reviewerBId), returnAssignee: principal(executorId),
      reviewRequest: null, completedStageIds: [stage1Id], lastDecisionId: decisionId,
      lastDecisionOutcome: "approved", monitor: null, changesRequestedCount: 0,
    };
    await db.insert(issues).values([
      { id: blockerIssueId, companyId, title: "Independent prerequisite", status: "done", priority: "high" },
      { id: issueId, companyId, title: "Advanced to stage 2", status: "in_review", priority: "high",
        assigneeAgentId: reviewerBId, executionPolicy, executionState },
    ]);
    await db.insert(issueRelations).values({ companyId, issueId: blockerIssueId, relatedIssueId: issueId, type: "blocks" });
    await db.insert(issueExecutionDecisions).values({ id: decisionId, companyId, issueId, stageId: stage1Id,
      stageType: "review", actorAgentId: reviewerAId, outcome: "approved", body: "Stage 1 approved" });
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId: reviewerAId, runtimeMode: "legacy",
      status: "failed", errorCode: "adapter_failed", invocationSource: "assignment", triggerDetail: "system",
      contextSnapshot: { issueId }, startedAt: new Date("2000-01-01T00:00:00Z"), finishedAt: new Date("2000-01-01T00:01:00Z") });
    const automaticRecovery = { policy: "preserve_without_replay_v1", runId: sourceRunId, replay: "blocked",
      actionOutcome: "unknown", recordedAt: "2000-01-01T00:02:00.000Z" };
    await db.insert(issueRecoveryActions).values([
      { id: reviewerHoldId, companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
        cause: "uncertain_external_action", fingerprint: `execution-control:${sourceRunId}`,
        status: "resolved", outcome: "cancelled", ownerType: "board", returnOwnerAgentId: reviewerAId,
        nextAction: "Recovery closed.", resolvedAt: new Date("2000-01-01T00:02:00Z"),
        evidence: { runId: sourceRunId, reviewParticipantAgentId: reviewerAId, automaticRecovery } },
      { id: settledHoldId, companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
        cause: "legacy_execution_requires_reconciliation", fingerprint: `legacy-execution:${sourceRunId}`,
        status: "resolved", outcome: "cancelled", ownerType: "board", returnOwnerAgentId: reviewerBId,
        nextAction: "Recovery closed.", resolvedAt: new Date("2000-01-01T00:03:00Z"),
        evidence: { runId: sourceRunId, reviewParticipantAgentId: reviewerAId, attempt: 1, automaticRecovery } },
    ]);
    const decision: ExecutionReconciliation = { runId: sourceRunId, providerStopped: true, actionOutcome: "completed",
      outcomeEvidence: "The stage 1 reviewer's run recorded its approval; no other external action was started." };
    return { companyId, executorId, reviewerAId, reviewerBId, otherId, issueId, blockerIssueId, sourceRunId,
      stage1Id, stage2Id, decisionId, reviewerHoldId, settledHoldId, decision, executionPolicy, executionState };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;

  const board = { type: "board", userId: "board-user", source: "local_implicit", isInstanceAdmin: true };
  function app() {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => { (req as any).actor = board; next(); });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use(errorHandler);
    return testApp;
  }
  const resolve = (f: Fixture, extra: Record<string, unknown> = {}) =>
    request(app()).post(`/api/issues/${f.issueId}/recovery-actions/resolve`).send({
      actionId: f.reviewerHoldId, outcome: "restored", sourceIssueStatus: "in_review",
      resolutionNote: "Verified: the approving reviewer's stopped run is reconciled; wake the next stage.",
      executionReconciliation: f.decision, ...extra,
    });
  const key = (f: Fixture) => `stopped-stage-recovery:${f.issueId}:${f.stage2Id}:0`;

  async function snapshot(f: Fixture) {
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const holds = await db.select().from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, f.issueId)).orderBy(issueRecoveryActions.createdAt);
    const decisions = await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, f.issueId));
    const wakes = await db.select().from(agentWakeupRequests).where(sql`${agentWakeupRequests.payload}->>'issueId' = ${f.issueId}`);
    return { task: task!, holds: holds.map((hold) => ({ id: hold.id, status: hold.status, outcome: hold.outcome,
      returnOwnerAgentId: hold.returnOwnerAgentId, evidence: hold.evidence })), decisions, wakes };
  }

  async function expectRefused(f: Fixture, code: string, extra: Record<string, unknown> = {}) {
    const before = await snapshot(f);
    const res = await resolve(f, extra);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details?.code ?? res.body.code, JSON.stringify(res.body)).toBe(code);
    const after = await snapshot(f);
    expect(after.task.status).toBe(before.task.status);
    expect(after.task.assigneeAgentId).toBe(before.task.assigneeAgentId);
    expect(after.task.executionState).toEqual(before.task.executionState);
    expect(after.task.executionPolicy).toEqual(before.task.executionPolicy);
    expect(after.holds).toEqual(before.holds);
    expect(after.decisions).toEqual(before.decisions);
    expect(after.wakes).toHaveLength(before.wakes.length);
  }

  it("clears only A's source-run holds and wakes stage 2's participant B once, keeping the whole stage", async () => {
    const f = await seed();
    // Repro: the approving reviewer's hold stops B's admission.
    expect(await getExecutionBlocker(db, f.companyId, f.issueId, { admittingAgentId: f.reviewerBId })).not.toBeNull();
    const before = await snapshot(f);

    const res = await resolve(f);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.stageRecovery).toMatchObject({ participantAgentId: f.reviewerBId, idempotencyKey: key(f) });
    expect([...res.body.stageRecovery.clearedHoldIds].sort()).toEqual([f.reviewerHoldId, f.settledHoldId].sort());

    const after = await snapshot(f);
    expect(after.task.status).toBe("in_review");
    expect(after.task.assigneeAgentId).toBe(f.reviewerBId);
    expect(after.task.executionPolicy).toEqual(f.executionPolicy);
    expect(after.task.executionState).toEqual(f.executionState);
    expect(after.task.executionState).toEqual(before.task.executionState);
    expect(after.decisions).toEqual(before.decisions);
    expect(after.holds.map(({ id, status, returnOwnerAgentId }) => ({ id, status, returnOwnerAgentId })))
      .toEqual(before.holds.map(({ id, status, returnOwnerAgentId }) => ({ id, status, returnOwnerAgentId })));
    for (const hold of after.holds) {
      expect(hold.outcome).toBe("restored");
      expect(hold.evidence.automaticRecovery).toBeUndefined();
      expect(hold.evidence).toMatchObject({ runId: f.sourceRunId, reviewParticipantAgentId: f.reviewerAId,
        continuationDelivery: "delegated",
        continuationDeliveryOwner: { kind: "pending_stage_participant", agentId: f.reviewerBId, stageId: f.stage2Id,
          changesRequestedCount: 0, idempotencyKey: key(f) },
        executionReconciliation: { runId: f.sourceRunId, providerStopped: true, actorId: "board-user" } });
    }
    expect(await getExecutionBlocker(db, f.companyId, f.issueId, { admittingAgentId: f.reviewerBId })).toBeNull();
    // Exactly one native stage wake, to B, and none to A or the executor.
    expect(after.wakes).toHaveLength(1);
    expect(after.wakes[0]).toMatchObject({ agentId: f.reviewerBId, idempotencyKey: key(f),
      reason: "execution_review_requested",
      payload: expect.objectContaining({ issueId: f.issueId,
        executionStage: expect.objectContaining({ stageId: f.stage2Id, wakeRole: "reviewer" }) }) });
    // No replay of the source run.
    const runs = await db.select().from(heartbeatRuns).where(sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issueId}`);
    expect(runs.filter((run) => run.agentId === f.reviewerAId).map((run) => run.id)).toEqual([f.sourceRunId]);

    // A replay is a no-op.
    for (const actionId of [f.reviewerHoldId, f.settledHoldId]) {
      const replay = await resolve(f, { actionId });
      expect(replay.status, JSON.stringify(replay.body)).toBe(200);
      expect(replay.body.stageRecovery).toBeUndefined();
    }
    const final = await snapshot(f);
    expect(final.wakes).toHaveLength(1);
    expect(final.task.executionState).toEqual(f.executionState);
    expect(final.decisions).toEqual(before.decisions);
  });

  it("redelivers B's keyed wake once on replay when the first post-commit wake failed", async () => {
    const f = await seed();
    await db.delete(companyMemberships).where(eq(companyMemberships.companyId, f.companyId));
    const first = await resolve(f);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.stageRecovery.continuationRunId).toBeNull();
    expect((await snapshot(f)).wakes).toHaveLength(0);
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user",
      principalId: `owner-${f.companyId}`, status: "active", membershipRole: "owner" });
    const retry = await resolve(f);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body.stageRecovery).toMatchObject({ participantAgentId: f.reviewerBId, idempotencyKey: key(f) });
    const again = await resolve(f, { actionId: f.settledHoldId });
    expect(again.status).toBe(200);
    expect(again.body.stageRecovery).toBeUndefined();
    const after = await snapshot(f);
    expect(after.wakes).toHaveLength(1);
    expect(after.wakes[0]).toMatchObject({ agentId: f.reviewerBId, idempotencyKey: key(f) });
    expect(after.task.executionState).toEqual(f.executionState);
  });

  it("refuses a changes_requested outcome under this branch", async () => {
    const f = await seed();
    await db.update(issues).set({ executionState: { ...f.executionState, lastDecisionOutcome: "changes_requested" } })
      .where(eq(issues.id, f.issueId));
    await db.update(issueExecutionDecisions).set({ outcome: "changes_requested" }).where(eq(issueExecutionDecisions.id, f.decisionId));
    await expectRefused(f, "stage_recovery_approval_unverified");
  });

  it("refuses when the run's agent is not the approving reviewer", async () => {
    const f = await seed();
    await db.update(issueExecutionDecisions).set({ actorAgentId: f.otherId }).where(eq(issueExecutionDecisions.id, f.decisionId));
    await expectRefused(f, "stage_recovery_approval_unverified");
  });

  it("refuses when the recorded approval is not the task's latest decision", async () => {
    const f = await seed();
    await db.insert(issueExecutionDecisions).values({ companyId: f.companyId, issueId: f.issueId, stageId: f.stage2Id,
      stageType: "review", actorAgentId: f.reviewerBId, outcome: "changes_requested", body: "Later",
      createdAt: new Date(Date.now() + 60_000) });
    await expectRefused(f, "stage_recovery_approval_unverified");
  });

  it("refuses when the approved stage is not a completed stage before the current one", async () => {
    const f = await seed();
    await db.update(issues).set({ executionState: { ...f.executionState, completedStageIds: [] } })
      .where(eq(issues.id, f.issueId));
    await expectRefused(f, "stage_recovery_approval_unverified");
  });

  it("refuses when the action does not name A as its review participant", async () => {
    const f = await seed();
    const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.reviewerHoldId));
    await db.update(issueRecoveryActions).set({ evidence: { ...hold!.evidence, reviewParticipantAgentId: undefined } })
      .where(eq(issueRecoveryActions.id, f.reviewerHoldId));
    await expectRefused(f, "stage_recovery_approval_unverified");
  });

  it("refuses when the participant is not the assignee", async () => {
    const f = await seed();
    await db.update(issues).set({ assigneeAgentId: f.otherId }).where(eq(issues.id, f.issueId));
    await expectRefused(f, "stage_recovery_owner_changed");
  });

  it("refuses B === A: the relaxed return owner applies only to a distinct next participant", async () => {
    const f = await seed();
    // A is now both participant and assignee, while the hold's return owner is B.
    await db.update(issues).set({ assigneeAgentId: f.reviewerAId, executionState: { ...f.executionState,
      currentParticipant: { type: "agent", agentId: f.reviewerAId, userId: null } } }).where(eq(issues.id, f.issueId));
    await db.update(issueRecoveryActions).set({ returnOwnerAgentId: f.reviewerBId }).where(eq(issueRecoveryActions.id, f.reviewerHoldId));
    await expectRefused(f, "stage_recovery_owner_changed");
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.reviewerHoldId));
    expect(await isApprovedStageAdvanceSource(db, { companyId: f.companyId, task: task!, run: run!,
      agentId: f.reviewerAId, recoveryAction: action })).toBe(false);
  });

  it("refuses a hold whose return owner is a third agent", async () => {
    const f = await seed();
    await db.update(issueRecoveryActions).set({ returnOwnerAgentId: f.otherId }).where(eq(issueRecoveryActions.id, f.settledHoldId));
    await expectRefused(f, "stage_recovery_unrelated_hold");
  });

  it("refuses a source run that is still live", async () => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, f.sourceRunId));
    await expectRefused(f, "stage_recovery_source_unverified");
  });

  it("refuses while the source provider process is still running", async () => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ processPid: process.pid }).where(eq(heartbeatRuns.id, f.sourceRunId));
    await expectRefused(f, "stage_recovery_source_unverified");
  });

  it("refuses while the source run holds a live environment lease", async () => {
    const f = await seed();
    await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.sourceRunId,
      provider: "local", status: "active", leasePolicy: "ephemeral" });
    await expectRefused(f, "stage_recovery_source_unverified");
  });

  it("refuses an extra hold that does not match the source run", async () => {
    const f = await seed();
    const otherRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: otherRunId, companyId: f.companyId, agentId: f.reviewerAId, runtimeMode: "legacy",
      status: "failed", contextSnapshot: { issueId: f.issueId }, startedAt: new Date(), finishedAt: new Date() });
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog",
      cause: "uncertain_provider_action", fingerprint: otherRunId, status: "resolved", outcome: "cancelled", ownerType: "board",
      returnOwnerAgentId: f.reviewerAId, nextAction: "Recovery closed.",
      evidence: { runId: otherRunId, reviewParticipantAgentId: f.reviewerAId, automaticRecovery: { replay: "blocked", runId: otherRunId } } });
    await expectRefused(f, "stage_recovery_unrelated_hold");
  });

  it("refuses a hold of the source run that names another review participant", async () => {
    const f = await seed();
    const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.settledHoldId));
    await db.update(issueRecoveryActions).set({ evidence: { ...hold!.evidence, reviewParticipantAgentId: f.reviewerBId } })
      .where(eq(issueRecoveryActions.id, f.settledHoldId));
    await expectRefused(f, "stage_recovery_unrelated_hold");
  });

  it("refuses an unresolved blocker", async () => {
    const f = await seed();
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, f.blockerIssueId));
    await expectRefused(f, "stage_recovery_blocked");
  });

  it("refuses a paused next participant", async () => {
    const f = await seed();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.reviewerBId));
    await expectRefused(f, "stage_recovery_participant_unavailable");
  });

  it("keeps the todo hand-back refusal for the approved-advance shape", async () => {
    const f = await seed();
    const before = await snapshot(f);
    const res = await resolve(f, { sourceIssueStatus: "todo" });
    expect(res.status).toBe(409);
    expect((await snapshot(f)).holds).toEqual(before.holds);
  });
});
