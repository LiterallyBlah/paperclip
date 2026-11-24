import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  authUsers,
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
    summary: "No-replay hold test run.",
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
  console.warn(`Skipping no-replay hold wake tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

const HOLD_CAUSE = "legacy_execution_requires_reconciliation";

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    value = await read();
  }
  return value;
}

describeEmbeddedPostgres("a settled no-replay hold blocks only replay of its lost run", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-no-replay-hold-new-wakes-");
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

  const boardUser = (companyId: string) => `board-${companyId}`;

  function app(companyId: string) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = {
        type: "board", userId: boardUser(companyId), companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        isInstanceAdmin: false, source: "session",
      };
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any));
    testApp.use(errorHandler);
    return testApp;
  }

  /**
   * Agent A's legacy run was lost and settled as a resolved no-replay hold.
   * No run holds the task. A message saved while the lost run was live is
   * still deferred behind the hold.
   */
  async function seed() {
    const companyId = randomUUID();
    const agentA = randomUUID();
    const agentB = randomUUID();
    const issueId = randomUUID();
    const lostRunId = randomUUID();
    const originalWakeId = randomUUID();
    const issuePrefix = `N${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId, name: "Hold Co", issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    const agentRow = (id: string, name: string) => ({
      id, companyId, name, role: "engineer", status: "idle", adapterType: "process",
      adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true } },
      permissions: { canCreateAgents: false, canAssignTasks: true },
    });
    await db.insert(agents).values([agentRow(agentA, "Alpha"), agentRow(agentB, "Bravo")]);
    const userId = boardUser(companyId);
    await db.insert(authUsers).values({ id: userId, name: "Fixture owner", email: `${userId}@example.test`,
      createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner",
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Lost run task", status: "in_progress", priority: "medium",
      assigneeAgentId: agentA, createdByUserId: userId, issueNumber: 1, identifier: `${issuePrefix}-1`,
    });
    const lostAt = new Date(Date.now() - 10 * 60_000);
    const heldAt = new Date(Date.now() - 5 * 60_000);
    await db.insert(agentWakeupRequests).values({
      id: originalWakeId, companyId, agentId: agentA, source: "assignment", triggerDetail: "system",
      reason: "issue_assigned", status: "failed", runId: lostRunId,
      requestedAt: lostAt, createdAt: lostAt, updatedAt: heldAt, finishedAt: heldAt,
      payload: { issueId },
    });
    await db.insert(heartbeatRuns).values({
      id: lostRunId, companyId, agentId: agentA, status: "failed", runtimeMode: "legacy",
      errorCode: "process_lost", error: "Process lost", invocationSource: "assignment", triggerDetail: "system",
      wakeupRequestId: originalWakeId, startedAt: lostAt, finishedAt: heldAt, createdAt: lostAt, updatedAt: heldAt,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
    });
    const [hold] = await db.insert(issueRecoveryActions).values({
      companyId, sourceIssueId: issueId, kind: "active_run_watchdog", status: "resolved",
      outcome: "blocked", ownerType: "board", returnOwnerAgentId: agentA, cause: HOLD_CAUSE,
      fingerprint: `legacy-execution:${lostRunId}`, attemptCount: 1, maxAttempts: 3,
      evidence: { runId: lostRunId, attempt: 1, adapterRecovery: "unsupported_or_unknown",
        originalFailureCode: "process_lost",
        automaticRecovery: { runId: lostRunId, policy: "preserve_without_replay_v1", replay: "blocked",
          actionOutcome: "unknown", recordedAt: heldAt.toISOString() } },
      nextAction: "Automatic recovery stopped.", resolvedAt: heldAt, lastAttemptAt: heldAt,
      createdAt: heldAt, updatedAt: heldAt,
    }).returning();
    // A user message saved while the lost run was live. It is input, not a
    // replay, so the next run on the task may deliver it.
    const savedAt = new Date(Date.now() - 8 * 60_000);
    const [savedComment] = await db.insert(issueComments).values({
      companyId, issueId, authorUserId: userId, authorType: "user",
      body: "Note sent while the lost run was working.", createdAt: savedAt, updatedAt: savedAt,
    }).returning();
    const [savedWake] = await db.insert(agentWakeupRequests).values({
      companyId, agentId: agentA, source: "automation", triggerDetail: "system",
      reason: "issue_commented", status: "deferred_issue_execution",
      requestedByActorType: "user", requestedByActorId: userId,
      requestedAt: savedAt, createdAt: savedAt, updatedAt: savedAt,
      payload: withQueuedCommentIdsInWakePayload({ issueId, mutation: "comment", commentId: savedComment!.id,
        executionWait: { recoveryActionId: hold!.id, reason: "execution_recovery",
          message: "Waiting for execution recovery. Your message is saved." } }, [savedComment!.id]),
    }).returning();
    // A continuation of the lost run itself. It must never run.
    const [heldWake] = await db.insert(agentWakeupRequests).values({
      companyId, agentId: agentA, source: "automation", triggerDetail: "system",
      reason: "run_liveness_continuation", status: "deferred_issue_execution",
      requestedAt: heldAt, createdAt: heldAt, updatedAt: heldAt,
      payload: { issueId, executionWait: { recoveryActionId: hold!.id, reason: "execution_recovery",
          message: "Waiting for execution recovery." },
        _paperclipWakeContext: { issueId, taskId: issueId, wakeReason: "run_liveness_continuation", previousRunId: lostRunId } },
    }).returning();
    return { companyId, agentA, agentB, issueId, lostRunId, originalWakeId, hold: hold!,
      savedWakeId: savedWake!.id, savedCommentId: savedComment!.id, heldWakeId: heldWake!.id, heldAt };
  }

  type Seeded = Awaited<ReturnType<typeof seed>>;

  const runsFor = (s: Seeded, agentId: string) => db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, s.companyId), eq(heartbeatRuns.agentId, agentId),
    sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${s.issueId}`,
  ));
  const newRunsFor = async (s: Seeded, agentId: string) =>
    (await runsFor(s, agentId)).filter(run => run.id !== s.lostRunId);
  const wakeRow = async (id: string) => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id)))[0]!;

  async function comment(s: Seeded, body: string) {
    const res = await request(app(s.companyId)).post(`/api/issues/${s.issueId}/comments`).send({ body });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string };
  }

  /** The lost run is never replayed: no retry of it, and its original and saved wakes stay put. */
  async function expectNoReplay(s: Seeded) {
    const all = [...await runsFor(s, s.agentA), ...await runsFor(s, s.agentB)];
    expect(all.filter(run => run.retryOfRunId === s.lostRunId)).toEqual([]);
    expect(all.filter(run => run.wakeupRequestId === s.originalWakeId).map(run => run.id)).toEqual([s.lostRunId]);
    expect(all.filter(run => (run.contextSnapshot as Record<string, unknown>).previousRunId === s.lostRunId)).toEqual([]);
    expect((await runsFor(s, s.agentA)).find(run => run.id === s.lostRunId)).toMatchObject({ status: "failed" });
    expect(await wakeRow(s.originalWakeId)).toMatchObject({ status: "failed", runId: s.lostRunId });
    expect(await wakeRow(s.heldWakeId)).toMatchObject({ status: "deferred_issue_execution", runId: null });
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, s.hold.id)))
      .toEqual([s.hold]);
  }

  it("(1) a new user comment for the lost run's own agent gives that agent one run", async () => {
    const s = await seed();
    const posted = await comment(s, "Please carry on with the task.");
    const runs = await waitFor(() => newRunsFor(s, s.agentA), rows => rows.length > 0);
    expect(runs).toHaveLength(1);
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    const settled = await newRunsFor(s, s.agentA);
    expect(settled.map(run => [run.status, run.retryOfRunId])).toEqual([["succeeded", null]]);
    expect(settled[0]!.contextSnapshot).toMatchObject({ wakeCommentId: posted.id });
    // The message saved before the hold is delivered with it.
    expect((settled[0]!.contextSnapshot as Record<string, unknown>).wakeCommentIds)
      .toEqual(expect.arrayContaining([posted.id, s.savedCommentId]));
    await expectNoReplay(s);
  });

  it("(1b) a comment saved behind the agent's own newer run is promoted when that run releases", async () => {
    const s = await seed();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    mockAdapterExecute.mockImplementationOnce(async () => {
      await gate;
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null,
        summary: "Gated run.", provider: "test", model: "test-model" };
    });
    const first = await comment(s, "First message after the hold.");
    await waitFor(() => newRunsFor(s, s.agentA), rows => rows.some(run => run.status === "running"));
    // Deferred behind the live run's execution lock, not behind the hold.
    const second = await comment(s, "Second message while the first run works.");
    await new Promise(resolve => setTimeout(resolve, 200));
    release();
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    const runs = await newRunsFor(s, s.agentA);
    expect(runs.map(run => run.status)).toEqual(["succeeded", "succeeded"]);
    const delivered = runs.flatMap(run => {
      const context = run.contextSnapshot as Record<string, unknown>;
      return [context.wakeCommentId, ...((context.wakeCommentIds as unknown[] | undefined) ?? [])];
    });
    expect(delivered).toEqual(expect.arrayContaining([first.id, second.id]));
    await expectNoReplay(s);
  });

  it("(2) a new user comment for another agent gives that agent one run", async () => {
    const s = await seed();
    // The task moved to agent B after A's run was lost.
    await db.update(issues).set({ assigneeAgentId: s.agentB }).where(eq(issues.id, s.issueId));
    const posted = await comment(s, "Please pick this up.");
    const runs = await waitFor(() => newRunsFor(s, s.agentB), rows => rows.length > 0);
    expect(runs).toHaveLength(1);
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    const settled = await newRunsFor(s, s.agentB);
    expect(settled.map(run => [run.status, run.retryOfRunId])).toEqual([["succeeded", null]]);
    expect(settled[0]!.contextSnapshot).toMatchObject({ wakeCommentId: posted.id });
    expect(await newRunsFor(s, s.agentA)).toEqual([]);
    await expectNoReplay(s);
  });

  it("(3) the hold still blocks the lost run's own wakes, retries and continuations", async () => {
    const s = await seed();
    // Whole-task callers that do not name a wake keep today's behaviour.
    expect(await getExecutionBlocker(db, s.companyId, s.issueId)).toMatchObject({
      cause: HOLD_CAUSE, runId: s.lostRunId, recoveryActionId: s.hold.id });
    // The lost run's own wake, a retry of the lost run, and a continuation
    // of it are all still held.
    for (const wake of [
      { wakeId: s.originalWakeId, sourceRunIds: [] },
      { wakeId: null, sourceRunIds: [s.lostRunId] },
      { wakeId: s.heldWakeId, sourceRunIds: [s.lostRunId] },
    ]) {
      expect(await getExecutionBlocker(db, s.companyId, s.issueId, { admittingAgentId: s.agentA, wake }))
        .toMatchObject({ cause: HOLD_CAUSE, runId: s.lostRunId });
    }
    // A newer, unrelated wake is not held, for either agent.
    for (const agentId of [s.agentA, s.agentB]) {
      expect(await getExecutionBlocker(db, s.companyId, s.issueId,
        { admittingAgentId: agentId, wake: { wakeId: null, sourceRunIds: [] } })).toBeNull();
    }
    // The periodic stranded-work sweeps promote nothing the hold covers.
    const heartbeat = heartbeatService(db);
    await heartbeat.reconcileStrandedAssignedIssues();
    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    // A sweep may deliver the saved user message; that is a new turn.
    expect((await newRunsFor(s, s.agentA)).map(run => run.retryOfRunId)).not.toContain(s.lostRunId);
    await expectNoReplay(s);
  });

  it("(4) a paused agent's new wake stays deferred", async () => {
    const s = await seed();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, s.agentA));
    await comment(s, "Please carry on with the task.");
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    expect(await newRunsFor(s, s.agentA)).toEqual([]);
    await expectNoReplay(s);
  });
});
