import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  budgetPolicies,
  costEvents,
  companies,
  companyMemberships,
  createDb,
  environmentLeases,
  heartbeatRuns,
  issues,
  issueTreeHolds,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
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
    summary: "Review stage wake test run.",
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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping review stage wake tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

const STAGE_WAKE_REASON = "execution_review_requested";

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    value = await read();
  }
  return value;
}

describeEmbeddedPostgres("review stage wake after the previous owner's run finalises", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-review-stage-owner-release-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
    mockAdapterExecute.mockClear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(companyId: string, agentActor: { agentId: string; runId: string }) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = {
        type: "agent",
        ...agentActor,
        companyId,
        source: "agent_jwt",
        companyIds: [companyId],
        memberships: [],
        isInstanceAdmin: false,
      };
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use(errorHandler);
    return testApp;
  }

  async function seed() {
    const companyId = randomUUID();
    const executorId = randomUUID();
    const reviewerId = randomUUID();
    const otherReviewerId = randomUUID();
    const issueId = randomUUID();
    const executorRunId = randomUUID();
    const stageId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Review Stage Co", issuePrefix: `R${companyId.slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const agentRow = (id: string, name: string) => ({
      id, companyId, name, role: "engineer", status: "idle", adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true } },
      permissions: { canCreateAgents: false, canAssignTasks: true },
    });
    await db.insert(agents).values([
      agentRow(executorId, "Executor"), agentRow(reviewerId, "Reviewer"), agentRow(otherReviewerId, "Other Reviewer"),
    ]);
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: "board-owner", status: "active", membershipRole: "owner",
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Hand off to review", status: "in_progress", priority: "medium",
      assigneeAgentId: executorId, createdByUserId: "board-owner",
      executionPolicy: {
        mode: "normal", commentRequired: false,
        stages: [{ id: stageId, type: "review", approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: reviewerId, userId: null }] }],
      },
    });
    // The executor's own live run. The hand-off PATCH stops it; its
    // environment lease is released later, by the run's own finalisation.
    const startedAt = new Date(Date.now() - 60_000);
    await db.insert(heartbeatRuns).values({
      id: executorRunId, companyId, agentId: executorId, status: "running", runtimeMode: "legacy",
      invocationSource: "assignment", triggerDetail: "system", startedAt,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      resultJson: { conversationContinuation: "continue_conversation_v1" },
    });
    await db.update(issues).set({ checkoutRunId: executorRunId, executionRunId: executorRunId,
      executionLockedAt: startedAt }).where(eq(issues.id, issueId));
    const [lease] = await db.insert(environmentLeases).values({
      companyId, heartbeatRunId: executorRunId, issueId, status: "active", provider: "local",
    }).returning();
    return { companyId, executorId, reviewerId, otherReviewerId, issueId, executorRunId, stageId, leaseId: lease!.id };
  }

  type Seeded = Awaited<ReturnType<typeof seed>>;

  async function handOffToReview(s: Seeded) {
    const res = await request(app(s.companyId, { agentId: s.executorId, runId: s.executorRunId }))
      .patch(`/api/issues/${s.issueId}`)
      .send({ status: "in_review", comment: "Ready for review." });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [issue] = await db.select().from(issues).where(eq(issues.id, s.issueId));
    expect(issue).toMatchObject({ status: "in_review", assigneeAgentId: s.reviewerId });
    expect(issue!.executionState).toMatchObject({ status: "pending", currentStageId: s.stageId,
      currentParticipant: { type: "agent", agentId: s.reviewerId } });
    return issue!;
  }

  const stageWakes = (s: Seeded, agentId: string) => db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, s.companyId), eq(agentWakeupRequests.agentId, agentId),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${s.issueId}`,
    sql`${agentWakeupRequests.payload}->'executionStage' is not null`,
  ));
  const agentRuns = (s: Seeded, agentId: string) => db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, s.companyId), eq(heartbeatRuns.agentId, agentId),
    sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${s.issueId}`,
  ));
  // Runs admitted from the stage wake itself. A reviewer run that ends without
  // a decision later gets the existing participant-recovery retry; that retry
  // is separate work and is not counted here.
  const stageRuns = async (s: Seeded, agentId: string) => (await agentRuns(s, agentId))
    .filter(run => (run.contextSnapshot as Record<string, unknown> | null)?.wakeReason === STAGE_WAKE_REASON && !run.retryOfRunId);
  const releaseLease = (s: Seeded) => db.update(environmentLeases)
    .set({ status: "released", releasedAt: new Date(), cleanupStatus: "success" })
    .where(eq(environmentLeases.id, s.leaseId));

  /** Hand off, then wait until the route's fire-and-forget stage wake has been decided. */
  async function handOffAndAwaitStageWake(s: Seeded) {
    await handOffToReview(s);
    const wakes = await waitFor(() => stageWakes(s, s.reviewerId), rows => rows.length > 0);
    expect(wakes).toHaveLength(1);
    return wakes[0]!;
  }

  it("keeps the participant's stage wake while the executor's run holds its lease, then admits it once", async () => {
    const s = await seed();
    const heartbeat = heartbeatService(db);
    const wake = await handOffAndAwaitStageWake(s);
    const [executorRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, s.executorRunId));
    expect(executorRun).toMatchObject({ status: "cancelled", errorCode: "issue_reassigned" });
    expect(await getExecutionBlocker(db, s.companyId, s.issueId)).toMatchObject({
      runId: s.executorRunId, cause: "execution_owner_active",
    });
    // Old behaviour: a terminal `skipped` receipt (reason
    // execution_reconciliation_required, error = blocker message) and no run.
    expect(wake).toMatchObject({ status: "deferred_issue_execution", reason: STAGE_WAKE_REASON, runId: null });
    expect(wake.payload).toMatchObject({ executionWait: { cause: "execution_owner_active", runId: s.executorRunId } });
    expect(await agentRuns(s, s.reviewerId)).toHaveLength(0);

    // Still blocked: a sweep keeps the wake and starts nothing.
    await heartbeat.resumeDeferredStageWakes({ companyId: s.companyId, issueId: s.issueId });
    expect((await stageWakes(s, s.reviewerId))[0]).toMatchObject({ status: "deferred_issue_execution" });
    expect(await agentRuns(s, s.reviewerId)).toHaveLength(0);

    await releaseLease(s);
    expect(await getExecutionBlocker(db, s.companyId, s.issueId)).toBeNull();
    // Concurrent resumes (cleanup hook and periodic sweep) admit exactly one run.
    await Promise.all([
      heartbeat.resumeDeferredStageWakes({ companyId: s.companyId, issueId: s.issueId }),
      heartbeat.resumeDeferredStageWakes({ companyId: s.companyId, issueId: s.issueId }),
      heartbeat.resumeQueuedRuns(),
    ]);
    const runs = await agentRuns(s, s.reviewerId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.contextSnapshot).toMatchObject({
      wakeReason: STAGE_WAKE_REASON, source: "issue.execution_stage",
      executionStage: { stageId: s.stageId, currentParticipant: { agentId: s.reviewerId } },
    });
    expect((await stageWakes(s, s.reviewerId))[0]).toMatchObject({ status: "coalesced", runId: runs[0]!.id });

    // Later sweeps do not admit it again.
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await heartbeat.resumeDeferredStageWakes({ companyId: s.companyId, issueId: s.issueId });
    await heartbeat.resumeQueuedRuns();
    expect(await stageRuns(s, s.reviewerId)).toHaveLength(1);
  });

  it("is admitted by the periodic sweep after the owner releases", async () => {
    const s = await seed();
    const heartbeat = heartbeatService(db);
    await handOffAndAwaitStageWake(s);
    await releaseLease(s);
    // Back-date the receipt so the bounded sweep's age gate selects it.
    await db.update(agentWakeupRequests).set({ updatedAt: new Date(Date.now() - 60_000) })
      .where(eq(agentWakeupRequests.agentId, s.reviewerId));
    await heartbeat.resumeQueuedRuns();
    expect(await agentRuns(s, s.reviewerId)).toHaveLength(1);
  });

  it("does not admit a stale stage wake after the participant changed", async () => {
    const s = await seed();
    const heartbeat = heartbeatService(db);
    const issue = await handOffAndAwaitStageWake(s).then(() => db.select().from(issues).where(eq(issues.id, s.issueId)).then(r => r[0]!));
    await db.update(issues).set({
      assigneeAgentId: s.otherReviewerId,
      executionState: { ...(issue.executionState as Record<string, unknown>),
        currentParticipant: { type: "agent", agentId: s.otherReviewerId } },
    }).where(eq(issues.id, s.issueId));
    await releaseLease(s);
    await heartbeat.resumeDeferredStageWakes({ companyId: s.companyId, issueId: s.issueId });
    expect(await agentRuns(s, s.reviewerId)).toHaveLength(0);
    expect((await stageWakes(s, s.reviewerId))[0]).toMatchObject({ status: "cancelled", runId: null });
  });

  it("does not admit a stale stage wake after the stage was decided", async () => {
    const s = await seed();
    const heartbeat = heartbeatService(db);
    await handOffAndAwaitStageWake(s);
    await db.update(issues).set({
      status: "done", assigneeAgentId: s.executorId,
      executionState: { status: "completed", currentStageId: null, currentStageIndex: null, currentStageType: null,
        currentParticipant: null, returnAssignee: null, reviewRequest: null, completedStageIds: [s.stageId],
        lastDecisionId: randomUUID(), lastDecisionOutcome: "approved" },
    }).where(eq(issues.id, s.issueId));
    await releaseLease(s);
    await heartbeat.resumeDeferredStageWakes({ companyId: s.companyId, issueId: s.issueId });
    expect(await agentRuns(s, s.reviewerId)).toHaveLength(0);
    expect((await stageWakes(s, s.reviewerId))[0]).toMatchObject({ status: "cancelled" });
  });

  it("does not admit a stage wake for a cancelled task", async () => {
    const s = await seed();
    const heartbeat = heartbeatService(db);
    await handOffAndAwaitStageWake(s);
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, s.issueId));
    await releaseLease(s);
    await heartbeat.resumeDeferredStageWakes({ companyId: s.companyId, issueId: s.issueId });
    expect(await agentRuns(s, s.reviewerId)).toHaveLength(0);
    expect((await stageWakes(s, s.reviewerId))[0]).toMatchObject({ status: "cancelled" });
  });

  it("ends a kept wake without a run when the participant is paused at resume", async () => {
    const s = await seed();
    const heartbeat = heartbeatService(db);
    await handOffAndAwaitStageWake(s);
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, s.reviewerId));
    await releaseLease(s);
    await heartbeat.resumeDeferredStageWakes({ companyId: s.companyId, issueId: s.issueId });
    expect(await agentRuns(s, s.reviewerId)).toHaveLength(0);
    // The refusal is final and visible, exactly as for a fresh stage wake.
    expect((await stageWakes(s, s.reviewerId))[0]).toMatchObject({ status: "skipped", reason: "agent.not_invokable" });
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, s.reviewerId));
    await heartbeat.resumeDeferredStageWakes({ companyId: s.companyId, issueId: s.issueId });
    expect(await agentRuns(s, s.reviewerId)).toHaveLength(0);
  });

  it("keeps the wake while the previous owner still holds a lease", async () => {
    const s = await seed();
    const heartbeat = heartbeatService(db);
    await handOffAndAwaitStageWake(s);
    await releaseLease(s);
    // A second, still-held lease stands in for an owner that is still cleaning up.
    await db.insert(environmentLeases).values({ companyId: s.companyId, heartbeatRunId: s.executorRunId,
      issueId: s.issueId, status: "active", provider: "local" });
    await heartbeat.resumeDeferredStageWakes({ companyId: s.companyId, issueId: s.issueId });
    expect(await agentRuns(s, s.reviewerId)).toHaveLength(0);
    expect((await stageWakes(s, s.reviewerId))[0]).toMatchObject({ status: "deferred_issue_execution" });
  });

  it("does not admit a kept wake while the task tree is paused", async () => {
    const s = await seed();
    const heartbeat = heartbeatService(db);
    await handOffAndAwaitStageWake(s);
    await db.insert(issueTreeHolds).values({ companyId: s.companyId, rootIssueId: s.issueId, mode: "pause",
      status: "active", reason: "Paused for investigation" });
    await releaseLease(s);
    await heartbeat.resumeDeferredStageWakes({ companyId: s.companyId, issueId: s.issueId });
    expect(await agentRuns(s, s.reviewerId)).toHaveLength(0);
    expect((await stageWakes(s, s.reviewerId))[0]).toMatchObject({ status: "skipped", reason: "issue_tree_hold_active" });
  });

  it("does not start a second run when the participant already has one for the task", async () => {
    const s = await seed();
    const heartbeat = heartbeatService(db);
    await handOffAndAwaitStageWake(s);
    const [existing] = await db.insert(heartbeatRuns).values({
      companyId: s.companyId, agentId: s.reviewerId, status: "queued", runtimeMode: "legacy",
      invocationSource: "automation", triggerDetail: "system",
      contextSnapshot: { issueId: s.issueId, taskId: s.issueId, wakeReason: "issue_commented" },
    }).returning();
    await releaseLease(s);
    await heartbeat.resumeDeferredStageWakes({ companyId: s.companyId, issueId: s.issueId });
    const runs = await agentRuns(s, s.reviewerId);
    expect(runs.map(run => run.id)).toEqual([existing!.id]);
    expect((await stageWakes(s, s.reviewerId))[0]).toMatchObject({ status: "coalesced", runId: existing!.id });
  });

  it("leaves a not-invokable refusal unchanged", async () => {
    const s = await seed();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, s.reviewerId));
    await handOffToReview(s);
    const wakes = await waitFor(() => stageWakes(s, s.reviewerId), rows => rows.length > 0);
    // Refused before the execution gate: still a terminal refusal, not a kept wake.
    expect(wakes.map(wake => [wake.status, wake.reason])).toEqual([["skipped", "agent.not_invokable"]]);
    await releaseLease(s);
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, s.reviewerId));
    await heartbeatService(db).resumeDeferredStageWakes({ companyId: s.companyId, issueId: s.issueId });
    expect(await agentRuns(s, s.reviewerId)).toHaveLength(0);
  });

  it("leaves a budget refusal unchanged", async () => {
    const s = await seed();
    await db.insert(budgetPolicies).values({ companyId: s.companyId, scopeType: "agent", scopeId: s.reviewerId,
      windowKind: "lifetime", metric: "billed_cents", amount: 1, hardStopEnabled: true, isActive: true });
    await db.insert(costEvents).values({ companyId: s.companyId, agentId: s.reviewerId, provider: "test",
      model: "test-model", costCents: 500, occurredAt: new Date() });
    await handOffToReview(s);
    const wakes = await waitFor(() => stageWakes(s, s.reviewerId), rows => rows.length > 0);
    expect(wakes.map(wake => [wake.status, wake.reason])).toEqual([["skipped", "budget.blocked"]]);
    await releaseLease(s);
    await heartbeatService(db).resumeDeferredStageWakes({ companyId: s.companyId, issueId: s.issueId });
    expect(await agentRuns(s, s.reviewerId)).toHaveLength(0);
  });
});
