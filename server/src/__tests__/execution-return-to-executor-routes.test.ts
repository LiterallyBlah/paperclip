import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, asc, eq, sql } from "drizzle-orm";
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
  issueComments,
  issueExecutionDecisions,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { companyRoutes } from "../routes/companies.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
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
    summary: "Return to executor test run.",
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
  console.warn(`Skipping return-to-executor route tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

type Actor = Record<string, unknown>;
type AgentKey = "developer" | "reviewer" | "delegate" | "other" | "manager";

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    value = await read();
  }
  return value;
}

describeEmbeddedPostgres("return to executor (routes, real database)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-return-to-executor-");
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

  function app(actor: Actor) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    testApp.use("/api/companies", companyRoutes(db, {} as any));
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use(errorHandler);
    return testApp;
  }

  const boardActor = (companyId: string, userId: string, extra: Actor = {}): Actor => ({
    type: "board", userId, source: "session", companyIds: [companyId], isInstanceAdmin: false,
    memberships: [{ companyId, status: "active", membershipRole: "owner" }], ...extra,
  });
  const agentActor = (companyId: string, agentId: string, runId: string): Actor => ({
    type: "agent", agentId, runId, companyId, source: "agent_jwt",
    companyIds: [companyId], memberships: [], isInstanceAdmin: false,
  });

  async function seed(options: { returnAssignee?: "agent" | "user"; changesRequestedCount?: number } = {}) {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const ids: Record<AgentKey | "foreign", string> = {
      developer: randomUUID(), reviewer: randomUUID(), delegate: randomUUID(), other: randomUUID(),
      manager: randomUUID(), foreign: randomUUID(),
    };
    const issueId = randomUUID();
    const stageId = randomUUID();
    const decisionIds = [randomUUID(), randomUUID()];
    const ownerUserId = `owner-${companyId}`;
    const viewerUserId = `viewer-${companyId}`;
    const implementerUserId = `implementer-${companyId}`;
    const foreignUserId = `foreign-${companyId}`;
    for (const [id, prefix] of [[companyId, "R"], [otherCompanyId, "X"]] as const) {
      await db.insert(companies).values({
        id, name: `${prefix} Co`, issuePrefix: `${prefix}${id.slice(0, 5).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
    }
    const agentRow = (id: string, name: string, role: string, extra: Record<string, unknown> = {}) => ({
      id, companyId, name, role, status: "idle", adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true } },
      permissions: { canCreateAgents: false, canAssignTasks: true }, ...extra,
    });
    await db.insert(agents).values([
      agentRow(ids.developer, "Developer", "engineer"),
      agentRow(ids.reviewer, "Reviewer", "qa"),
      agentRow(ids.delegate, "Delegate", "ceo"),
      agentRow(ids.other, "Other", "engineer"),
      agentRow(ids.manager, "Manager", "cto"),
      agentRow(ids.foreign, "Foreign", "engineer", { companyId: otherCompanyId }),
    ]);
    for (const userId of [ownerUserId, viewerUserId, implementerUserId, foreignUserId]) {
      await db.insert(authUsers).values({ id: userId, name: userId, email: `${userId}@example.test`,
        createdAt: new Date(), updatedAt: new Date() });
    }
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: ownerUserId, status: "active", membershipRole: "owner" },
      { companyId, principalType: "user", principalId: viewerUserId, status: "active", membershipRole: "viewer" },
      { companyId, principalType: "user", principalId: implementerUserId, status: "active", membershipRole: "member" },
      { companyId: otherCompanyId, principalType: "user", principalId: foreignUserId, status: "active", membershipRole: "owner" },
    ]);
    const userReturn = options.returnAssignee === "user";
    const returnAssignee = userReturn
      ? { type: "user", agentId: null, userId: implementerUserId }
      : { type: "agent", agentId: ids.developer, userId: null };
    const changesRequestedCount = options.changesRequestedCount ?? 2;
    const executionState = {
      status: "pending", currentStageId: stageId, currentStageIndex: 0, currentStageType: "review",
      currentParticipant: { type: "agent", agentId: ids.reviewer, userId: null },
      returnAssignee,
      reviewRequest: { instructions: "Review the candidate." }, completedStageIds: [],
      lastDecisionId: changesRequestedCount > 0 ? decisionIds[1] : null,
      lastDecisionOutcome: changesRequestedCount > 0 ? "changes_requested" : null,
      monitor: null, changesRequestedCount,
    };
    const executionPolicy = {
      mode: "normal", commentRequired: true, maxReviewRounds: 3,
      stages: [{ id: stageId, type: "review", approvalsNeeded: 1,
        participants: [{ id: randomUUID(), type: "agent", agentId: ids.reviewer, userId: null }] }],
    };
    await db.insert(issues).values({
      id: issueId, companyId, title: "Pending agent review", status: "in_review", priority: "high",
      assigneeAgentId: ids.reviewer, createdByAgentId: ids.manager, executionPolicy, executionState,
      assigneeAdapterOverrides: { modelProfile: "cheap" },
    });
    if (changesRequestedCount > 0) {
      for (const [index, decisionId] of decisionIds.entries()) {
        await db.insert(issueExecutionDecisions).values({
          id: decisionId, companyId, issueId, stageId, stageType: "review", actorAgentId: ids.reviewer,
          outcome: "changes_requested", body: `Reviewer pass ${index + 1}`,
          createdAt: new Date(Date.now() - (3 - index) * 60_000),
        });
      }
    }
    // Each agent acts from its own run on some other work; none is the issue's
    // checkout or execution run.
    const runs: Record<string, string> = {};
    for (const key of ["developer", "reviewer", "delegate", "other", "manager"] as const) {
      runs[key] = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runs[key], companyId, agentId: ids[key], status: "running", runtimeMode: "legacy",
        invocationSource: "assignment", triggerDetail: "system", startedAt: new Date(),
        contextSnapshot: { wakeReason: "issue_assigned" },
      });
    }
    const as = {
      board: () => app(boardActor(companyId, ownerUserId)),
      viewer: () => app(boardActor(companyId, viewerUserId, {
        memberships: [{ companyId, status: "active", membershipRole: "viewer" }] })),
      mcp: () => app(boardActor(companyId, ownerUserId, { source: "mcp_oauth" })),
      implementerUser: () => app(boardActor(companyId, implementerUserId, {
        memberships: [{ companyId, status: "active", membershipRole: "member" }] })),
      foreignBoard: () => app(boardActor(otherCompanyId, foreignUserId, {
        memberships: [{ companyId: otherCompanyId, status: "active", membershipRole: "owner" }] })),
      foreignAgent: () => app(agentActor(otherCompanyId, ids.foreign, randomUUID())),
      agent: (key: AgentKey) => app(agentActor(companyId, ids[key], runs[key]!)),
    };
    return {
      companyId, otherCompanyId, ids, runs, issueId, stageId, decisionIds, ownerUserId, implementerUserId,
      executionState, executionPolicy, returnAssignee, as,
    };
  }

  type Seeded = Awaited<ReturnType<typeof seed>>;

  const url = (s: Seeded) => `/api/issues/${s.issueId}/execution/return-to-executor`;
  const body = (s: Seeded, extra: Record<string, unknown> = {}) => ({
    reason: "Returning to the implementer: the review needs a rebased candidate.",
    expectedStageId: s.stageId,
    ...extra,
  });
  const readIssue = async (s: Seeded) => (await db.select().from(issues).where(eq(issues.id, s.issueId)))[0]!;
  const decisions = (s: Seeded) => db.select().from(issueExecutionDecisions)
    .where(eq(issueExecutionDecisions.issueId, s.issueId)).orderBy(asc(issueExecutionDecisions.createdAt));
  const comments = (s: Seeded) => db.select().from(issueComments).where(eq(issueComments.issueId, s.issueId));
  const returnActivity = (s: Seeded) => db.select().from(activityLog).where(and(
    eq(activityLog.entityId, s.issueId), eq(activityLog.action, "issue.execution_returned_to_executor")));
  /** Everything a refusal must leave untouched. */
  const snapshot = async (s: Seeded) => {
    const { updatedAt: _updatedAt, ...issue } = await readIssue(s);
    return {
      issue,
      decisions: (await decisions(s)).map((row) => row.id),
      comments: (await comments(s)).length,
      activity: (await returnActivity(s)).length,
    };
  };
  const setDelegate = (s: Seeded, agentId: string | null) =>
    request(s.as.board()).put(`/api/companies/${s.companyId}/review-escalation-delegate`).send({ agentId });
  async function checkOutFor(s: Seeded, key: AgentKey) {
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    s.runs[key] = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: s.runs[key], companyId: s.companyId, agentId: s.ids[key], status: "running", runtimeMode: "legacy",
      invocationSource: "assignment", triggerDetail: "system", startedAt: new Date(),
      contextSnapshot: { issueId: s.issueId, taskId: s.issueId, wakeReason: "issue_assigned" },
    });
    await db.update(issues).set({ checkoutRunId: s.runs[key]!, executionRunId: s.runs[key]!, executionLockedAt: new Date() })
      .where(eq(issues.id, s.issueId));
  }

  it("board: returns the stage with the cycle kept, audits, comments and wakes the return assignee", async () => {
    const s = await seed();
    const before = await readIssue(s);

    const res = await request(s.as.board()).post(url(s)).send(body(s, { expectedChangesRequestedCount: 2 }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ wakeQueued: true, issue: { id: s.issueId, status: "in_progress" } });

    const after = await readIssue(s);
    expect(after).toMatchObject({ status: "in_progress", assigneeAgentId: s.ids.developer, assigneeUserId: null });
    expect(after.executionState).toEqual({ ...s.executionState, status: "changes_requested", reviewRequest: null });
    // Policy byte-identical; overrides untouched; no decision row.
    expect(JSON.stringify(after.executionPolicy)).toBe(JSON.stringify(before.executionPolicy));
    expect(after.assigneeAdapterOverrides).toEqual(before.assigneeAdapterOverrides);
    expect((await decisions(s)).map((row) => row.id)).toEqual(s.decisionIds);

    const [activity] = await returnActivity(s);
    expect(activity).toMatchObject({
      actorType: "user", actorId: s.ownerUserId,
      details: expect.objectContaining({
        stageId: s.stageId, changesRequestedCount: 2,
        previousParticipant: { type: "agent", agentId: s.ids.reviewer, userId: null },
        returnAssignee: s.returnAssignee,
        reason: body(s).reason,
      }),
    });
    const [comment] = await comments(s);
    expect(comment).toMatchObject({ body: body(s).reason, authorUserId: s.ownerUserId, authorAgentId: null });
    expect(res.body.commentId).toBe(comment!.id);

    const wakes = await waitFor(() => db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.agentId, s.ids.developer),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${s.issueId}`)), (rows) => rows.length > 0);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      source: "assignment",
      idempotencyKey: `execution-return-to-executor:${s.issueId}:${s.stageId}:2`,
    });
    expect(wakes[0]!.payload).toMatchObject({
      issueId: s.issueId,
      executionStage: { stageId: s.stageId, wakeRole: "executor" },
    });

    // Resubmission re-pends the same stage, participant and count.
    await checkOutFor(s, "developer");
    const resubmit = await request(s.as.agent("developer")).patch(`/api/issues/${s.issueId}`)
      .send({ status: "in_review", comment: "Rebased candidate ready." });
    expect(resubmit.status, JSON.stringify(resubmit.body)).toBe(200);
    let issue = await readIssue(s);
    expect(issue).toMatchObject({ status: "in_review", assigneeAgentId: s.ids.reviewer });
    expect(issue.executionState).toMatchObject({
      status: "pending", currentStageId: s.stageId, changesRequestedCount: 2,
      currentParticipant: { type: "agent", agentId: s.ids.reviewer, userId: null },
    });
    expect((await decisions(s)).map((row) => row.id)).toEqual(s.decisionIds);

    // The reviewer's next request for changes counts 3 of 3 and escalates as today.
    await checkOutFor(s, "reviewer");
    const changes = await request(s.as.agent("reviewer")).patch(`/api/issues/${s.issueId}`)
      .send({ status: "in_progress", comment: "Reviewer pass 3: changes requested." });
    expect(changes.status, JSON.stringify(changes.body)).toBe(200);
    issue = await readIssue(s);
    expect(issue).toMatchObject({ status: "in_review", assigneeAgentId: s.ids.manager });
    expect(issue.executionState).toMatchObject({
      status: "pending", currentStageId: s.stageId, changesRequestedCount: 3,
      escalationHolder: { type: "agent", agentId: s.ids.manager, userId: null },
    });
    expect(await decisions(s)).toHaveLength(3);

    // An escalation hold cannot be returned this way.
    const held = await request(s.as.board()).post(url(s)).send(body(s));
    expect(held.status, JSON.stringify(held.body)).toBe(422);
    expect(held.body.details).toMatchObject({ code: "execution_return_refused", reason: "escalation_hold" });
  });

  it("delegate: returns a count-0 stage to a user return assignee without waking an agent", async () => {
    const s = await seed({ returnAssignee: "user", changesRequestedCount: 0 });
    expect((await setDelegate(s, s.ids.delegate)).status).toBe(200);

    const res = await request(s.as.agent("delegate")).post(url(s)).send(body(s, { expectedChangesRequestedCount: 0 }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.wakeQueued).toBe(false);
    const after = await readIssue(s);
    expect(after).toMatchObject({ status: "in_progress", assigneeAgentId: null, assigneeUserId: s.implementerUserId });
    expect(after.executionState).toEqual({ ...s.executionState, status: "changes_requested", reviewRequest: null });
    expect(await decisions(s)).toHaveLength(0);
    const [activity] = await returnActivity(s);
    expect(activity).toMatchObject({ actorType: "agent", actorId: s.ids.delegate, agentId: s.ids.delegate });
    const [comment] = await comments(s);
    expect(comment).toMatchObject({ authorAgentId: s.ids.delegate, body: body(s).reason });

    // The user return assignee, even with board write access, cannot use it.
    await db.update(issues).set({ status: "in_review", assigneeUserId: null, assigneeAgentId: s.ids.reviewer,
      executionState: s.executionState }).where(eq(issues.id, s.issueId));
    const self = await request(s.as.implementerUser()).post(url(s)).send(body(s));
    expect(self.status, JSON.stringify(self.body)).toBe(403);
    expect(self.body.details).toMatchObject({ reason: "actor_is_return_assignee" });
    expect((await request(s.as.agent("delegate")).post(url(s)).send(body(s))).status).toBe(200);

    // The user resubmits: same stage, participant, count 0.
    const resubmit = await request(s.as.implementerUser()).patch(`/api/issues/${s.issueId}`)
      .send({ status: "in_review" });
    expect(resubmit.status, JSON.stringify(resubmit.body)).toBe(200);
    expect((await readIssue(s)).executionState).toMatchObject({
      status: "pending", currentStageId: s.stageId, changesRequestedCount: 0,
      currentParticipant: { type: "agent", agentId: s.ids.reviewer, userId: null },
    });
  });

  it("refuses everyone else with no state change", async () => {
    const s = await seed();
    const before = await snapshot(s);
    const expectRefused = async (app: express.Express, status: number) => {
      const res = await request(app).post(url(s)).send(body(s));
      expect(res.status, JSON.stringify(res.body)).toBe(status);
      expect(await snapshot(s)).toEqual(before);
      return res;
    };

    // No delegate configured: every agent is refused.
    for (const key of ["developer", "reviewer", "other", "delegate", "manager"] as const) {
      await expectRefused(s.as.agent(key), 403);
    }
    expect((await setDelegate(s, s.ids.delegate)).status).toBe(200);
    for (const key of ["developer", "reviewer", "other", "manager"] as const) {
      const res = await expectRefused(s.as.agent(key), 403);
      expect(res.body.details).toMatchObject({ code: "execution_return_forbidden" });
    }
    await expectRefused(s.as.viewer(), 403);
    await expectRefused(s.as.mcp(), 403);
    await expectRefused(s.as.foreignBoard(), 404);
    await expectRefused(s.as.foreignAgent(), 404);

    // A delegate that is the return assignee is refused.
    expect((await setDelegate(s, s.ids.developer)).status).toBe(200);
    const res = await expectRefused(s.as.agent("developer"), 403);
    expect(res.body.details).toMatchObject({ reason: "delegate_is_return_assignee" });
  });

  it("refuses unmet preconditions with a stable code and no state change", async () => {
    const s = await seed();
    const before = await snapshot(s);
    const post = async (payload: Record<string, unknown>, status: number) => {
      const res = await request(s.as.board()).post(url(s)).send(payload);
      expect(res.status, JSON.stringify(res.body)).toBe(status);
      expect(await snapshot(s)).toEqual(before);
      return res.body;
    };

    expect((await post(body(s, { expectedStageId: randomUUID() }), 409)).details)
      .toMatchObject({ code: "execution_return_stale", reason: "stage_mismatch" });
    expect((await post(body(s, { expectedChangesRequestedCount: 1 }), 409)).details)
      .toMatchObject({ code: "execution_return_stale", reason: "count_mismatch" });
    await post(body(s, { reason: "   " }), 400);
    await post({ expectedStageId: s.stageId }, 400);
    await post(body(s, { executionState: {} }), 400);

    // A live execution run on the issue.
    const liveRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: liveRunId, companyId: s.companyId, agentId: s.ids.reviewer, status: "running", runtimeMode: "legacy",
      invocationSource: "assignment", triggerDetail: "system", startedAt: new Date(),
      contextSnapshot: { issueId: s.issueId, taskId: s.issueId },
    });
    await db.update(issues).set({ executionRunId: liveRunId }).where(eq(issues.id, s.issueId));
    const live = await request(s.as.board()).post(url(s)).send(body(s));
    expect(live.status, JSON.stringify(live.body)).toBe(409);
    expect(live.body.details).toMatchObject({ code: "execution_return_live_run", runId: liveRunId });
    // A finished run does not block.
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, liveRunId));
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, s.issueId));
    const notInReview = await request(s.as.board()).post(url(s)).send(body(s));
    expect(notInReview.status).toBe(422);
    expect(notInReview.body.details).toMatchObject({ code: "execution_return_refused", reason: "issue_not_in_review" });
    await db.update(issues).set({ status: "in_review", executionState: { ...s.executionState, returnAssignee: null } })
      .where(eq(issues.id, s.issueId));
    const noReturn = await request(s.as.board()).post(url(s)).send(body(s));
    expect(noReturn.status).toBe(422);
    expect(noReturn.body.details).toMatchObject({ reason: "no_return_assignee" });
    await db.update(issues).set({ executionState: s.executionState }).where(eq(issues.id, s.issueId));
    const ok = await request(s.as.board()).post(url(s)).send(body(s));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    // A repeat is refused: the issue is back in progress.
    const repeat = await request(s.as.board()).post(url(s)).send(body(s));
    expect(repeat.status).toBe(422);
    expect(repeat.body.details).toMatchObject({ reason: "issue_not_in_review" });
    expect(await returnActivity(s)).toHaveLength(1);
  });
});
