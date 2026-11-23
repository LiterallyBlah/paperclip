import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  approvals,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueApprovals,
  issueExecutionDecisions,
  issueRecoveryActions,
  issueRelations,
  issues,
  projects,
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

// BLA-1787. Synthetic fixture of the stuck shape: an in_review task whose
// pending review stage (max 1 round, count 1) is held by the same agent that
// is the assignee, the escalation holder and the recovery return owner. That
// agent's source run stopped, its independent blocker is done, and two
// resolved no-replay holds on that run stop every later wake.
const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("stopped pending stage recovery (BLA-1787)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    if (external) db = createDb(external);
    else {
      database = await startEmbeddedPostgresTestDatabase("stopped-pending-stage-recovery-");
      db = createDb(database.connectionString);
    }
  }, 30_000);
  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    mockAdapterExecute.mockClear();
  });
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), ownerId = randomUUID(), otherId = randomUUID();
    const issueId = randomUUID(), blockerIssueId = randomUUID(), sourceRunId = randomUUID();
    const stageId = randomUUID(), decisionId = randomUUID();
    const legacyHoldId = randomUUID(), settledHoldId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Stage recovery", issuePrefix: `S${companyId.slice(0, 6)}`,
      requireBoardApprovalForNewAgents: false });
    const agentRow = (id: string, name: string) => ({ id, companyId, name, role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true } },
      permissions: { canCreateAgents: false, canAssignTasks: true } });
    await db.insert(agents).values([agentRow(ownerId, "Owner"), agentRow(otherId, "Other")]);
    const ownerUserId = `owner-${companyId}`;
    await db.insert(authUsers).values({ id: ownerUserId, name: ownerUserId, email: `${ownerUserId}@example.test`,
      createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: ownerUserId,
      status: "active", membershipRole: "owner" });
    const self = { type: "agent", agentId: ownerId, userId: null };
    const executionPolicy = { mode: "normal", commentRequired: true, maxReviewRounds: 1,
      stages: [{ id: stageId, type: "review", approvalsNeeded: 1, participants: [{ id: randomUUID(), ...self }] }] };
    const executionState = {
      status: "pending", currentStageId: stageId, currentStageIndex: 0, currentStageType: "review",
      currentParticipant: self, returnAssignee: self, escalationHolder: self,
      reviewRequest: null, completedStageIds: [], lastDecisionId: decisionId,
      lastDecisionOutcome: "changes_requested", monitor: null, changesRequestedCount: 1,
    };
    await db.insert(issues).values([
      { id: blockerIssueId, companyId, title: "Independent prerequisite", status: "done", priority: "high" },
      { id: issueId, companyId, title: "Stuck pending review", status: "in_review", priority: "high",
        assigneeAgentId: ownerId, executionPolicy, executionState },
    ]);
    await db.insert(issueRelations).values({ companyId, issueId: blockerIssueId, relatedIssueId: issueId, type: "blocks" });
    await db.insert(issueExecutionDecisions).values({ id: decisionId, companyId, issueId, stageId, stageType: "review",
      actorAgentId: ownerId, outcome: "changes_requested", body: "Round 1" });
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId: ownerId, runtimeMode: "legacy",
      status: "failed", errorCode: "adapter_failed", invocationSource: "assignment", triggerDetail: "system",
      contextSnapshot: { issueId }, startedAt: new Date("2000-01-01T00:00:00Z"), finishedAt: new Date("2000-01-01T00:01:00Z") });
    const automaticRecovery = { policy: "preserve_without_replay_v1", runId: sourceRunId, replay: "blocked",
      actionOutcome: "unknown", recordedAt: "2000-01-01T00:02:00.000Z" };
    await db.insert(issueRecoveryActions).values([
      { id: legacyHoldId, companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
        cause: "legacy_execution_requires_reconciliation", fingerprint: `legacy-execution:${sourceRunId}`,
        status: "resolved", outcome: "blocked", ownerType: "board", returnOwnerAgentId: ownerId,
        nextAction: "Automatic recovery stopped.", resolvedAt: new Date("2000-01-01T00:02:00Z"),
        evidence: { runId: sourceRunId, attempt: 1, automaticRecovery } },
      { id: settledHoldId, companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
        cause: "uncertain_external_action", fingerprint: sourceRunId,
        status: "resolved", outcome: "blocked", ownerType: "board", returnOwnerAgentId: ownerId,
        nextAction: "Automatic recovery stopped.", resolvedAt: new Date("2000-01-01T00:03:00Z"),
        evidence: { runId: sourceRunId, automaticRecovery } },
    ]);
    const decision: ExecutionReconciliation = { runId: sourceRunId, providerStopped: true, actionOutcome: "completed",
      outcomeEvidence: "The source run posted its review notes; no other external action was started." };
    return { companyId, ownerId, otherId, issueId, blockerIssueId, sourceRunId, stageId, decisionId,
      legacyHoldId, settledHoldId, decision, executionPolicy, executionState };
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
  const body = (f: Fixture, extra: Record<string, unknown> = {}) => ({
    actionId: f.legacyHoldId, outcome: "restored", sourceIssueStatus: "in_review",
    resolutionNote: "Verified: the stopped source run is reconciled; resume the same review.",
    executionReconciliation: f.decision, ...extra,
  });
  const resolve = (f: Fixture, extra: Record<string, unknown> = {}, actor?: Record<string, unknown>) =>
    request(app(actor)).post(`/api/issues/${f.issueId}/recovery-actions/resolve`).send(body(f, extra));

  async function snapshot(f: Fixture) {
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const holds = await db.select().from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, f.issueId)).orderBy(issueRecoveryActions.createdAt);
    const decisions = await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, f.issueId));
    const wakes = await db.select().from(agentWakeupRequests).where(sql`${agentWakeupRequests.payload}->>'issueId' = ${f.issueId}`);
    return { task: task!, holds: holds.map((hold) => ({ id: hold.id, status: hold.status, outcome: hold.outcome,
      cause: hold.cause, fingerprint: hold.fingerprint, evidence: hold.evidence })), decisions, wakes };
  }

  async function expectUnchanged(f: Fixture, before: Awaited<ReturnType<typeof snapshot>>) {
    const after = await snapshot(f);
    expect(after.task.status).toBe(before.task.status);
    expect(after.task.executionState).toEqual(before.task.executionState);
    expect(after.task.executionPolicy).toEqual(before.task.executionPolicy);
    expect(after.holds).toEqual(before.holds);
    expect(after.decisions).toHaveLength(before.decisions.length);
    expect(after.wakes).toHaveLength(before.wakes.length);
  }

  async function expectRefused(f: Fixture, code: string, extra: Record<string, unknown> = {}, actor?: Record<string, unknown>) {
    const before = await snapshot(f);
    const res = await resolve(f, extra, actor);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details?.code ?? res.body.code, JSON.stringify(res.body)).toBe(code);
    await expectUnchanged(f, before);
    return res;
  }

  it("clears only the source run's holds and wakes the same pending participant once, keeping the stage", async () => {
    const f = await seed();
    expect(await getExecutionBlocker(db, f.companyId, f.issueId, { admittingAgentId: f.ownerId })).not.toBeNull();
    const before = await snapshot(f);

    const res = await resolve(f);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const key = `stopped-stage-recovery:${f.issueId}:${f.stageId}:1`;
    expect(res.body.stageRecovery).toMatchObject({ participantAgentId: f.ownerId, idempotencyKey: key });
    expect([...res.body.stageRecovery.clearedHoldIds].sort()).toEqual([f.legacyHoldId, f.settledHoldId].sort());

    const after = await snapshot(f);
    // Status, policy and the whole execution state are byte-identical.
    expect(after.task.status).toBe("in_review");
    expect(after.task.assigneeAgentId).toBe(f.ownerId);
    expect(after.task.executionPolicy).toEqual(f.executionPolicy);
    expect(after.task.executionState).toEqual(f.executionState);
    expect(after.task.executionState).toEqual(before.task.executionState);
    // No decision row.
    expect(after.decisions).toHaveLength(1);
    // Identity kept; only the no-replay hold is replaced by the reconciliation record.
    expect(after.holds.map(({ id, status, cause, fingerprint }) => ({ id, status, cause, fingerprint })))
      .toEqual(before.holds.map(({ id, status, cause, fingerprint }) => ({ id, status, cause, fingerprint })));
    for (const hold of after.holds) {
      expect(hold.outcome).toBe("restored");
      expect(hold.evidence.automaticRecovery).toBeUndefined();
      expect(hold.evidence).toMatchObject({ runId: f.sourceRunId, continuationDelivery: "delegated",
        continuationDeliveryOwner: { kind: "pending_stage_participant", agentId: f.ownerId, stageId: f.stageId,
          changesRequestedCount: 1, idempotencyKey: key },
        executionReconciliation: { runId: f.sourceRunId, providerStopped: true, actorId: "board-user" } });
    }
    expect(await getExecutionBlocker(db, f.companyId, f.issueId, { admittingAgentId: f.ownerId })).toBeNull();
    // Exactly one native stage wake to the current participant.
    const wakes = after.wakes.filter((wake) => wake.idempotencyKey === key);
    expect(wakes).toHaveLength(1);
    expect(after.wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ agentId: f.ownerId, reason: "execution_review_requested",
      payload: expect.objectContaining({ issueId: f.issueId,
        executionStage: expect.objectContaining({ stageId: f.stageId, wakeRole: "reviewer" }) }) });

    // A replay is a no-op: no second wake, no state change.
    for (const actionId of [f.legacyHoldId, f.settledHoldId]) {
      const replay = await resolve(f, { actionId });
      expect(replay.status, JSON.stringify(replay.body)).toBe(200);
      expect(replay.body.stageRecovery).toBeUndefined();
    }
    const final = await snapshot(f);
    expect(final.wakes.filter((wake) => wake.idempotencyKey === key)).toHaveLength(1);
    expect(final.task.executionState).toEqual(f.executionState);
    expect(final.task.status).toBe("in_review");
    expect(final.decisions).toHaveLength(1);
  });

  it("redelivers the keyed wake once on replay when the first post-commit wake failed", async () => {
    const f = await seed();
    const key = `stopped-stage-recovery:${f.issueId}:${f.stageId}:1`;
    // No responsible user: the post-commit wake throws before creating a request.
    await db.delete(companyMemberships).where(eq(companyMemberships.companyId, f.companyId));
    const first = await resolve(f);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.stageRecovery.continuationRunId).toBeNull();
    expect((await snapshot(f)).wakes).toHaveLength(0);
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user",
      principalId: `owner-${f.companyId}`, status: "active", membershipRole: "owner" });
    const retry = await resolve(f, { actionId: f.settledHoldId });
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body.stageRecovery).toMatchObject({ participantAgentId: f.ownerId, idempotencyKey: key });
    const again = await resolve(f);
    expect(again.status).toBe(200);
    expect(again.body.stageRecovery).toBeUndefined();
    const after = await snapshot(f);
    expect(after.wakes.filter((wake) => wake.idempotencyKey === key)).toHaveLength(1);
    expect(after.wakes).toHaveLength(1);
    expect(after.task.executionState).toEqual(f.executionState);
    expect(after.task.status).toBe("in_review");
    expect(after.decisions).toHaveLength(1);
  });

  it("keeps the todo hand-back refusal for the same shape", async () => {
    const f = await seed();
    await expectRefused(f, "recovery_governed_stage_pending", { sourceIssueStatus: "todo" });
  });

  it("refuses a non-board actor, even the participant", async () => {
    const f = await seed();
    const before = await snapshot(f);
    const res = await resolve(f, {}, { type: "agent", agentId: f.ownerId, companyId: f.companyId, runId: randomUUID(), source: "agent_jwt" });
    expect(res.status).toBe(403);
    await expectUnchanged(f, before);
  });

  it("refuses a changed owner", async () => {
    const f = await seed();
    await db.update(issues).set({ assigneeAgentId: f.otherId }).where(eq(issues.id, f.issueId));
    await expectRefused(f, "stage_recovery_owner_changed");
  });

  it("refuses a changed return owner", async () => {
    const f = await seed();
    await db.update(issueRecoveryActions).set({ returnOwnerAgentId: f.otherId }).where(eq(issueRecoveryActions.id, f.legacyHoldId));
    await expectRefused(f, "stage_recovery_owner_changed");
  });

  it("refuses a changed participant", async () => {
    const f = await seed();
    await db.update(issues).set({ executionState: { ...f.executionState,
      currentParticipant: { type: "agent", agentId: f.otherId, userId: null } } }).where(eq(issues.id, f.issueId));
    await expectRefused(f, "stage_recovery_owner_changed");
  });

  it("refuses a human participant", async () => {
    const f = await seed();
    await db.update(issues).set({ executionState: { ...f.executionState,
      currentParticipant: { type: "user", agentId: null, userId: "reviewer-user" } } }).where(eq(issues.id, f.issueId));
    await expectRefused(f, "stage_recovery_human_participant");
  });

  it("refuses a pending governed (human) approval", async () => {
    const f = await seed();
    const approvalId = randomUUID();
    await db.insert(approvals).values({ id: approvalId, companyId: f.companyId, type: "hire_agent", status: "pending", payload: {} });
    await db.insert(issueApprovals).values({ companyId: f.companyId, issueId: f.issueId, approvalId });
    await expectRefused(f, "recovery_governed_approval_pending");
  });

  it("refuses a source run that is not terminal", async () => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, f.sourceRunId));
    await expectRefused(f, "stage_recovery_source_unverified");
  });

  it("refuses while the source provider process is still running", async () => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ processPid: process.pid }).where(eq(heartbeatRuns.id, f.sourceRunId));
    await expectRefused(f, "stage_recovery_source_unverified");
  });

  it("refuses a live execution run on the task", async () => {
    const f = await seed();
    await db.update(issues).set({ executionRunId: f.sourceRunId }).where(eq(issues.id, f.issueId));
    await expectRefused(f, "stage_recovery_run_live");
  });

  it("refuses a reconciliation for another source run", async () => {
    const f = await seed();
    await expectRefused(f, "stage_recovery_source_mismatch",
      { executionReconciliation: { ...f.decision, runId: randomUUID() } });
  });

  it("refuses when an unrelated hold of another source run remains", async () => {
    const f = await seed();
    const otherRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: otherRunId, companyId: f.companyId, agentId: f.ownerId, runtimeMode: "legacy",
      status: "failed", contextSnapshot: { issueId: f.issueId }, startedAt: new Date(), finishedAt: new Date() });
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog",
      cause: "uncertain_provider_action", fingerprint: otherRunId, status: "resolved", outcome: "blocked", ownerType: "board",
      returnOwnerAgentId: f.ownerId, nextAction: "Automatic recovery stopped.",
      evidence: { runId: otherRunId, automaticRecovery: { replay: "blocked", runId: otherRunId } } });
    await expectRefused(f, "stage_recovery_unrelated_hold");
  });

  it("refuses a hold whose automatic record names another run", async () => {
    const f = await seed();
    const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.settledHoldId));
    await db.update(issueRecoveryActions).set({ evidence: { ...hold!.evidence,
      automaticRecovery: { replay: "blocked", runId: randomUUID() } } }).where(eq(issueRecoveryActions.id, f.settledHoldId));
    await expectRefused(f, "stage_recovery_unrelated_hold");
  });

  it("refuses a genuinely active competing recovery action", async () => {
    const f = await seed();
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId, kind: "missing_disposition",
      cause: "missing_disposition", fingerprint: `competing:${randomUUID()}`, status: "active", ownerType: "agent",
      ownerAgentId: f.otherId, returnOwnerAgentId: f.ownerId, nextAction: "Choose a disposition.", evidence: {} });
    await expectRefused(f, "stage_recovery_competing_action");
  });

  it("refuses a project budget pause", async () => {
    const f = await seed();
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId: f.companyId, name: "Paused", pausedAt: new Date(), pauseReason: "budget" });
    await db.update(issues).set({ projectId }).where(eq(issues.id, f.issueId));
    await expectRefused(f, "recovery_project_paused");
  });

  it("refuses a paused participant", async () => {
    const f = await seed();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.ownerId));
    await expectRefused(f, "stage_recovery_participant_unavailable");
  });

  it("refuses an unresolved blocker", async () => {
    const f = await seed();
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, f.blockerIssueId));
    await expectRefused(f, "stage_recovery_blocked");
  });

  it("refuses a duplicate delivery for the same stage round", async () => {
    const f = await seed();
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.ownerId, source: "assignment",
      triggerDetail: "system", reason: "execution_review_requested", status: "finished", payload: { issueId: f.issueId },
      idempotencyKey: `stopped-stage-recovery:${f.issueId}:${f.stageId}:1` });
    await expectRefused(f, "stage_recovery_duplicate_delivery");
  });

  it("refuses an outcome other than restored", async () => {
    const f = await seed();
    await expectRefused(f, "stage_recovery_outcome_invalid", { outcome: "false_positive" });
  });

  it("leaves the base settled-branch refusal for a non-review status", async () => {
    const f = await seed();
    const before = await snapshot(f);
    const res = await resolve(f, { sourceIssueStatus: "done" });
    expect(res.status).toBe(409);
    expect(res.body.details?.code).toBeUndefined();
    await expectUnchanged(f, before);
    const [hold] = await db.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.id, f.legacyHoldId), eq(issueRecoveryActions.companyId, f.companyId)));
    expect(hold!.evidence.automaticRecovery).toMatchObject({ replay: "blocked" });
  });
});
