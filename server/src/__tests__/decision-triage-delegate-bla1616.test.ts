import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issueTreeHolds,
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
    exitCode: 0, signal: null, timedOut: false, errorMessage: null,
    summary: "Decision-triage test run.", provider: "test", model: "test-model",
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
  console.warn(`Skipping decision-triage delegate tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

type Actor = Record<string, unknown>;
type AgentKey = "oracle" | "other" | "coder" | "paused";

/**
 * BLA-1616 Part B: the decision-triage delegate routes (G1, G2, G3a, G4, G7)
 * and the board-only company setting that opens them. Every test fixture is
 * synthetic.
 */
describeEmbeddedPostgres("decision-triage delegate (routes, real database)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-decision-triage-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
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
    testApp.use("/api/companies", companyRoutes(db));
    testApp.use("/api", issueRoutes(db, {} as any, {
      stalledReviewDecisionEnqueueWakeup: vi.fn(async () => ({ id: randomUUID() })) as any,
    }));
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

  async function seed(options: { delegate?: boolean } = {}) {
    const companyId = randomUUID();
    const ids: Record<AgentKey, string> = {
      oracle: randomUUID(), other: randomUUID(), coder: randomUUID(), paused: randomUUID(),
    };
    const ownerUserId = `owner-${companyId}`;
    const humanUserId = `human-${companyId}`;
    await db.insert(companies).values({
      id: companyId, name: "T Co", issuePrefix: `T${companyId.slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      interactionResolverGovernance: (options.delegate === false ? {} : { decisionTriageDelegateAgentId: ids.oracle }) as never,
    });
    const agentRow = (id: string, name: string, status = "idle") => ({
      id, companyId, name, role: "engineer", status, adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true } },
      permissions: { canCreateAgents: false, canAssignTasks: true },
    });
    await db.insert(agents).values([
      agentRow(ids.oracle, "Oracle"), agentRow(ids.other, "Other"),
      agentRow(ids.coder, "Coder"), agentRow(ids.paused, "Paused", "paused"),
    ]);
    for (const userId of [ownerUserId, humanUserId]) {
      await db.insert(authUsers).values({ id: userId, name: userId, email: `${userId}@example.test`,
        createdAt: new Date(), updatedAt: new Date() });
    }
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: ownerUserId, status: "active", membershipRole: "owner" },
      { companyId, principalType: "user", principalId: humanUserId, status: "active", membershipRole: "member" },
    ]);
    const runs: Record<string, string> = {};
    for (const key of ["oracle", "other"] as const) {
      runs[key] = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runs[key], companyId, agentId: ids[key], status: "running", runtimeMode: "legacy",
        invocationSource: "assignment", triggerDetail: "system", startedAt: new Date(),
        contextSnapshot: { wakeReason: "issue_assigned" },
      });
    }
    let counter = 0;
    const issue = async (values: Record<string, unknown>) => {
      const id = randomUUID();
      counter += 1;
      await db.insert(issues).values({
        id, companyId, title: `Synthetic ${counter}`, status: "blocked", priority: "high",
        createdByUserId: ownerUserId, ...values,
      } as any);
      return id;
    };
    const recovery = async (sourceIssueId: string, extra: Record<string, unknown> = {}) => {
      const [row] = await db.insert(issueRecoveryActions).values({
        companyId, sourceIssueId, kind: "missing_disposition", status: "active",
        ownerType: "board", cause: "successful_run_missing_issue_disposition",
        fingerprint: randomUUID(), nextAction: "Choose the next step.",
        evidence: {}, ...extra,
      } as any).returning();
      return row!;
    };
    const as = {
      board: () => app(boardActor(companyId, ownerUserId)),
      mcp: () => app(boardActor(companyId, ownerUserId, { source: "mcp_oauth" })),
      viewer: () => app(boardActor(companyId, ownerUserId, {
        memberships: [{ companyId, status: "active", membershipRole: "viewer" }] })),
      agent: (key: "oracle" | "other") => app(agentActor(companyId, ids[key], runs[key]!)),
      agentNoRun: (key: "oracle" | "other") => app(agentActor(companyId, ids[key], "")),
    };
    return { companyId, ids, ownerUserId, humanUserId, runs, issue, recovery, as };
  }

  type Seeded = Awaited<ReturnType<typeof seed>>;
  const readIssue = async (id: string) => (await db.select().from(issues).where(eq(issues.id, id)))[0]!;
  const readAction = async (id: string) =>
    (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, id)))[0]!;
  const activities = async (s: Seeded, action: string) =>
    db.select().from(activityLog).where(and(eq(activityLog.companyId, s.companyId), eq(activityLog.action, action)));
  const pauseDelegate = async (s: Seeded) =>
    db.update(agents).set({ status: "paused" }).where(eq(agents.id, s.ids.oracle));
  const clearDelegate = async (s: Seeded) =>
    db.update(companies).set({ interactionResolverGovernance: {} }).where(eq(companies.id, s.companyId));

  describe("setting", () => {
    it("defaults to null and is set only by a non-viewer board session, not MCP OAuth or an agent", async () => {
      const s = await seed({ delegate: false });
      const path = `/api/companies/${s.companyId}/decision-triage-delegate`;
      expect((await request(s.as.board()).get(path)).body).toEqual({ agentId: null });

      for (const denied of [s.as.mcp(), s.as.viewer(), s.as.agent("oracle")]) {
        const res = await request(denied).put(path).send({ agentId: s.ids.oracle });
        expect(res.status, JSON.stringify(res.body)).toBe(403);
      }
      expect((await request(s.as.board()).get(path)).body).toEqual({ agentId: null });

      const set = await request(s.as.board()).put(path).send({ agentId: s.ids.oracle });
      expect(set.status, JSON.stringify(set.body)).toBe(200);
      expect(set.body).toEqual({ agentId: s.ids.oracle });
      const [entry] = await activities(s, "company.decision_triage_delegate_updated");
      expect(entry?.details).toMatchObject({ agentId: s.ids.oracle, _previous: { agentId: null } });

      const foreign = await seed({ delegate: false });
      const cross = await request(s.as.board()).put(path).send({ agentId: foreign.ids.coder });
      expect(cross.status).toBeGreaterThanOrEqual(400);
      expect((await request(s.as.board()).get(path)).body).toEqual({ agentId: s.ids.oracle });

      // The BLA-501 review-escalation delegate is a separate key and stays unset.
      const [company] = await db.select().from(companies).where(eq(companies.id, s.companyId));
      expect(company!.interactionResolverGovernance).not.toHaveProperty("reviewEscalationDelegateAgentId");

      const cleared = await request(s.as.board()).put(path).send({ agentId: null });
      expect(cleared.body).toEqual({ agentId: null });
    });
  });

  describe("G1 recovery on an unassigned or user-assigned source", () => {
    const resolveBody = (actionId: string, extra: Record<string, unknown> = {}) => ({
      actionId, outcome: "restored", sourceIssueStatus: "todo",
      resolutionNote: "Synthetic: the next step is clear, so the item is restored.", ...extra,
    });

    it("lets the delegate resolve an unassigned source and records one via entry", async () => {
      const s = await seed();
      const source = await s.issue({});
      const action = await s.recovery(source);
      const res = await request(s.as.agent("oracle"))
        .post(`/api/issues/${source}/recovery-actions/resolve`).send(resolveBody(action.id));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect((await readAction(action.id)).status).toBe("resolved");
      expect((await readIssue(source)).status).toBe("todo");
      const entries = await activities(s, "issue.recovery_action_resolved");
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ actorType: "agent", actorId: s.ids.oracle, agentId: s.ids.oracle });
      expect(entries[0]!.details).toMatchObject({
        via: "decision_triage_delegate",
        decisionTriage: { gaps: ["G1"], reason: expect.stringContaining("Synthetic") },
      });
    });

    it("refuses with the setting null, a non-delegate, a paused delegate, no run or no reason", async () => {
      const s = await seed();
      const source = await s.issue({});
      const action = await s.recovery(source);
      const url = `/api/issues/${source}/recovery-actions/resolve`;

      const other = await request(s.as.agent("other")).post(url).send(resolveBody(action.id));
      expect(other.status).toBe(403);
      const noReason = await request(s.as.agent("oracle")).post(url).send(resolveBody(action.id, { resolutionNote: "  " }));
      expect(noReason.status).toBe(422);
      expect(noReason.body.details?.code).toBe("decision_triage_reason_required");
      const noRun = await request(s.as.agentNoRun("oracle")).post(url).send(resolveBody(action.id));
      expect(noRun.status).toBeGreaterThanOrEqual(400);

      await pauseDelegate(s);
      const paused = await request(s.as.agent("oracle")).post(url).send(resolveBody(action.id));
      expect(paused.status).toBe(403);
      expect(paused.body.details?.code).toBe("decision_triage_delegate_inactive");

      await db.update(agents).set({ status: "idle" }).where(eq(agents.id, s.ids.oracle));
      await clearDelegate(s);
      const unset = await request(s.as.agent("oracle")).post(url).send(resolveBody(action.id));
      expect(unset.status).toBe(403);

      expect((await readAction(action.id)).status).toBe("active");
      expect((await readIssue(source)).status).toBe("blocked");
    });

    it("refuses a delegate configured in another company", async () => {
      const s = await seed({ delegate: false });
      const foreign = await seed();
      await db.update(companies).set({ interactionResolverGovernance: { decisionTriageDelegateAgentId: foreign.ids.oracle } as never })
        .where(eq(companies.id, s.companyId));
      const source = await s.issue({});
      const action = await s.recovery(source);
      // The foreign agent cannot even see the issue; a same-company agent is not the delegate.
      const res = await request(app(agentActor(s.companyId, foreign.ids.oracle, foreign.runs.oracle!)))
        .post(`/api/issues/${source}/recovery-actions/resolve`).send(resolveBody(action.id));
      expect([403, 404]).toContain(res.status);
      expect((await readAction(action.id)).status).toBe("active");
    });

    it("does not admit the delegate when the source has an assignee agent", async () => {
      const s = await seed();
      const source = await s.issue({ assigneeAgentId: s.ids.coder });
      const action = await s.recovery(source);
      const res = await request(s.as.agent("oracle"))
        .post(`/api/issues/${source}/recovery-actions/resolve`).send(resolveBody(action.id));
      expect(res.status).toBe(403);
      expect((await readAction(action.id)).status).toBe("active");
    });

    it("lets the delegate assign an active agent to an unassigned source, but not a paused agent or a user", async () => {
      const s = await seed();
      const source = await s.issue({});
      await s.recovery(source);
      const patch = (body: Record<string, unknown>) =>
        request(s.as.agent("oracle")).patch(`/api/issues/${source}`)
          .send({ comment: "Synthetic: delegating the recovered work.", ...body });

      const paused = await patch({ assigneeAgentId: s.ids.paused, status: "todo" });
      expect(paused.status, JSON.stringify(paused.body)).toBe(409);
      // The existing paused-assignee guard refuses first; the delegate check backs it up.
      expect(paused.body.details).toMatchObject({ assigneeStatus: "paused" });
      expect((await readIssue(source)).assigneeAgentId).toBeNull();
      const user = await patch({ assigneeUserId: s.humanUserId, status: "todo" });
      expect(user.status).toBeGreaterThanOrEqual(400);
      expect((await readIssue(source)).assigneeUserId).toBeNull();

      const ok = await patch({ assigneeAgentId: s.ids.coder, status: "todo" });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      const row = await readIssue(source);
      expect(row.assigneeAgentId).toBe(s.ids.coder);
      const [entry] = await activities(s, "issue.updated");
      expect(entry!.details).toMatchObject({ via: "decision_triage_delegate" });
    });

    it("lets the delegate resolve a user-assigned source but never reassign it away from the user", async () => {
      const s = await seed();
      const source = await s.issue({ assigneeUserId: s.humanUserId });
      const action = await s.recovery(source);
      const reassign = await request(s.as.agent("oracle")).patch(`/api/issues/${source}`)
        .send({ assigneeAgentId: s.ids.coder, assigneeUserId: null, comment: "Synthetic: try to reassign." });
      expect(reassign.status).toBe(403);
      expect(reassign.body.details?.code).toBe("recovery_source_authority_required");
      expect((await readIssue(source)).assigneeUserId).toBe(s.humanUserId);

      const res = await request(s.as.agent("oracle"))
        .post(`/api/issues/${source}/recovery-actions/resolve`).send(resolveBody(action.id));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const row = await readIssue(source);
      expect(row.assigneeUserId).toBe(s.humanUserId);
      expect((await readAction(action.id)).status).toBe("resolved");
    });
  });

  describe("G2 false_positive and cancelled as recovery-action outcomes only", () => {
    it("records both with in_review; `cancelled` cancels the recovery item, never the issue", async () => {
      const s = await seed();
      for (const outcome of ["false_positive", "cancelled"] as const) {
        // A human assignee is the in_review review path; the source has no assignee agent.
        const source = await s.issue({ assigneeUserId: s.humanUserId });
        const action = await s.recovery(source);
        const res = await request(s.as.agent("oracle")).post(`/api/issues/${source}/recovery-actions/resolve`)
          .send({ actionId: action.id, outcome, sourceIssueStatus: "in_review",
            resolutionNote: `Synthetic: ${outcome} recorded by the delegate.` });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const recorded = await readAction(action.id);
        expect(recorded.outcome).toBe(outcome);
        expect(recorded.status).toBe(outcome === "cancelled" ? "cancelled" : "resolved");
        expect((await readIssue(source)).status).toBe("in_review");
      }
    });

    it("keeps `done` (closing the work) with the board, and refuses non-delegates and the unset setting", async () => {
      const s = await seed();
      const source = await s.issue({});
      const action = await s.recovery(source);
      const url = `/api/issues/${source}/recovery-actions/resolve`;
      const body = (sourceIssueStatus: string) => ({ actionId: action.id, outcome: "false_positive", sourceIssueStatus,
        resolutionNote: "Synthetic: false positive." });
      expect((await request(s.as.agent("oracle")).post(url).send(body("done"))).status).toBe(403);
      expect((await request(s.as.agent("oracle")).post(url)
        .send({ ...body("done"), outcome: "cancelled" })).status).toBe(403);
      expect((await request(s.as.agent("other")).post(url).send(body("in_review"))).status).toBe(403);
      await clearDelegate(s);
      expect((await request(s.as.agent("oracle")).post(url).send(body("in_review"))).status).toBe(403);
      expect((await readAction(action.id)).status).toBe("active");
      expect((await readIssue(source)).status).toBe("blocked");
    });
  });

  describe("G3a assign and resume an unassigned issue held by a human-owned block", () => {
    const resume = (s: Seeded, key: "oracle" | "other", issueId: string) =>
      request(s.as.agent(key)).patch(`/api/issues/${issueId}`).send({
        status: "todo", assigneeAgentId: s.ids.coder,
        comment: "Synthetic: the human-owned block is stale; assigning and resuming.",
      });

    it("admits the delegate when no blocker or human card is open", async () => {
      const s = await seed();
      const issueId = await s.issue({ unblockDescriptor: { owner: "board", action: "Decide the next step." } });
      const res = await resume(s, "oracle", issueId);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const row = await readIssue(issueId);
      expect(row.status).toBe("todo");
      expect(row.assigneeAgentId).toBe(s.ids.coder);
    });

    it("refuses with an open blocker, a pending interaction, an agent-owned block, a non-delegate or the setting null", async () => {
      const s = await seed();
      const descriptor = { owner: { userId: s.humanUserId }, action: "Answer the question." };

      const blocked = await s.issue({ unblockDescriptor: descriptor });
      const blocker = await s.issue({ status: "todo", assigneeAgentId: s.ids.coder });
      await db.insert(issueRelations).values({ companyId: s.companyId, issueId: blocker, relatedIssueId: blocked, type: "blocks" });
      expect((await resume(s, "oracle", blocked)).status).toBe(409);

      const waiting = await s.issue({ unblockDescriptor: descriptor });
      await db.insert(issueThreadInteractions).values({
        companyId: s.companyId, issueId: waiting, kind: "request_confirmation", status: "pending",
        continuationPolicy: "wake_assignee", payload: { version: 1, prompt: "Proceed?" },
      } as any);
      const waitingRes = await resume(s, "oracle", waiting);
      expect(waitingRes.status).toBe(409);
      expect(waitingRes.body.details?.code).toBe("decision_triage_human_wait_pending");

      const agentOwned = await s.issue({ unblockDescriptor: { owner: { agentId: s.ids.other }, action: "Finish." } });
      expect((await resume(s, "oracle", agentOwned)).status).toBe(409);

      const plain = await s.issue({ unblockDescriptor: descriptor });
      expect((await resume(s, "other", plain)).status).toBe(409);
      await clearDelegate(s);
      expect((await resume(s, "oracle", plain)).status).toBe(409);

      for (const id of [blocked, waiting, agentOwned, plain]) {
        const row = await readIssue(id);
        expect(row.status).toBe("blocked");
        expect(row.assigneeAgentId).toBeNull();
      }
    });
  });

  describe("G4 triage nudge", () => {
    const nudge = (s: Seeded, key: "oracle" | "other", issueId: string, reason = "Synthetic: the tree is stalled.") =>
      request(s.as.agent(key)).post(`/api/issues/${issueId}/triage-nudge`).send({ reason });

    it("wakes only the current assignee agent once per 30 minutes", async () => {
      const s = await seed();
      const issueId = await s.issue({ status: "todo", assigneeAgentId: s.ids.coder });
      const first = await nudge(s, "oracle", issueId);
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body).toMatchObject({ issueId, targetAgentId: s.ids.coder, wakeQueued: true });
      expect(first.body.idempotencyKey).toMatch(new RegExp(`^triage-nudge:${issueId}:${s.ids.coder}:`));
      const second = await nudge(s, "oracle", issueId);
      expect(second.status).toBe(429);
      expect(second.body.details?.code).toBe("triage_nudge_rate_limited");
      const entries = await activities(s, "issue.triage_nudged");
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ actorType: "agent", actorId: s.ids.oracle });
      expect(entries[0]!.details).toMatchObject({ via: "decision_triage_delegate", targetAgentId: s.ids.coder });
    });

    it("refuses the board, non-delegates, the unset setting, a paused target, a hold and an empty reason", async () => {
      const s = await seed();
      const issueId = await s.issue({ status: "todo", assigneeAgentId: s.ids.coder });
      const board = await request(s.as.board()).post(`/api/issues/${issueId}/triage-nudge`).send({ reason: "x" });
      expect(board.status).toBe(403);
      expect((await nudge(s, "other", issueId)).body.details?.code).toBe("decision_triage_delegate_required");
      expect((await nudge(s, "oracle", issueId, " ")).status).toBeGreaterThanOrEqual(400);

      const pausedTarget = await s.issue({ status: "todo", assigneeAgentId: s.ids.paused });
      expect((await nudge(s, "oracle", pausedTarget)).body.details?.code).toBe("triage_nudge_target_unavailable");
      const unassigned = await s.issue({ status: "todo" });
      expect((await nudge(s, "oracle", unassigned)).body.details?.code).toBe("triage_nudge_no_assignee_agent");

      await db.insert(issueTreeHolds).values({ companyId: s.companyId, rootIssueId: issueId, mode: "pause", status: "active",
        reason: "Synthetic hold", createdByActorType: "user", createdByUserId: s.ownerUserId });
      const held = await nudge(s, "oracle", issueId);
      expect(held.status).toBe(409);
      expect(held.body.details?.code).toBe("triage_nudge_hold_requires_board");

      await pauseDelegate(s);
      expect((await nudge(s, "oracle", issueId)).body.details?.code).toBe("decision_triage_delegate_inactive");
      await clearDelegate(s);
      expect((await nudge(s, "oracle", issueId)).status).toBe(403);
      expect(await activities(s, "issue.triage_nudged")).toHaveLength(0);
    });
  });

  describe("G7 stalled-review decision", () => {
    it("admits the delegate for request_changes only; approve stays with the board", async () => {
      const s = await seed();
      const issueId = await s.issue({ status: "in_review", assigneeAgentId: s.ids.coder });
      const url = `/api/issues/${issueId}/stalled-review-decision`;
      const approve = await request(s.as.agent("oracle")).post(url).send({ action: "approve", note: "Synthetic." });
      expect(approve.status).toBe(403);
      expect(approve.body.details?.code).toBe("decision_triage_accepting_option_board_only");
      expect((await request(s.as.agent("other")).post(url)
        .send({ action: "request_changes", note: "Synthetic: send back." })).status).toBe(403);
      expect((await readIssue(issueId)).status).toBe("in_review");

      const res = await request(s.as.agent("oracle")).post(url)
        .send({ action: "request_changes", note: "Synthetic: no reviewer holds this; send it back." });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect((await readIssue(issueId)).status).toBe("todo");
      const [entry] = await activities(s, "issue.stalled_review_decided");
      expect(entry).toMatchObject({ actorType: "agent", actorId: s.ids.oracle });
      expect(entry!.details).toMatchObject({ via: "decision_triage_delegate" });
    });

    it("refuses the delegate with the setting null", async () => {
      const s = await seed();
      await clearDelegate(s);
      const issueId = await s.issue({ status: "in_review", assigneeAgentId: s.ids.coder });
      const res = await request(s.as.agent("oracle")).post(`/api/issues/${issueId}/stalled-review-decision`)
        .send({ action: "request_changes", note: "Synthetic." });
      expect(res.status).toBe(403);
    });
  });

  describe("G5 and G6 stay human, also for the delegate", () => {
    it("G5: the delegate cannot give a human_only verdict", async () => {
      const s = await seed();
      const issueId = await s.issue({ status: "in_review", assigneeUserId: s.humanUserId, reviewPolicy: "human_only" });
      const res = await request(s.as.agent("oracle")).patch(`/api/issues/${issueId}`)
        .send({ status: "done", comment: "Synthetic: try to approve." });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect((await readIssue(issueId)).status).toBe("in_review");
    });

    it("G6: the delegate cannot clear a user-held stage", async () => {
      const s = await seed();
      const stageId = randomUUID();
      const participant = { type: "user", agentId: null, userId: s.humanUserId };
      const executionState = {
        status: "pending", currentStageId: stageId, currentStageIndex: 0, currentStageType: "review",
        currentParticipant: participant, returnAssignee: { type: "agent", agentId: s.ids.coder, userId: null },
        reviewRequest: null, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
        monitor: null, changesRequestedCount: 0,
      };
      const executionPolicy = { mode: "normal", commentRequired: true,
        stages: [{ id: stageId, type: "review", approvalsNeeded: 1, participants: [{ id: randomUUID(), ...participant }] }] };
      const issueId = await s.issue({ status: "in_review", assigneeUserId: s.humanUserId, executionState, executionPolicy });
      const res = await request(s.as.agent("oracle")).patch(`/api/issues/${issueId}`)
        .send({ executionPolicy: null, comment: "Synthetic: try to clear the stage." });
      expect(res.status).toBe(403);
      expect(res.body.details?.code).toBe("execution_stage_participant_required");
      const verdict = await request(s.as.agent("oracle")).patch(`/api/issues/${issueId}`)
        .send({ status: "done", comment: "Synthetic: try to approve." });
      expect(verdict.status).toBeGreaterThanOrEqual(400);
      const row = await readIssue(issueId);
      expect(row.status).toBe("in_review");
      expect(row.executionState).toEqual(executionState);
    });
  });
});
