// Regression coverage (BLA-140 LR-4 / LR-5): resolving an issue-thread
// interaction on a private-project issue must first apply the issue read
// decision, so a company user or agent that cannot read the issue gets the
// same 404 "Issue not found" as on GET /issues/:id, and cannot change the card.
// All data in this file is synthetic.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
  projectAccessMembers,
  projects,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres interaction read-access tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Actor = Record<string, unknown>;
type Route = "accept" | "reject" | "respond" | "skip";

const BODIES: Record<Route, Record<string, unknown>> = {
  accept: {},
  reject: { reason: "Synthetic reason" },
  respond: { answers: [{ questionId: "scope", optionIds: ["phase-1"] }] },
  skip: { reason: "Synthetic skip" },
};

describeEmbeddedPostgres("interaction resolution applies issue read access (LR-4/LR-5)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let previousMode: string | undefined;

  beforeAll(async () => {
    previousMode = process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
    process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = "enforce";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-interaction-read-access-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    const cleanups = [
      () => db.delete(issueThreadInteractions),
      () => db.delete(activityLog),
      () => db.delete(agentWakeupRequests),
      () => db.delete(heartbeatRuns),
      () => db.delete(issues),
      () => db.delete(projectAccessMembers),
      () => db.delete(projects),
      () => db.delete(companyMemberships),
      () => db.delete(agents),
      () => db.delete(companies),
    ];
    for (const cleanup of cleanups) await cleanup().catch(() => undefined);
  });

  afterAll(async () => {
    if (previousMode === undefined) delete process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
    else process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = previousMode;
    await db.$client.end();
    await tempDb?.cleanup();
  });

  function app(actor: Actor) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use(errorHandler);
    return testApp;
  }

  let seq = 0;
  async function seed() {
    seq += 1;
    const prefix = `SR${String.fromCharCode(65 + (seq % 26))}${String.fromCharCode(65 + Math.floor(seq / 26) % 26)}`;
    const companyId = randomUUID();
    const memberAgentId = randomUUID();
    const outsiderAgentId = randomUUID();
    const memberUserId = `synthetic-member-${randomUUID()}`;
    const otherMemberUserId = `synthetic-member2-${randomUUID()}`;
    const outsiderUserId = `synthetic-outsider-${randomUUID()}`;
    const privateProjectId = randomUUID();
    const openProjectId = randomUUID();
    const privateIssueId = randomUUID();
    const openIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Synthetic Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: memberAgentId, companyId, name: "Synthetic Member Agent", role: "engineer", status: "idle", adapterType: "process", adapterConfig: {} },
      { id: outsiderAgentId, companyId, name: "Synthetic Outsider Agent", role: "engineer", status: "idle", adapterType: "process", adapterConfig: {} },
    ]);
    await db.insert(companyMemberships).values([memberUserId, otherMemberUserId, outsiderUserId].map((principalId) => ({
      companyId, principalType: "user", principalId, status: "active", membershipRole: "member",
    })));
    await db.insert(projects).values([
      { id: privateProjectId, companyId, name: "Synthetic private project", status: "in_progress", visibility: "private" },
      { id: openProjectId, companyId, name: "Synthetic open project", status: "in_progress" },
    ]);
    await db.insert(projectAccessMembers).values([
      { companyId, projectId: privateProjectId, subjectType: "agent", subjectId: memberAgentId },
      { companyId, projectId: privateProjectId, subjectType: "user", subjectId: memberUserId },
      { companyId, projectId: privateProjectId, subjectType: "user", subjectId: otherMemberUserId },
    ]);
    await db.insert(issues).values([
      { id: privateIssueId, companyId, projectId: privateProjectId, identifier: `${prefix}-1`, title: "Synthetic private card issue", status: "in_progress", priority: "medium", assigneeAgentId: memberAgentId },
      { id: openIssueId, companyId, projectId: openProjectId, identifier: `${prefix}-2`, title: "Synthetic open issue", status: "in_progress", priority: "medium", assigneeAgentId: outsiderAgentId },
    ]);
    const memberRunId = randomUUID();
    const outsiderRunId = randomUUID();
    await db.insert(heartbeatRuns).values([
      { id: memberRunId, companyId, agentId: memberAgentId, invocationSource: "assignment", triggerDetail: "system", status: "running", contextSnapshot: { issueId: privateIssueId, wakeReason: "issue_assigned" } },
      { id: outsiderRunId, companyId, agentId: outsiderAgentId, invocationSource: "assignment", triggerDetail: "system", status: "running", contextSnapshot: { issueId: openIssueId, wakeReason: "issue_assigned" } },
    ]);

    async function card(route: Route | "dismiss") {
      const [row] = await db.insert(issueThreadInteractions).values({
        companyId,
        issueId: privateIssueId,
        kind: route === "respond" ? "ask_user_questions" : "request_confirmation",
        status: "pending",
        continuationPolicy: "wake_assignee",
        requestedResolverPolicy: "human_only",
        effectiveResolverPolicy: "human_only",
        addresseeUserId: memberUserId,
        createdByAgentId: memberAgentId,
        payload: (route === "respond"
          ? { version: 1, questions: [{ id: "scope", prompt: "Which scope?", selectionMode: "single", options: [{ id: "phase-1", label: "Phase 1" }] }] }
          : { version: 1, prompt: "Synthetic confirmation?" }) as never,
      }).returning({ id: issueThreadInteractions.id });
      return row.id;
    }

    const boardActor = (userId: string): Actor => ({
      type: "board",
      source: "session",
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole: "member" }],
      isInstanceAdmin: false,
    });
    const agentActor = (agentId: string, runId?: string): Actor => ({
      type: "agent", source: "agent_key", companyId, agentId, ...(runId ? { runId } : {}),
    });

    return {
      privateIssueId,
      card,
      actors: {
        memberUser: boardActor(memberUserId),
        otherMemberUser: boardActor(otherMemberUserId),
        outsiderUser: boardActor(outsiderUserId),
        memberAgent: agentActor(memberAgentId, memberRunId),
        outsiderAgent: agentActor(outsiderAgentId, outsiderRunId),
        outsiderAgentNoRun: agentActor(outsiderAgentId),
      },
    };
  }

  async function snapshot(id: string) {
    const [row] = await db
      .select({
        status: issueThreadInteractions.status,
        result: issueThreadInteractions.result,
        resolvedByUserId: issueThreadInteractions.resolvedByUserId,
        resolvedByAgentId: issueThreadInteractions.resolvedByAgentId,
        resolvedAt: issueThreadInteractions.resolvedAt,
        dismissedAt: issueThreadInteractions.dismissedAt,
      })
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, id));
    return row;
  }

  function post(actor: Actor, issueId: string, interactionId: string, route: Route | "dismiss") {
    return request(app(actor))
      .post(`/api/issues/${issueId}/interactions/${interactionId}/${route}`)
      .send(route === "dismiss" ? {} : BODIES[route]);
  }

  const ROUTES: Route[] = ["accept", "reject", "respond", "skip"];

  it("baseline: GET /issues/:id is 404 for the non-members and 200 for members", async () => {
    const s = await seed();
    for (const a of [s.actors.outsiderUser, s.actors.outsiderAgent]) {
      const res = await request(app(a)).get(`/api/issues/${s.privateIssueId}`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Issue not found" });
    }
    for (const a of [s.actors.memberUser, s.actors.memberAgent]) {
      expect((await request(app(a)).get(`/api/issues/${s.privateIssueId}`)).status).toBe(200);
    }
  });

  for (const route of ROUTES) {
    it(`${route}: non-members get 404 "Issue not found" and the card is unchanged`, async () => {
      const s = await seed();
      const cardId = await s.card(route);
      const before = await snapshot(cardId);
      for (const [name, actor] of [
        ["outsiderUser", s.actors.outsiderUser],
        ["outsiderAgent", s.actors.outsiderAgent],
        ["outsiderAgentNoRun", s.actors.outsiderAgentNoRun],
      ] as const) {
        const res = await post(actor, s.privateIssueId, cardId, route);
        expect({ name, status: res.status, body: res.body }).toEqual({ name, status: 404, body: { error: "Issue not found" } });
        // Random-id control: indistinguishable from the real private card.
        const control = await post(actor, randomUUID(), randomUUID(), route);
        expect(control.status).toBe(404);
        expect(await snapshot(cardId)).toEqual(before);
      }
      expect(before.status).toBe("pending");
    });

    it(`${route}: members keep the resolver-policy and addressee answers`, async () => {
      const s = await seed();
      const cardId = await s.card(route);
      const before = await snapshot(cardId);
      const mismatch = await post(s.actors.otherMemberUser, s.privateIssueId, cardId, route);
      if (route === "skip") {
        // Skip runs the service directly; a member that is not the addressee is still a reader.
        expect(mismatch.status).not.toBe(404);
      } else {
        expect(mismatch.status).toBe(403);
        expect(mismatch.body.code).toBe("interaction_addressee_mismatch");
        expect(await snapshot(cardId)).toEqual(before);
      }
      const s2 = await seed();
      const card2 = await s2.card(route);
      const before2 = await snapshot(card2);
      const agentRes = await post(s2.actors.memberAgent, s2.privateIssueId, card2, route);
      expect(agentRes.status).toBe(403);
      if (route === "skip") {
        expect(agentRes.body.error).toMatch(/Agent actors cannot skip/);
      } else {
        expect(agentRes.body.code).toBe("interaction_human_only");
      }
      expect(await snapshot(card2)).toEqual(before2);
    });
  }

  it("LR-5: a non-member board user cannot skip a private card; the addressee still can", async () => {
    const s = await seed();
    const cardId = await s.card("skip");
    const before = await snapshot(cardId);
    const res = await post(s.actors.outsiderUser, s.privateIssueId, cardId, "skip");
    expect(res.status).toBe(404);
    const after = await snapshot(cardId);
    expect(after).toEqual(before);
    expect(after.status).toBe("pending");
    expect(after.resolvedByUserId).toBeNull();
    expect(after.resolvedByAgentId).toBeNull();
    const ok = await post(s.actors.memberUser, s.privateIssueId, cardId, "skip");
    expect(ok.status).toBeLessThan(300);
  });

  it("the addressee member can still accept (no over-filtering)", async () => {
    const s = await seed();
    const cardId = await s.card("accept");
    const res = await post(s.actors.memberUser, s.privateIssueId, cardId, "accept");
    expect(res.status).toBeLessThan(300);
    expect((await snapshot(cardId)).status).toBe("accepted");
  });

  it("dismiss is unchanged: non-member board user 404, agents uniform 403", async () => {
    const s = await seed();
    const cardId = await s.card("dismiss");
    const before = await snapshot(cardId);
    const user = await post(s.actors.outsiderUser, s.privateIssueId, cardId, "dismiss");
    expect(user.status).toBe(404);
    for (const a of [s.actors.outsiderAgent, s.actors.memberAgent]) {
      const res = await post(a, s.privateIssueId, cardId, "dismiss");
      const control = await post(a, randomUUID(), randomUUID(), "dismiss");
      expect(res.status).toBe(403);
      expect({ status: control.status, body: control.body }).toEqual({ status: res.status, body: res.body });
    }
    expect(await snapshot(cardId)).toEqual(before);
  });
});
