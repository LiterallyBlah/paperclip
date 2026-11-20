import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { parseIssueExecutionState } from "../services/issue-execution-policy.js";

vi.setConfig({ testTimeout: 30_000 });

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres blocked wait route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * `blocked` must name something that can end the wait: an unresolved blocker,
 * a pending interaction or approval, a human owner, or an unblock descriptor.
 * A narrative-only block (a reason in a comment and nothing else) is refused,
 * whether it is entered directly or reached by dropping the last real wait.
 */
describeEmbeddedPostgres("blocked status requires a real wait", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-blocked-wait-routes-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    // Accepted transitions can enqueue an assignee wake after the response.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await db.delete(issueThreadInteractions);
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "board-user",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "admin", status: "active" }],
        isInstanceAdmin: false,
        source: "session",
      } as Express.Request["actor"];
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const prefix = `B${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Blocked Wait Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Builder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: false } },
      permissions: {},
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "board-user",
      status: "active",
      membershipRole: "admin",
    });
    let counter = 0;
    const insertIssue = async (input: {
      status: string;
      assigneeUserId?: string | null;
      unblockDescriptor?: Record<string, unknown> | null;
      executionPolicy?: Record<string, unknown> | null;
      monitorNextCheckAt?: Date | null;
    }) => {
      const id = randomUUID();
      counter += 1;
      await db.insert(issues).values({
        id,
        companyId,
        identifier: `${prefix}-${counter}`,
        issueNumber: counter,
        title: `Task ${counter}`,
        status: input.status,
        priority: "medium",
        assigneeAgentId: input.assigneeUserId ? null : agentId,
        assigneeUserId: input.assigneeUserId ?? null,
        unblockDescriptor: (input.unblockDescriptor ?? null) as never,
        executionPolicy: input.executionPolicy ?? null,
        monitorNextCheckAt: input.monitorNextCheckAt ?? null,
        blockedTransitionAt: input.status === "blocked" ? new Date() : null,
      });
      return id;
    };
    const link = (blockerId: string, blockedId: string) =>
      db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: blockedId, type: "blocks" });
    return { companyId, agentId, app: createApp(companyId), insertIssue, link };
  }

  const NARRATIVE = "Waiting on the vendor to reply; nothing to do until then.";

  describe("rejected", () => {
    it("refuses entering blocked with only a narrative reason", async () => {
      const { app, insertIssue } = await seed();
      const issueId = await insertIssue({ status: "in_progress" });

      const res = await request(app).patch(`/api/issues/${issueId}`).send({ status: "blocked", comment: NARRATIVE });

      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.error).toMatch(/Entering blocked requires/);
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]?.status).toBe("in_progress");
    });

    it("refuses emptying the blocker list of a task that stays blocked", async () => {
      const { app, insertIssue, link } = await seed();
      const blockedId = await insertIssue({ status: "blocked" });
      const blockerId = await insertIssue({ status: "todo" });
      await link(blockerId, blockedId);

      const res = await request(app).patch(`/api/issues/${blockedId}`).send({ blockedByIssueIds: [], comment: NARRATIVE });

      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.error).toMatch(/blocked task must keep/);
      const relations = await db.select().from(issueRelations).where(eq(issueRelations.relatedIssueId, blockedId));
      expect(relations).toHaveLength(1);
    });

    it("refuses clearing the only unblock descriptor of a task that stays blocked", async () => {
      const { app, insertIssue } = await seed();
      const issueId = await insertIssue({
        status: "blocked",
        unblockDescriptor: { owner: "board", action: "Approve the vendor contract." },
      });

      const res = await request(app).patch(`/api/issues/${issueId}`).send({ unblockDescriptor: null });

      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]?.unblockDescriptor).toMatchObject({ owner: "board" });
    });
  });

  describe("accepted", () => {
    it("accepts blocked with an unresolved blocker link", async () => {
      const { app, insertIssue } = await seed();
      const issueId = await insertIssue({ status: "in_progress" });
      const blockerId = await insertIssue({ status: "todo" });

      const res = await request(app).patch(`/api/issues/${issueId}`).send({ status: "blocked", blockedByIssueIds: [blockerId] });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.status).toBe("blocked");
    });

    it("accepts blocked with an actionable unblock descriptor", async () => {
      const { app, insertIssue } = await seed();
      const issueId = await insertIssue({ status: "in_progress" });

      const res = await request(app).patch(`/api/issues/${issueId}`).send({
        status: "blocked",
        unblockDescriptor: { owner: "board", action: "Approve the vendor contract." },
      });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.status).toBe("blocked");
    });

    it("accepts blocked with a pending human interaction", async () => {
      const { companyId, app, insertIssue } = await seed();
      const issueId = await insertIssue({ status: "in_progress" });
      await db.insert(issueThreadInteractions).values({
        companyId,
        issueId,
        kind: "request_confirmation",
        status: "pending",
        continuationPolicy: "wake_assignee",
        payload: { version: 1, prompt: "Approve the vendor contract?" },
      });

      const res = await request(app).patch(`/api/issues/${issueId}`).send({ status: "blocked" });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.status).toBe("blocked");
    });

    it("accepts blocked on a task a person owns", async () => {
      const { app, insertIssue } = await seed();
      const issueId = await insertIssue({ status: "in_progress", assigneeUserId: "board-user" });

      const res = await request(app).patch(`/api/issues/${issueId}`).send({ status: "blocked", comment: NARRATIVE });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.status).toBe("blocked");
    });

    it("accepts swapping one unresolved blocker for another while blocked", async () => {
      const { app, insertIssue, link } = await seed();
      const blockedId = await insertIssue({ status: "blocked" });
      const first = await insertIssue({ status: "todo" });
      const second = await insertIssue({ status: "todo" });
      await link(first, blockedId);

      const res = await request(app).patch(`/api/issues/${blockedId}`).send({ blockedByIssueIds: [second] });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
    });

    it("accepts dropping blocker links while a descriptor still names the unblock owner", async () => {
      const { app, insertIssue, link } = await seed();
      const blockedId = await insertIssue({
        status: "blocked",
        unblockDescriptor: { owner: "board", action: "Approve the vendor contract." },
      });
      const blockerId = await insertIssue({ status: "todo" });
      await link(blockerId, blockedId);

      const res = await request(app).patch(`/api/issues/${blockedId}`).send({ blockedByIssueIds: [] });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
    });

    it("keeps the native board reopen: a board comment moves a descriptor-only blocked task to todo", async () => {
      const { app, insertIssue } = await seed();
      const issueId = await insertIssue({
        status: "blocked",
        unblockDescriptor: { owner: "board", action: "Approve the vendor contract." },
      });

      const res = await request(app).patch(`/api/issues/${issueId}`).send({ unblockDescriptor: null, comment: "Approved; continue." });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.status).toBe("todo");
    });

    it("accepts leaving blocked with a narrative comment", async () => {
      const { app, insertIssue, link } = await seed();
      const blockedId = await insertIssue({ status: "blocked" });
      const blockerId = await insertIssue({ status: "todo" });
      await link(blockerId, blockedId);

      const res = await request(app).patch(`/api/issues/${blockedId}`).send({ status: "todo", blockedByIssueIds: [], comment: NARRATIVE });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.status).toBe("todo");
    });
  });

  describe("monitors are never a blocked wait", () => {
    it("rejects arming a monitor while entering blocked", async () => {
      const { app, insertIssue } = await seed();
      const issueId = await insertIssue({ status: "in_progress" });
      const nextCheckAt = new Date(Date.now() + 60 * 60_000).toISOString();

      const res = await request(app).patch(`/api/issues/${issueId}`).send({
        status: "blocked",
        unblockDescriptor: { owner: "board", action: "Approve the vendor contract." },
        executionPolicy: { monitor: { nextCheckAt, notes: "Check the vendor portal" } },
      });

      expect(res.status, JSON.stringify(res.body)).toBe(422);
    });

    it("clears a scheduled monitor when the task enters blocked, so it cannot read as coverage", async () => {
      const { app, insertIssue, link } = await seed();
      const nextCheckAt = new Date(Date.now() + 60 * 60_000);
      const issueId = await insertIssue({
        status: "in_progress",
        executionPolicy: { monitor: { nextCheckAt: nextCheckAt.toISOString(), notes: "Check the vendor portal", scheduledBy: "assignee" } },
        monitorNextCheckAt: nextCheckAt,
      });
      const blockerId = await insertIssue({ status: "todo" });
      await link(blockerId, issueId);

      const res = await request(app).patch(`/api/issues/${issueId}`).send({ status: "blocked" });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(row?.monitorNextCheckAt).toBeNull();
      expect(parseIssueExecutionState(row?.executionState)?.monitor).toMatchObject({
        status: "cleared",
        clearReason: "invalid_status",
      });
    });
  });
});
