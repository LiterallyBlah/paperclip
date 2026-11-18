import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  costEvents,
  createDb,
  documentRevisions,
  documents,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issues,
  principalPermissionGrants,
  projectAccessMembers,
  projects,
  statusCards,
  statusCardUpdates,
} from "@paperclipai/db";
import { defaultStatusCardRefreshPolicy } from "@paperclipai/shared";
import { errorHandler } from "../middleware/index.js";
import { statusCardRoutes } from "../routes/status-cards.js";
import { withBuiltInAgentMarker } from "../lib/built-in-agent-metadata.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import type { IssueAssignmentWakeupDeps } from "../services/issue-assignment-wakeup.js";
import { statusCardService } from "../services/status-cards.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// Synthetic fixtures only: a card whose scope covers one open issue and one
// issue inside a private project. Non-members of that project must not see the
// private issue's id, identifier or title through any status-card read path.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

const PRIVATE_TITLE = "Synthetic restricted item";
const OPEN_TITLE = "Synthetic open item";
const CARD_OWNER = "synthetic-owner";
const NON_MEMBER = "synthetic-non-member";
const MEMBER = "synthetic-member";

function boardActor(companyId: string, userId: string): Express.Request["actor"] {
  return {
    type: "board",
    userId,
    source: "session",
    sessionId: `session-${userId}`,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "operator", status: "active" }],
    isInstanceAdmin: false,
  };
}

