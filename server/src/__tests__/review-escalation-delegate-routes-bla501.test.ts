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
  issueExecutionDecisions,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { companyRoutes } from "../routes/companies.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { resolveReviewEscalationDelegateAgentId } from "../services/review-escalation-delegate.js";
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
    summary: "Review escalation delegate test run.",
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
  console.warn(`Skipping BLA-501 delegate route tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

type Actor = Record<string, unknown>;

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    value = await read();
  }
  return value;
}

describeEmbeddedPostgres("BLA-501 review escalation delegate (routes, real database)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-review-escalation-delegate-");
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

  async function seed() {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const ids = {
      developer: randomUUID(), reviewer: randomUUID(), delegate: randomUUID(), other: randomUUID(),
      terminated: randomUUID(), foreign: randomUUID(),
    };
    const issueId = randomUUID();
    const stageId = randomUUID();
    const priorDecisionIds = [randomUUID(), randomUUID()];
    const escalatedUserId = `escalated-${companyId}`;
    const viewerUserId = `viewer-${companyId}`;
    for (const [id, prefix] of [[companyId, "D"], [otherCompanyId, "O"]] as const) {
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
      agentRow(ids.terminated, "Gone", "engineer", { status: "terminated" }),
      agentRow(ids.foreign, "Foreign", "engineer", { companyId: otherCompanyId }),
    ]);
    for (const userId of [escalatedUserId, viewerUserId]) {
      await db.insert(authUsers).values({ id: userId, name: userId, email: `${userId}@example.test`,
        createdAt: new Date(), updatedAt: new Date() });
    }
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: escalatedUserId, status: "active", membershipRole: "owner" },
      { companyId, principalType: "user", principalId: viewerUserId, status: "active", membershipRole: "viewer" },
    ]);
    const executionState = {
      status: "pending", currentStageId: stageId, currentStageIndex: 0, currentStageType: "review",
      currentParticipant: { type: "user", agentId: null, userId: escalatedUserId },
      returnAssignee: { type: "agent", agentId: ids.developer, userId: null },
      reviewRequest: null, completedStageIds: [], lastDecisionId: priorDecisionIds[1],
      lastDecisionOutcome: "changes_requested", changesRequestedCount: 2,
    };
    await db.insert(issues).values({
      id: issueId, companyId, title: "Exhausted review", status: "in_review", priority: "high",
      assigneeUserId: escalatedUserId, createdByUserId: escalatedUserId, responsibleUserId: escalatedUserId,
      executionPolicy: {
        mode: "normal", commentRequired: true, maxReviewRounds: 2,
        stages: [{ id: stageId, type: "review", approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: ids.reviewer, userId: null }] }],
      },
      executionState,
    });
    for (const [index, decisionId] of priorDecisionIds.entries()) {
      await db.insert(issueExecutionDecisions).values({
        id: decisionId, companyId, issueId, stageId, stageType: "review", actorAgentId: ids.reviewer,
        outcome: "changes_requested", body: `Reviewer pass ${index + 1}`,
        createdAt: new Date(Date.now() - (3 - index) * 60_000),
      });
    }
    const runs: Record<string, string> = {};
    for (const key of ["developer", "reviewer", "delegate", "other"] as const) {
      runs[key] = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runs[key], companyId, agentId: ids[key], status: "running", runtimeMode: "legacy",
        invocationSource: "assignment", triggerDetail: "system", startedAt: new Date(),
        contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      });
    }
    const as = {
      board: () => app(boardActor(companyId, escalatedUserId)),
      viewer: () => app(boardActor(companyId, viewerUserId, {
        memberships: [{ companyId, status: "active", membershipRole: "viewer" }] })),
      mcp: () => app(boardActor(companyId, escalatedUserId, { source: "mcp_oauth" })),
      agent: (key: "developer" | "reviewer" | "delegate" | "other") =>
        app(agentActor(companyId, ids[key], runs[key]!)),
    };
    return { companyId, otherCompanyId, ids, runs, issueId, stageId, priorDecisionIds, escalatedUserId, executionState, as };
  }

  type Seeded = Awaited<ReturnType<typeof seed>>;

  const readIssue = async (s: Seeded) => (await db.select().from(issues).where(eq(issues.id, s.issueId)))[0]!;
  const decisions = (s: Seeded) => db.select().from(issueExecutionDecisions)
    .where(eq(issueExecutionDecisions.issueId, s.issueId)).orderBy(asc(issueExecutionDecisions.createdAt));
  const snapshot = async (s: Seeded) => {
    const issue = await readIssue(s);
    return {
      status: issue.status, assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId,
      executionState: issue.executionState, decisions: (await decisions(s)).map((row) => row.id),
    };
  };
  /** The acting agent works from its own run: settle stray runs, then give it the issue's execution. */
  async function checkOutFor(s: Seeded, key: "developer" | "delegate") {
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
  const setDelegate = (s: Seeded, agentId: string | null) =>
    request(s.as.board()).put(`/api/companies/${s.companyId}/review-escalation-delegate`).send({ agentId });

  describe("configuration", () => {
    it("only a board actor with write access sets or clears it, and only to an active agent of the company", async () => {
      const s = await seed();
      const url = `/api/companies/${s.companyId}/review-escalation-delegate`;
      expect((await request(s.as.board()).get(url)).body).toEqual({ agentId: null });

      for (const denied of [s.as.agent("delegate"), s.as.agent("developer"), s.as.mcp(), s.as.viewer()]) {
        const res = await request(denied).put(url).send({ agentId: s.ids.delegate });
        expect(res.status, JSON.stringify(res.body)).toBe(403);
      }
      for (const invalid of [s.ids.terminated, s.ids.foreign, randomUUID()]) {
        const res = await request(s.as.board()).put(url).send({ agentId: invalid });
        expect(res.status, JSON.stringify(res.body)).toBe(422);
      }
      expect((await request(s.as.board()).put(url).send({ agentId: "not-a-uuid" })).status).toBe(400);
      expect(await resolveReviewEscalationDelegateAgentId(db, s.companyId)).toBeNull();

      const set = await setDelegate(s, s.ids.delegate);
      expect(set.status, JSON.stringify(set.body)).toBe(200);
      expect(set.body).toEqual({ agentId: s.ids.delegate });
      expect((await request(s.as.agent("other")).get(url)).body).toEqual({ agentId: s.ids.delegate });
      expect(await resolveReviewEscalationDelegateAgentId(db, s.companyId)).toBe(s.ids.delegate);
      // Another company never resolves this company's delegate.
      expect(await resolveReviewEscalationDelegateAgentId(db, s.otherCompanyId)).toBeNull();

      const [activity] = await db.select().from(activityLog).where(and(
        eq(activityLog.companyId, s.companyId), eq(activityLog.action, "company.review_escalation_delegate_updated")));
      expect(activity).toMatchObject({ actorType: "user", actorId: s.escalatedUserId,
        details: { agentId: s.ids.delegate, _previous: { agentId: null } } });

      // The generic company PATCH neither changes nor clears the delegate.
      const governance = await request(s.as.board()).patch(`/api/companies/${s.companyId}`).send({
        interactionResolverGovernance: { suggest_tasks: { defaultPolicy: "not_creator" }, reviewEscalationDelegateAgentId: s.ids.other },
      });
      expect(governance.status, JSON.stringify(governance.body)).toBe(200);
      expect((await request(s.as.board()).get(url)).body).toEqual({ agentId: s.ids.delegate });
      const cleared = await request(s.as.board()).patch(`/api/companies/${s.companyId}`).send({ interactionResolverGovernance: {} });
      expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
      expect((await request(s.as.board()).get(url)).body).toEqual({ agentId: s.ids.delegate });

      // A delegate that stops being active stops resolving (default behaviour returns).
      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, s.ids.delegate));
      expect(await resolveReviewEscalationDelegateAgentId(db, s.companyId)).toBeNull();
      await db.update(agents).set({ status: "idle" }).where(eq(agents.id, s.ids.delegate));

      const clear = await setDelegate(s, null);
      expect(clear.status).toBe(200);
      expect((await request(s.as.board()).get(url)).body).toEqual({ agentId: null });
      expect(await resolveReviewEscalationDelegateAgentId(db, s.companyId)).toBeNull();
    });
  });

  describe("BLA-433-shaped user hold: claim, return, resubmit, approve", () => {
    it("keeps the stage, the count 2/2 and the decision history, and records every decision under the delegate", async () => {
      const s = await seed();
      const claimUrl = `/api/issues/${s.issueId}/review-escalation/claim`;
      const before = await snapshot(s);

      // No delegate configured: even the would-be delegate is refused.
      expect((await request(s.as.agent("delegate")).post(claimUrl)).status).toBe(422);
      expect(await snapshot(s)).toEqual(before);

      expect((await setDelegate(s, s.ids.delegate)).status).toBe(200);

      // Denied claimants: 422, no state change.
      for (const denied of [s.as.agent("developer"), s.as.agent("reviewer"), s.as.agent("other"), s.as.board()]) {
        const res = await request(denied).post(claimUrl);
        expect(res.status, JSON.stringify(res.body)).toBe(422);
        expect(await snapshot(s)).toEqual(before);
      }

      const claimed = await request(s.as.agent("delegate")).post(claimUrl);
      expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
      let issue = await readIssue(s);
      expect(issue).toMatchObject({ status: "in_review", assigneeAgentId: s.ids.delegate, assigneeUserId: null });
      expect(issue.executionState).toEqual({
        ...s.executionState,
        currentParticipant: { type: "agent", agentId: s.ids.delegate, userId: null },
        escalationHolder: { type: "agent", agentId: s.ids.delegate, userId: null },
      });
      expect((await decisions(s)).map((row) => row.id)).toEqual(s.priorDecisionIds);
      const [claimActivity] = await db.select().from(activityLog).where(and(
        eq(activityLog.entityId, s.issueId), eq(activityLog.action, "issue.review_escalation_claimed")));
      expect(claimActivity).toMatchObject({ actorType: "agent", actorId: s.ids.delegate, agentId: s.ids.delegate,
        details: expect.objectContaining({ stageId: s.stageId, changesRequestedCount: 2, maxReviewRounds: 2,
          lastDecisionId: s.priorDecisionIds[1] }) });
      // The claim wakes the delegate (asynchronously, after the response).
      const delegateWakes = await waitFor(() => db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.agentId, s.ids.delegate),
        sql`${agentWakeupRequests.payload}->>'issueId' = ${s.issueId}`)),
      (rows) => rows.length > 0);
      // The fixture's running runs make the platform park it behind the issue's
      // execution; the stored wake context is the reviewer stage wake.
      expect(delegateWakes).toHaveLength(1);
      expect(delegateWakes[0]!.payload).toMatchObject({
        issueId: s.issueId,
        executionStage: { stageId: s.stageId, wakeRole: "reviewer",
          currentParticipant: { type: "agent", agentId: s.ids.delegate, userId: null } },
        _paperclipWakeContext: { wakeReason: "execution_review_requested", source: "issue.execution_stage" },
      });

      // A second claim, and a claim by the previously escalated user, are refused.
      const afterClaim = await snapshot(s);
      expect((await request(s.as.agent("delegate")).post(claimUrl)).status).toBe(422);
      expect((await request(s.as.board()).post(claimUrl)).status).toBe(422);
      expect(await snapshot(s)).toEqual(afterClaim);

      // Nobody but the delegate can decide or advance the delegate hold.
      const patchUrl = `/api/issues/${s.issueId}`;
      const attempts = [
        { status: "done", comment: "approve" },
        { status: "in_progress", comment: "changes" },
        { assigneeAgentId: s.ids.other },
        { assigneeUserId: s.escalatedUserId },
      ];
      for (const denied of [s.as.agent("developer"), s.as.agent("reviewer"), s.as.agent("other"), s.as.board()]) {
        for (const body of attempts) {
          const res = await request(denied).patch(patchUrl).send(body);
          expect(res.status, `${JSON.stringify(body)} -> ${JSON.stringify(res.body)}`).toBe(422);
          const now = await snapshot(s);
          expect({ ...now, executionState: now.executionState })
            .toMatchObject({ status: "in_review", assigneeAgentId: s.ids.delegate, decisions: s.priorDecisionIds });
          expect(now.executionState).toEqual(afterClaim.executionState);
        }
      }

      // Delegate requests changes: back to the Developer, count unchanged.
      const back = await request(s.as.agent("delegate")).patch(patchUrl)
        .send({ status: "in_progress", comment: "Delegate: please address the remaining finding." });
      expect(back.status, JSON.stringify(back.body)).toBe(200);
      issue = await readIssue(s);
      expect(issue).toMatchObject({ status: "in_progress", assigneeAgentId: s.ids.developer, assigneeUserId: null,
        executionState: expect.objectContaining({ status: "changes_requested", currentStageId: s.stageId,
          changesRequestedCount: 2 }) });

      for (const cycle of [1, 2]) {
        // Resubmission goes to the delegate, not the configured reviewer.
        await checkOutFor(s, "developer");
        const resubmit = await request(s.as.agent("developer")).patch(patchUrl)
          .send({ status: "in_review", comment: `Fixed (cycle ${cycle}).` });
        expect(resubmit.status, JSON.stringify(resubmit.body)).toBe(200);
        issue = await readIssue(s);
        expect(issue).toMatchObject({ status: "in_review", assigneeAgentId: s.ids.delegate, assigneeUserId: null,
          executionState: expect.objectContaining({ status: "pending", currentStageId: s.stageId,
            changesRequestedCount: 2,
            currentParticipant: { type: "agent", agentId: s.ids.delegate, userId: null },
            escalationHolder: { type: "agent", agentId: s.ids.delegate, userId: null } }) });
        if (cycle === 1) {
          await checkOutFor(s, "delegate");
          const again = await request(s.as.agent("delegate")).patch(patchUrl)
            .send({ status: "in_progress", comment: "Delegate: one more change." });
          expect(again.status, JSON.stringify(again.body)).toBe(200);
          expect((await readIssue(s)).executionState).toMatchObject({ status: "changes_requested", changesRequestedCount: 2 });
        }
      }

      await checkOutFor(s, "delegate");
      const approve = await request(s.as.agent("delegate")).patch(patchUrl)
        .send({ status: "done", comment: "Delegate: approved." });
      expect(approve.status, JSON.stringify(approve.body)).toBe(200);
      issue = await readIssue(s);
      expect(issue.status).toBe("done");
      expect(issue.executionState).toMatchObject({ status: "completed", completedStageIds: [s.stageId],
        lastDecisionOutcome: "approved" });

      const rows = await decisions(s);
      expect(rows.slice(0, 2).map((row) => row.id)).toEqual(s.priorDecisionIds);
      expect(rows.slice(2).map((row) => [row.outcome, row.actorAgentId, row.actorUserId])).toEqual([
        ["changes_requested", s.ids.delegate, null],
        ["changes_requested", s.ids.delegate, null],
        ["approved", s.ids.delegate, null],
      ]);
      expect(rows.every((row) => row.actorUserId === null)).toBe(true);
      expect((issue.executionState as { lastDecisionId: string }).lastDecisionId).toBe(rows.at(-1)!.id);
    });

    it("refuses to claim an approval stage, a non-exhausted stage and a configured-user participant", async () => {
      const s = await seed();
      expect((await setDelegate(s, s.ids.delegate)).status).toBe(200);
      const claimUrl = `/api/issues/${s.issueId}/review-escalation/claim`;
      const issue = await readIssue(s);
      const policy = issue.executionPolicy as { stages: Array<Record<string, unknown>> };
      const variants: Array<Record<string, unknown>> = [
        { executionPolicy: { ...policy, stages: [{ ...policy.stages[0], type: "approval" }] },
          executionState: { ...s.executionState, currentStageType: "approval" } },
        { executionState: { ...s.executionState, changesRequestedCount: 1 } },
        { executionPolicy: { ...policy, stages: [{ ...policy.stages[0],
          participants: [{ id: randomUUID(), type: "user", agentId: null, userId: s.escalatedUserId }] }] } },
      ];
      for (const variant of variants) {
        await db.update(issues).set(variant).where(eq(issues.id, s.issueId));
        const before = await snapshot(s);
        const res = await request(s.as.agent("delegate")).post(claimUrl);
        expect(res.status, JSON.stringify(res.body)).toBe(422);
        expect(await snapshot(s)).toEqual(before);
        await db.update(issues).set({ executionPolicy: issue.executionPolicy, executionState: issue.executionState })
          .where(eq(issues.id, s.issueId));
      }
      // An unrelated human hold is never transferred without the explicit claim on that issue.
      expect((await readIssue(s))).toMatchObject({ assigneeUserId: s.escalatedUserId, assigneeAgentId: null });
    });

    it("hands a new agent-reviewer cap escalation to the delegate instead of a human", async () => {
      const s = await seed();
      expect((await setDelegate(s, s.ids.delegate)).status).toBe(200);
      await db.update(issues).set({
        assigneeAgentId: s.ids.reviewer, assigneeUserId: null,
        executionState: { ...s.executionState, changesRequestedCount: 1,
          currentParticipant: { type: "agent", agentId: s.ids.reviewer, userId: null } },
      }).where(eq(issues.id, s.issueId));
      const res = await request(s.as.agent("reviewer")).patch(`/api/issues/${s.issueId}`)
        .send({ status: "in_progress", comment: "Reviewer pass 2 of 2: changes requested." });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const issue = await readIssue(s);
      expect(issue).toMatchObject({ status: "in_review", assigneeAgentId: s.ids.delegate, assigneeUserId: null,
        executionState: expect.objectContaining({ changesRequestedCount: 2,
          escalationHolder: { type: "agent", agentId: s.ids.delegate, userId: null } }) });
    });
  });
});
