import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  authUsers,
  budgetPolicies,
  costEvents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { settleUnrecoverableExecutions } from "../services/execution-recovery-resolution.js";
import { withQueuedCommentIdsInWakePayload } from "../services/issue-queued-comment-queue.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Review stage hold test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })),
  };
});

// Lets a test run the disposition worker between the route's reassignment
// stop and its issue update, the interleaving observed on a live instance.
const afterReassignmentStop = vi.hoisted(() => ({ run: null as null | (() => Promise<void>) }));

vi.mock("../services/heartbeat.js", async () => {
  const actual = await vi.importActual<typeof import("../services/heartbeat.js")>("../services/heartbeat.js");
  return {
    ...actual,
    heartbeatService: (...args: Parameters<typeof actual.heartbeatService>) => {
      const service = actual.heartbeatService(...args);
      return {
        ...service,
        cancelRun: async (...cancelArgs: Parameters<typeof service.cancelRun>) => {
          const stopped = await service.cancelRun(...cancelArgs);
          if (cancelArgs[2]?.errorCode === "issue_reassigned") await afterReassignmentStop.run?.();
          return stopped;
        },
      };
    },
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping handed-off hold tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

const STAGE_WAKE_REASON = "execution_review_requested";
const HOLD_CAUSE = "legacy_execution_requires_reconciliation";
// Executor and participant roles differ in every pair; nothing depends on a role.
const ROLE_PAIRS = [
  { executorRole: "engineer", participantRole: "qa" },
  { executorRole: "ceo", participantRole: "security" },
] as const;

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    value = await read();
  }
  return value;
}

describeEmbeddedPostgres("review stage participant behind the executor's handed-off no-replay hold", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-review-stage-handed-off-hold-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
    mockAdapterExecute.mockClear();
    afterReassignmentStop.run = null;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(companyId: string, agentActor: { agentId: string; runId: string }) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = {
        type: "agent", ...agentActor, companyId, source: "agent_jwt",
        companyIds: [companyId], memberships: [], isInstanceAdmin: false,
      };
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use(errorHandler);
    return testApp;
  }

  async function seed(roles: (typeof ROLE_PAIRS)[number]) {
    const companyId = randomUUID();
    const executorId = randomUUID();
    const participantId = randomUUID();
    const issueId = randomUUID();
    const executorRunId = randomUUID();
    const stageId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Hold Co", issuePrefix: `H${companyId.slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const agentRow = (id: string, name: string, role: string) => ({
      id, companyId, name, role, status: "idle", adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true } },
      permissions: { canCreateAgents: false, canAssignTasks: true },
    });
    await db.insert(agents).values([
      agentRow(executorId, "Agent A", roles.executorRole), agentRow(participantId, "Agent B", roles.participantRole),
    ]);
    const ownerId = `owner-${companyId}`;
    await db.insert(authUsers).values({ id: ownerId, name: "Fixture owner", email: `${ownerId}@example.test`,
      createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: ownerId, status: "active", membershipRole: "owner",
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Hand off to review", status: "in_progress", priority: "medium",
      assigneeAgentId: executorId, createdByUserId: ownerId,
      executionPolicy: {
        mode: "normal", commentRequired: false,
        stages: [{ id: stageId, type: "review", approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: participantId, userId: null }] }],
      },
    });
    return { companyId, executorId, participantId, issueId, executorRunId, stageId };
  }

  type Seeded = Awaited<ReturnType<typeof seed>>;

  /**
   * The executor's live run, with no local process and no resume policy: the
   * reassignment stop cannot acknowledge provider termination, so stopping it
   * leaves a no-replay hold on its unverified actions.
   */
  async function startExecutorRun(s: Seeded) {
    const startedAt = new Date(Date.now() - 60_000);
    await db.insert(heartbeatRuns).values({
      id: s.executorRunId, companyId: s.companyId, agentId: s.executorId, status: "running", runtimeMode: "legacy",
      invocationSource: "assignment", triggerDetail: "system", startedAt,
      contextSnapshot: { issueId: s.issueId, taskId: s.issueId, wakeReason: "issue_assigned" },
    });
    await db.update(issues).set({ checkoutRunId: s.executorRunId, executionRunId: s.executorRunId,
      executionLockedAt: startedAt }).where(eq(issues.id, s.issueId));
  }

  async function handOffToReview(s: Seeded) {
    const res = await request(app(s.companyId, { agentId: s.executorId, runId: s.executorRunId }))
      .patch(`/api/issues/${s.issueId}`)
      .send({ status: "in_review", comment: "Ready for review." });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [issue] = await db.select().from(issues).where(eq(issues.id, s.issueId));
    expect(issue).toMatchObject({ status: "in_review", assigneeAgentId: s.participantId });
    return issue!;
  }

  const wakesFor = (s: Seeded, agentId: string) => db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, s.companyId), eq(agentWakeupRequests.agentId, agentId),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${s.issueId}`,
  ));
  const runsFor = (s: Seeded, agentId: string) => db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, s.companyId), eq(heartbeatRuns.agentId, agentId),
    sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${s.issueId}`,
  ));
  const holdsFor = (s: Seeded) => db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, s.companyId), eq(issueRecoveryActions.sourceIssueId, s.issueId),
  ));

  describe.each(ROLE_PAIRS)("executor $executorRole hands off to participant $participantRole", (roles) => {
    it("delivers the participant's stage wake while the hold stays on the executor", async () => {
      const s = await seed(roles);
      await startExecutorRun(s);
      afterReassignmentStop.run = () => settleUnrecoverableExecutions(db).then(() => undefined);
      await handOffToReview(s);
      const [hold] = await holdsFor(s);
      expect(hold).toMatchObject({ cause: HOLD_CAUSE, status: "resolved", outcome: "blocked",
        returnOwnerAgentId: s.executorId,
        evidence: expect.objectContaining({ runId: s.executorRunId,
          automaticRecovery: expect.objectContaining({ replay: "blocked" }) }) });
      const wakes = await waitFor(() => wakesFor(s, s.participantId),
        rows => rows.some(row => row.status !== "queued" || row.runId !== null));
      // Old behaviour: one terminal `skipped` receipt (execution_reconciliation_required), no run.
      expect(wakes.filter(row => row.status === "skipped")).toEqual([]);
      const runs = await runsFor(s, s.participantId);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.contextSnapshot).toMatchObject({ wakeReason: STAGE_WAKE_REASON, source: "issue.execution_stage",
        executionStage: { stageId: s.stageId, currentParticipant: { agentId: s.participantId } } });

      // The executor's unverified actions keep their hold, for the board and for the executor.
      expect(await holdsFor(s)).toEqual([hold]);
      expect(await getExecutionBlocker(db, s.companyId, s.issueId)).toMatchObject({ cause: HOLD_CAUSE, runId: s.executorRunId });
      expect(await getExecutionBlocker(db, s.companyId, s.issueId, { admittingAgentId: s.executorId }))
        .toMatchObject({ cause: HOLD_CAUSE, runId: s.executorRunId });
      expect(await getExecutionBlocker(db, s.companyId, s.issueId, { admittingAgentId: s.participantId })).toBeNull();
      // The run also passes the claim gate (old: cancelled there with
      // execution_reconciliation_required) and does not replay the executor's run.
      await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
      expect((await runsFor(s, s.participantId)).filter(run => !run.retryOfRunId)
        .map(run => [run.status, run.errorCode])).toEqual([["succeeded", null]]);
      expect((await runsFor(s, s.executorId)).map(run => run.id)).toEqual([s.executorRunId]);
    });
  });

  /**
   * A task already stranded by the defect: the participant's stage wake was
   * ended by the executor's hold, after an earlier review round.
   */
  async function seedRetainedHold(roles: (typeof ROLE_PAIRS)[number]) {
    const s = await seed(roles);
    const earlier = new Date(Date.now() - 10 * 60_000);
    await db.insert(heartbeatRuns).values({
      companyId: s.companyId, agentId: s.participantId, status: "succeeded", runtimeMode: "legacy",
      invocationSource: "assignment", triggerDetail: "system", startedAt: earlier, finishedAt: earlier,
      createdAt: earlier, updatedAt: earlier,
      contextSnapshot: { issueId: s.issueId, taskId: s.issueId, wakeReason: STAGE_WAKE_REASON },
    });
    const stoppedAt = new Date(Date.now() - 5 * 60_000);
    await db.insert(heartbeatRuns).values({
      id: s.executorRunId, companyId: s.companyId, agentId: s.executorId, status: "cancelled", runtimeMode: "legacy",
      invocationSource: "assignment", triggerDetail: "system", startedAt: stoppedAt, finishedAt: stoppedAt,
      createdAt: stoppedAt, updatedAt: stoppedAt, errorCode: "issue_reassigned", error: "Cancelled before issue reassignment",
      contextSnapshot: { issueId: s.issueId, taskId: s.issueId, wakeReason: "issue_commented" },
      resultJson: { reassignmentStopConfirmed: true, issueMutationStopId: randomUUID(),
        executionCancellation: { state: "requested", requestedAt: stoppedAt.toISOString() } },
    });
    const executionState = {
      status: "pending", currentStageId: s.stageId, currentStageIndex: 0, currentStageType: "review",
      currentParticipant: { type: "agent", agentId: s.participantId, userId: null },
      returnAssignee: { type: "agent", agentId: s.executorId, userId: null },
      reviewRequest: null, completedStageIds: [], lastDecisionId: randomUUID(),
      lastDecisionOutcome: "changes_requested", changesRequestedCount: 2,
    };
    await db.update(issues).set({ status: "in_review", assigneeAgentId: s.participantId, executionState })
      .where(eq(issues.id, s.issueId));
    await db.insert(issueRecoveryActions).values({
      companyId: s.companyId, sourceIssueId: s.issueId, kind: "active_run_watchdog", status: "resolved",
      outcome: "blocked", ownerType: "board", returnOwnerAgentId: s.executorId, cause: HOLD_CAUSE,
      fingerprint: `legacy-execution:${s.executorRunId}`, attemptCount: 1, maxAttempts: 3,
      evidence: { runId: s.executorRunId, attempt: 1, adapterRecovery: "unsupported_or_unknown",
        originalFailureCode: "issue_reassigned",
        automaticRecovery: { runId: s.executorRunId, policy: "preserve_without_replay_v1", replay: "blocked",
          actionOutcome: "unknown", recordedAt: stoppedAt.toISOString() } },
      nextAction: "Automatic recovery stopped.", resolvedAt: stoppedAt, lastAttemptAt: stoppedAt,
    });
    const [lost] = await db.insert(agentWakeupRequests).values({
      companyId: s.companyId, agentId: s.participantId, source: "assignment", triggerDetail: "system",
      reason: "execution_reconciliation_required", status: "skipped", error: "Inspect the stopped provider.",
      requestedByActorType: "agent", requestedByActorId: s.executorId,
      requestedAt: stoppedAt, finishedAt: stoppedAt, createdAt: stoppedAt, updatedAt: stoppedAt,
      payload: { issueId: s.issueId, mutation: "update", executionStage: { stageId: s.stageId, wakeRole: "reviewer" },
        executionWait: { recoveryActionId: null } },
    }).returning();
    return { ...s, executionState, lostWakeId: lost!.id };
  }

  /**
   * A later comment for the participant, deferred behind the executor's hold
   * and never run; no execution lock remains whose release would promote it.
   */
  async function addParkedCommentWake(s: Seeded) {
    const [hold] = await holdsFor(s);
    const commentedAt = new Date(Date.now() - 2 * 60_000);
    const [comment] = await db.insert(issueComments).values({
      companyId: s.companyId, issueId: s.issueId, authorAgentId: s.executorId, authorType: "agent",
      body: "One more note for the review.", createdAt: commentedAt, updatedAt: commentedAt,
    }).returning();
    const [deferred] = await db.insert(agentWakeupRequests).values({
      companyId: s.companyId, agentId: s.participantId, source: "automation", triggerDetail: "system",
      reason: "issue_commented", status: "deferred_issue_execution",
      requestedByActorType: "agent", requestedByActorId: s.executorId,
      requestedAt: commentedAt, createdAt: commentedAt, updatedAt: commentedAt,
      payload: withQueuedCommentIdsInWakePayload({ issueId: s.issueId, mutation: "comment",
        executionWait: { recoveryActionId: hold!.id, reason: "execution_recovery",
          message: "Waiting for execution recovery. Your message is saved." } }, [comment!.id]),
    }).returning();
    return deferred!;
  }

  describe.each(ROLE_PAIRS)("retained hold: executor $executorRole, participant $participantRole", (roles) => {
    it("re-admits the lost stage wake once, keeping stage, participant, counter and hold", async () => {
      const s = await seedRetainedHold(roles);
      const heartbeat = heartbeatService(db);
      const holdBefore = await holdsFor(s);

      await heartbeat.reconcileStrandedAssignedIssues();
      const stageRuns = async () => (await runsFor(s, s.participantId))
        .filter(run => (run.contextSnapshot as Record<string, unknown>).source === "issue.execution_stage");
      const runs = await stageRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0]!.contextSnapshot).toMatchObject({ wakeReason: STAGE_WAKE_REASON,
        executionStage: { stageId: s.stageId, currentParticipant: { agentId: s.participantId } } });

      const [issue] = await db.select().from(issues).where(eq(issues.id, s.issueId));
      expect(issue).toMatchObject({ status: "in_review", assigneeAgentId: s.participantId });
      expect(issue!.executionState).toMatchObject({ currentStageId: s.stageId, changesRequestedCount: 2,
        lastDecisionId: s.executionState.lastDecisionId,
        currentParticipant: { type: "agent", agentId: s.participantId } });
      // No replay: the executor gets no run, and its hold is untouched.
      expect((await runsFor(s, s.executorId)).map(run => run.id)).toEqual([s.executorRunId]);
      expect(await holdsFor(s)).toEqual(holdBefore);

      // Exactly once: later sweeps do not admit it again.
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      // The re-admitted run passed the claim gate and ran.
      expect((await stageRuns()).map(run => [run.status, run.errorCode])).toEqual([["succeeded", null]]);
      await heartbeat.reconcileStrandedAssignedIssues();
      await heartbeat.resumeQueuedRuns();
      expect(await stageRuns()).toHaveLength(1);
    });

    it("re-admits the lost stage wake once when a later comment wake was deferred behind the same hold", async () => {
      const s = await seedRetainedHold(roles);
      const heartbeat = heartbeatService(db);
      const holdBefore = await holdsFor(s);
      const deferred = await addParkedCommentWake(s);
      const [lockState] = await db.select({ executionRunId: issues.executionRunId, checkoutRunId: issues.checkoutRunId })
        .from(issues).where(eq(issues.id, s.issueId));
      expect(lockState).toEqual({ executionRunId: null, checkoutRunId: null });

      await heartbeat.reconcileStrandedAssignedIssues();
      const stageRuns = async () => (await runsFor(s, s.participantId))
        .filter(run => (run.contextSnapshot as Record<string, unknown>).source === "issue.execution_stage");
      // Old behaviour: the deferred comment wake hides the lost stage wake, so no run.
      const runs = await stageRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0]!.contextSnapshot).toMatchObject({ wakeReason: STAGE_WAKE_REASON,
        executionStage: { stageId: s.stageId, currentParticipant: { agentId: s.participantId } } });

      const [issue] = await db.select().from(issues).where(eq(issues.id, s.issueId));
      expect(issue).toMatchObject({ status: "in_review", assigneeAgentId: s.participantId });
      expect(issue!.executionState).toMatchObject({ currentStageId: s.stageId, changesRequestedCount: 2,
        lastDecisionId: s.executionState.lastDecisionId,
        currentParticipant: { type: "agent", agentId: s.participantId } });
      expect((await runsFor(s, s.executorId)).map(run => run.id)).toEqual([s.executorRunId]);
      expect(await holdsFor(s)).toEqual(holdBefore);

      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      expect((await stageRuns()).map(run => [run.status, run.errorCode])).toEqual([["succeeded", null]]);
      // The saved comment is no longer stranded: it was delivered by a participant run.
      const [after] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, deferred!.id));
      expect(after!.status).not.toBe("deferred_issue_execution");
      expect(after!.runId).not.toBeNull();
      await heartbeat.reconcileStrandedAssignedIssues();
      await heartbeat.resumeQueuedRuns();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      expect(await stageRuns()).toHaveLength(1);
    });
  });

  it("keeps a genuine hold on the executor's own continuation", async () => {
    const s = await seedRetainedHold(ROLE_PAIRS[0]);
    // Changes requested: the task returns to the executor.
    await db.update(issues).set({ status: "in_progress", assigneeAgentId: s.executorId, executionState: null })
      .where(eq(issues.id, s.issueId));
    expect(await getExecutionBlocker(db, s.companyId, s.issueId, { admittingAgentId: s.executorId }))
      .toMatchObject({ cause: HOLD_CAUSE, runId: s.executorRunId });
    await heartbeatService(db).wakeup(s.executorId, {
      source: "automation", triggerDetail: "system", reason: "issue_commented",
      payload: { issueId: s.issueId }, contextSnapshot: { issueId: s.issueId, taskId: s.issueId },
      requestedByActorType: "system", requestedByActorId: "test",
    });
    expect((await runsFor(s, s.executorId)).map(run => run.id)).toEqual([s.executorRunId]);
    // Nor does the hold stop gating another agent once it is no longer the stage participant.
    expect(await getExecutionBlocker(db, s.companyId, s.issueId, { admittingAgentId: s.participantId }))
      .toMatchObject({ cause: HOLD_CAUSE });
  });

  it("keeps a workspace repair hold blocking the participant", async () => {
    const s = await seedRetainedHold(ROLE_PAIRS[0]);
    await db.update(issueRecoveryActions).set({
      evidence: sql`${issueRecoveryActions.evidence} || '{"workspaceRestoreFailure":"restore_unsafe_archive"}'::jsonb`,
    }).where(eq(issueRecoveryActions.sourceIssueId, s.issueId));
    expect(await getExecutionBlocker(db, s.companyId, s.issueId, { admittingAgentId: s.participantId }))
      .toMatchObject({ cause: HOLD_CAUSE });
    await heartbeatService(db).reconcileStrandedAssignedIssues();
    expect((await runsFor(s, s.participantId)).filter(run => run.status !== "succeeded")).toHaveLength(0);
  });

  const refusals: Array<[string, (s: Seeded) => Promise<unknown>]> = [
    ["a non-invokable participant", (s) => db.update(agents).set({ status: "paused" }).where(eq(agents.id, s.participantId))],
    ["an inactive company", (s) => db.update(companies).set({ status: "paused" }).where(eq(companies.id, s.companyId))],
    ["a budget-blocked participant", async (s) => {
      await db.insert(budgetPolicies).values({ companyId: s.companyId, scopeType: "agent", scopeId: s.participantId,
        windowKind: "lifetime", metric: "billed_cents", amount: 1, hardStopEnabled: true, isActive: true });
      await db.insert(costEvents).values({ companyId: s.companyId, agentId: s.participantId, provider: "test",
        model: "test-model", costCents: 500, occurredAt: new Date() });
    }],
  ];

  it.each(refusals)("does not re-admit the lost wake for %s", async (_label, refuse) => {
    const s = await seedRetainedHold(ROLE_PAIRS[1]);
    await refuse(s);
    await heartbeatService(db).reconcileStrandedAssignedIssues();
    expect((await runsFor(s, s.participantId)).filter(run => run.status !== "succeeded")).toHaveLength(0);
    expect((await wakesFor(s, s.participantId)).filter(row => row.id !== s.lostWakeId && row.runId)).toEqual([]);
  });

  const parkedRefusals: Array<[string, (s: Awaited<ReturnType<typeof seedRetainedHold>>) => Promise<unknown>]> = [
    ["a workspace repair hold", (s) => db.update(issueRecoveryActions).set({
      evidence: sql`${issueRecoveryActions.evidence} || '{"workspaceRestoreFailure":"restore_unsafe_archive"}'::jsonb`,
    }).where(eq(issueRecoveryActions.sourceIssueId, s.issueId))],
    ["a stage that is no longer current", (s) => db.update(issues)
      .set({ executionState: { ...s.executionState, currentStageId: randomUUID() } }).where(eq(issues.id, s.issueId))],
    ...refusals,
    ["an execution lock whose release promotes the parked wake", async (s) => {
      const [lockRun] = await db.insert(heartbeatRuns).values({
        companyId: s.companyId, agentId: s.executorId, status: "queued", runtimeMode: "legacy",
        invocationSource: "assignment", triggerDetail: "system",
        contextSnapshot: { issueId: randomUUID(), wakeReason: "issue_assigned" },
      }).returning();
      await db.update(issues).set({ executionRunId: lockRun!.id, executionLockedAt: new Date() })
        .where(eq(issues.id, s.issueId));
    }],
  ];

  it.each(parkedRefusals)("leaves a parked comment wake and the lost stage wake alone for %s", async (_label, refuse) => {
    const s = await seedRetainedHold(ROLE_PAIRS[0]);
    const deferred = await addParkedCommentWake(s);
    await refuse(s);
    await heartbeatService(db).reconcileStrandedAssignedIssues();
    expect((await runsFor(s, s.participantId)).filter(run => run.status !== "succeeded")).toHaveLength(0);
    expect((await wakesFor(s, s.participantId)).filter(row => row.id !== s.lostWakeId && row.id !== deferred.id)).toEqual([]);
    const [after] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, deferred.id));
    expect(after).toMatchObject({ status: "deferred_issue_execution", runId: null });
  });

  it("does not re-admit a lost wake for a stage that is no longer current", async () => {
    const s = await seedRetainedHold(ROLE_PAIRS[0]);
    await db.update(issues).set({ executionState: { ...s.executionState, currentStageId: randomUUID() } })
      .where(eq(issues.id, s.issueId));
    await heartbeatService(db).reconcileStrandedAssignedIssues();
    expect((await runsFor(s, s.participantId)).filter(run =>
      (run.contextSnapshot as Record<string, unknown>).source === "issue.execution_stage")).toHaveLength(0);
  });
});