function createApp(
  db: Db,
  actor: Express.Request["actor"],
  heartbeat: IssueAssignmentWakeupDeps = { wakeup: async () => ({ queued: true }) },
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", statusCardRoutes(db, { heartbeat }));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("status card viewer scope", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-status-card-scope-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(costEvents);
    await db.delete(statusCardUpdates);
    await db.delete(statusCards);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(principalPermissionGrants);
    await db.delete(projectAccessMembers);
    await db.delete(projects);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(instanceSettings);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture(options: { summarizerIsProjectMember?: boolean } = {}) {
    const prefix = `SV${randomUUID().slice(0, 6).toUpperCase()}`;
    const company = await db.insert(companies)
      .values({ name: "Scope Co", issuePrefix: prefix })
      .returning().then((rows) => rows[0]!);
    await instanceSettingsService(db).updateExperimental({ enableStatusCards: true });
    const summarizer = await db.insert(agents).values({
      companyId: company.id,
      name: "Summarizer",
      role: "general",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { model: "synthetic-model" },
      metadata: withBuiltInAgentMarker(null, { key: "summarizer", featureKeys: ["summarizer"] }),
    }).returning().then((rows) => rows[0]!);
    for (const principalId of [NON_MEMBER, MEMBER]) {
      await db.insert(companyMemberships).values({
        companyId: company.id,
        principalType: "user",
        principalId,
        membershipRole: "operator",
        status: "active",
      });
    }
    // The card creator is the generation tasks' responsible user (BLA-1487 B1).
    // It is an active owner who can read every fixture issue, so these tests
    // isolate the Summarizer's own scope; status-cards-privacy-residuals covers
    // the narrowing by the responsible user.
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: CARD_OWNER,
      membershipRole: "owner",
      status: "active",
    });
    const privateProject = await db.insert(projects).values({
      companyId: company.id,
      name: "Synthetic private project",
      visibility: "private",
      status: "in_progress",
    }).returning().then((rows) => rows[0]!);
    await db.insert(projectAccessMembers).values([
      { companyId: company.id, projectId: privateProject.id, subjectType: "user", subjectId: MEMBER },
      { companyId: company.id, projectId: privateProject.id, subjectType: "user", subjectId: CARD_OWNER },
    ]);
    if (options.summarizerIsProjectMember) {
      await db.insert(projectAccessMembers).values({
        companyId: company.id,
        projectId: privateProject.id,
        subjectType: "agent",
        subjectId: summarizer.id,
      });
    }
    const openIssue = await db.insert(issues).values({
      companyId: company.id,
      identifier: `${prefix}-101`,
      title: OPEN_TITLE,
      status: "todo",
      priority: "medium",
      createdByUserId: "synthetic-owner",
    }).returning().then((rows) => rows[0]!);
    const privateIssue = await db.insert(issues).values({
      companyId: company.id,
      projectId: privateProject.id,
      identifier: `${prefix}-102`,
      title: PRIVATE_TITLE,
      status: "todo",
      priority: "medium",
      createdByUserId: "synthetic-owner",
    }).returning().then((rows) => rows[0]!);
    return { company, summarizer, openIssue, privateIssue };
  }

  async function seedCard(
    fixture: Awaited<ReturnType<typeof seedFixture>>,
    options: { archived?: boolean } = {},
  ) {
    const { company, openIssue, privateIssue } = fixture;
    const body = `Status: ${OPEN_TITLE} (${openIssue.identifier}) and ${PRIVATE_TITLE} (${privateIssue.identifier}).`;
    const document = await db.insert(documents).values({
      companyId: company.id,
      title: "Synthetic summary",
      format: "markdown",
      latestBody: body,
      latestRevisionNumber: 1,
    }).returning().then((rows) => rows[0]!);
    await db.insert(documentRevisions).values({
      companyId: company.id,
      documentId: document.id,
      revisionNumber: 1,
      title: "Synthetic summary",
      format: "markdown",
      body,
      changeSummary: `Added ${privateIssue.identifier}`,
    });
    const entry = (issue: typeof openIssue) => ({
      status: issue.status,
      updatedAt: issue.updatedAt.toISOString(),
      latestHumanCommentAt: null,
      identifier: issue.identifier,
      title: issue.title,
      assigneeAgentId: null,
      assigneeUserId: null,
    });
    const card = await db.insert(statusCards).values({
      companyId: company.id,
      createdByUserId: "synthetic-owner",
      interestPrompt: "Synthetic scope prompt",
      documentId: document.id,
      queries: [{ scope: "issues", status: ["todo"], sort: "updated", limit: 20, offset: 0 }],
      queryVersion: 1,
      refreshPolicy: { mode: "manual" },
      state: "active",
      fingerprint: { [openIssue.id]: entry(openIssue), [privateIssue.id]: entry(privateIssue) },
      mentionedIssueIds: [openIssue.id, privateIssue.id].sort(),
      archivedAt: options.archived ? new Date() : null,
    }).returning().then((rows) => rows[0]!);
    await db.insert(statusCardUpdates).values({
      cardId: card.id,
      kind: "full",
      trigger: "manual",
      status: "ok",
      finishedAt: new Date(),
      queryVersion: 1,
      changes: [
        { issueId: openIssue.id, identifier: openIssue.identifier!, from: null, to: "todo", changeKind: "new" },
        { issueId: privateIssue.id, identifier: privateIssue.identifier!, from: null, to: "todo", changeKind: "new" },
      ],
      changeSummary: `Added ${privateIssue.identifier}`,
    });
    return card;
  }

  function expectNoPrivate(body: unknown, privateIssue: { id: string; identifier: string | null }) {
    const json = JSON.stringify(body);
    expect(json).not.toContain(privateIssue.id);
    expect(json).not.toContain(privateIssue.identifier!);
    expect(json).not.toContain(PRIVATE_TITLE);
  }

  function expectPrivate(body: unknown, privateIssue: { id: string }) {
    const json = JSON.stringify(body);
    expect(json).toContain(privateIssue.id);
  }

  async function nonMemberSetup() {
    const fixture = await seedFixture();
    const active = await seedCard(fixture);
    const archived = await seedCard(fixture, { archived: true });
    return { ...fixture, active, archived, app: createApp(db, boardActor(fixture.company.id, NON_MEMBER)) };
  }

  it("hides private-project issues from a non-member on the active list", async () => {
    const { app, company, openIssue, privateIssue } = await nonMemberSetup();
    const list = await request(app).get(`/api/companies/${company.id}/status-cards`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expectNoPrivate(list.body, privateIssue);
    expect(Object.keys(list.body[0].fingerprint)).toEqual([openIssue.id]);
    expect(list.body[0].mentionedIssueIds).toEqual([openIssue.id]);
    expect(list.body[0]).toMatchObject({ privacyRedacted: true, summaryBody: null });
  });

  it("hides private-project issues from a non-member on the archived list", async () => {
    const { app, company, archived, privateIssue } = await nonMemberSetup();
    const archivedList = await request(app).get(`/api/companies/${company.id}/status-cards?archived=true`);
    expect(archivedList.status).toBe(200);
    expect(archivedList.body.map((card: { id: string }) => card.id)).toEqual([archived.id]);
    expectNoPrivate(archivedList.body, privateIssue);
  });

  it("hides private-project issues from a non-member on the exact-id read", async () => {
    const { app, active, openIssue, privateIssue } = await nonMemberSetup();
    const detail = await request(app).get(`/api/status-cards/${active.id}`);
    expect(detail.status).toBe(200);
    expectNoPrivate(detail.body, privateIssue);
    expect(detail.body.fingerprint[openIssue.id]).toMatchObject({ title: OPEN_TITLE });
  });

  it("hides private-project issues from a non-member on the update ledger", async () => {
    const { app, active, openIssue, privateIssue } = await nonMemberSetup();
    const updates = await request(app).get(`/api/status-cards/${active.id}/updates`);
    expect(updates.status).toBe(200);
    expectNoPrivate(updates.body, privateIssue);
    expect(updates.body[0].changes).toEqual([expect.objectContaining({ issueId: openIssue.id })]);
    expect(updates.body[0].changeSummary).toBeNull();
  });

  it("hides private-project issues from a non-member on summary revisions", async () => {
    const { app, active, privateIssue } = await nonMemberSetup();
    const revisions = await request(app).get(`/api/status-cards/${active.id}/summary-revisions`);
    expect(revisions.status).toBe(200);
    expect(revisions.body).toHaveLength(1);
    expectNoPrivate(revisions.body, privateIssue);
    expect(revisions.body[0].body).toBeNull();
  });

  it("still shows private-project issues to a project member", async () => {
    const fixture = await seedFixture();
    const { company, privateIssue } = fixture;
    const active = await seedCard(fixture);
    const archived = await seedCard(fixture, { archived: true });
    const app = createApp(db, boardActor(company.id, MEMBER));

    const list = await request(app).get(`/api/companies/${company.id}/status-cards`);
    expect(list.status).toBe(200);
    expectPrivate(list.body, privateIssue);
    expect(list.body[0]).toMatchObject({ privacyRedacted: false });
    expect(list.body[0].summaryBody).toContain(PRIVATE_TITLE);
    expect(list.body[0].mentionedIssueIds).toContain(privateIssue.id);

    const archivedList = await request(app).get(`/api/companies/${company.id}/status-cards?archived=true`);
    expect(archivedList.body.map((card: { id: string }) => card.id)).toEqual([archived.id]);
    expectPrivate(archivedList.body, privateIssue);

    const detail = await request(app).get(`/api/status-cards/${active.id}`);
    expect(detail.body.fingerprint[privateIssue.id]).toMatchObject({ title: PRIVATE_TITLE });

    const updates = await request(app).get(`/api/status-cards/${active.id}/updates`);
    expect(updates.body[0].changes).toHaveLength(2);
    expect(updates.body[0].changeSummary).toContain(privateIssue.identifier!);

    const revisions = await request(app).get(`/api/status-cards/${active.id}/summary-revisions`);
    expect(revisions.body[0].body).toContain(PRIVATE_TITLE);
  });

  async function refreshAndWrite(fixture: Awaited<ReturnType<typeof seedFixture>>) {
    const { company, summarizer, openIssue, privateIssue } = fixture;
    const card = await db.insert(statusCards).values({
      companyId: company.id,
      createdByUserId: "synthetic-owner",
      interestPrompt: "Synthetic scope prompt",
      queries: [{ scope: "issues", status: ["todo"], sort: "updated", limit: 20, offset: 0 }],
      queryVersion: 1,
      refreshPolicy: defaultStatusCardRefreshPolicy,
      state: "active",
      fingerprint: {},
    }).returning().then((rows) => rows[0]!);
    const service = statusCardService(db);
    const refresh = await service.requestRefresh(card.id, { full: true, trigger: "manual" });
    expect(refresh.enqueued).toBe(true);
    const generationIssue = await db.select().from(issues)
      .where(eq(issues.id, refresh.generatingIssue!.id)).then((rows) => rows[0]!);

    const run = await db.insert(heartbeatRuns)
      .values({ companyId: company.id, agentId: summarizer.id, status: "running" })
      .returning().then((rows) => rows[0]!);
    await db.update(issues).set({ checkoutRunId: run.id }).where(eq(issues.id, generationIssue.id));
    await service.writeSummary(card.id, {
      generationIssueId: generationIssue.id,
      markdown: `Tracking ${openIssue.identifier} and ${privateIssue.identifier}.`,
      changeSummary: "Synthetic summary",
    } as Parameters<typeof service.writeSummary>[1], { agentId: summarizer.id, runId: run.id });
    const written = await service.getById(card.id);
    return { generationIssue, written: written! };
  }

  it("builds the generation task only from issues the summarizer can read", async () => {
    const fixture = await seedFixture();
    const { openIssue, privateIssue } = fixture;
    const { generationIssue } = await refreshAndWrite(fixture);
    expect(generationIssue.description).toContain(openIssue.id);
    expectNoPrivate(generationIssue.description, privateIssue);
  });

  it("does not let mention resolution add an issue the summarizer cannot read", async () => {
    const fixture = await seedFixture();
    const { openIssue, privateIssue } = fixture;
    const { written } = await refreshAndWrite(fixture);
    expect(written.mentionedIssueIds).toEqual([openIssue.id]);
    expect(Object.keys(written.fingerprint ?? {})).not.toContain(privateIssue.id);
  });

  it("does not diff a stale stored fingerprint entry the summarizer cannot read into the generation task", async () => {
    // Cards written before summarizer scoping hold an unscoped fingerprint.
    const fixture = await seedFixture();
    const { privateIssue } = fixture;
    const card = await seedCard(fixture);
    await db.update(statusCards).set({ refreshPolicy: defaultStatusCardRefreshPolicy }).where(eq(statusCards.id, card.id));
    const service = statusCardService(db);
    const refresh = await service.requestRefresh(card.id, { trigger: "manual" });
    expect(refresh.enqueued).toBe(true);
    expectNoPrivate(refresh.changes, privateIssue);
    const generationIssue = await db.select().from(issues)
      .where(eq(issues.id, refresh.generatingIssue!.id)).then((rows) => rows[0]!);
    expectNoPrivate(generationIssue.description, privateIssue);
    const ledger = await db.select().from(statusCardUpdates)
      .where(eq(statusCardUpdates.generationIssueId, generationIssue.id));
    expect(ledger).toHaveLength(1);
    expectNoPrivate(ledger[0]!.changes, privateIssue);
  });

  /** Link the seeded summary to an earlier generation task acting for `userId`. */
  async function linkLastSummaryTo(fixture: Awaited<ReturnType<typeof seedFixture>>, cardId: string, userId: string | null) {
    const prior = await db.insert(issues).values({
      companyId: fixture.company.id,
      title: "Synthetic earlier generation task",
      status: "done",
      priority: "medium",
      assigneeAgentId: fixture.summarizer.id,
      responsibleUserId: userId,
    }).returning().then((rows) => rows[0]!);
    await db.update(statusCardUpdates).set({ generationIssueId: prior.id }).where(eq(statusCardUpdates.cardId, cardId));
  }

  it("keeps the previous summary in generation when the summarizer can read every stored issue", async () => {
    const fixture = await seedFixture({ summarizerIsProjectMember: true });
    const card = await seedCard(fixture);
    await linkLastSummaryTo(fixture, card.id, CARD_OWNER);
    await db.update(statusCards).set({ refreshPolicy: defaultStatusCardRefreshPolicy }).where(eq(statusCards.id, card.id));
    const refresh = await statusCardService(db).requestRefresh(card.id, { trigger: "manual" });
    const generationIssue = await db.select().from(issues)
      .where(eq(issues.id, refresh.generatingIssue!.id)).then((rows) => rows[0]!);
    expect(generationIssue.responsibleUserId).toBe(CARD_OWNER);
    expect(generationIssue.description).toContain(`Status: ${OPEN_TITLE}`);
  });

  it("withholds the previous summary when it was written for a different (or unknown) user", async () => {
    for (const writtenFor of [NON_MEMBER, null]) {
      const fixture = await seedFixture({ summarizerIsProjectMember: true });
      const card = await seedCard(fixture);
      await linkLastSummaryTo(fixture, card.id, writtenFor);
      await db.update(statusCards).set({ refreshPolicy: defaultStatusCardRefreshPolicy }).where(eq(statusCards.id, card.id));
      const refresh = await statusCardService(db).requestRefresh(card.id, { trigger: "manual" });
      const generationIssue = await db.select().from(issues)
        .where(eq(issues.id, refresh.generatingIssue!.id)).then((rows) => rows[0]!);
      expect(generationIssue.responsibleUserId).toBe(CARD_OWNER);
      expect(generationIssue.description).not.toContain(`Status: ${OPEN_TITLE}`);
    }
  });

  it("keeps private-project issues in generation when the summarizer is a project member", async () => {
    const fixture = await seedFixture({ summarizerIsProjectMember: true });
    const { openIssue, privateIssue } = fixture;
    const { generationIssue, written } = await refreshAndWrite(fixture);

    expect(generationIssue.description).toContain(privateIssue.id);
    expect(generationIssue.description).toContain(PRIVATE_TITLE);
    expect(written.mentionedIssueIds).toEqual([openIssue.id, privateIssue.id].sort());
  });

  it("scopes PATCH and refresh responses to the caller's read access", async () => {
    const fixture = await seedFixture({ summarizerIsProjectMember: true });
    const { company, privateIssue } = fixture;
    const card = await seedCard(fixture);
    await db.update(statusCards).set({ refreshPolicy: defaultStatusCardRefreshPolicy, fingerprint: {} }).where(eq(statusCards.id, card.id));
    const patchCard = await seedCard(fixture);
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "user",
      principalId: NON_MEMBER,
      permissionKey: "tasks:assign",
    });
    const app = createApp(db, boardActor(company.id, NON_MEMBER));

    const patched = await request(app).patch(`/api/status-cards/${patchCard.id}`).send({ title: "Synthetic renamed card" });
    expect(patched.status).toBe(200);
    expect(patched.body.title).toBe("Synthetic renamed card");
    expectNoPrivate(patched.body, privateIssue);

    const refreshed = await request(app).post(`/api/status-cards/${card.id}/refresh`).send({ full: true });
    expect(refreshed.status).toBe(202);
    expect(refreshed.body.changes.length).toBeGreaterThan(0);
    expectNoPrivate(refreshed.body.changes, privateIssue);
    expectNoPrivate(refreshed.body.card, privateIssue);
  });
});
