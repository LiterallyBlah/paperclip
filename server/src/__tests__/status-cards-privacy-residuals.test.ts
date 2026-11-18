import { createHash, randomUUID } from "node:crypto";
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
  issueAccessGrants,
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
import { activityRoutes } from "../routes/activity.js";
import { issueRoutes } from "../routes/issues.js";
import { statusCardRoutes } from "../routes/status-cards.js";
import { withBuiltInAgentMarker } from "../lib/built-in-agent-metadata.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "../services/issue-assignment-wakeup.js";
import { statusCardService } from "../services/status-cards.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// Synthetic fixtures only (BLA-1007 R1/R2/N2). A card covers one open issue and
// one issue inside a private project. MEMBER is a member of that project,
// NON_MEMBER is not; both are active company operators allowed to manage cards.
// The Summarizer is a project member, so its generation tasks really do hold
// the private title: R1 proves only the Summarizer can read them.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

const PRIVATE_TITLE = "Synthetic restricted item";
const OPEN_TITLE = "Synthetic open item";
const PRIVATE_CHANGE_SUMMARY = `Covered ${PRIVATE_TITLE} moving forward`;
const NON_MEMBER = "synthetic-non-member";
const MEMBER = "synthetic-member";
const VALID_QUERY = { scope: "issues", status: ["todo", "in_progress"], sort: "updated", limit: 20, offset: 0 };

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

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

function agentActor(companyId: string, agentId: string, runId: string | null): Express.Request["actor"] {
  return { type: "agent", companyId, agentId, runId, source: "agent_jwt" };
}

type WakeCall = Parameters<IssueAssignmentWakeupDeps["wakeup"]>;

function createApp(db: Db, actor: Express.Request["actor"], wakes: WakeCall[] = []) {
  const heartbeat: IssueAssignmentWakeupDeps = {
    wakeup: async (...args) => {
      wakes.push(args);
      return { queued: true } as Awaited<ReturnType<IssueAssignmentWakeupDeps["wakeup"]>>;
    },
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", statusCardRoutes(db, { heartbeat }));
  app.use("/api", issueRoutes(db, {} as any));
  app.use("/api", activityRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("status card residual privacy (R1/R2/N2)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-status-card-residual-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(costEvents);
    await db.delete(statusCardUpdates);
    await db.delete(statusCards);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.delete(issueAccessGrants);
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

  async function seedFixture() {
    const prefix = `SR${randomUUID().slice(0, 6).toUpperCase()}`;
    const company = await db.insert(companies)
      .values({ name: "Residual Co", issuePrefix: prefix })
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
      await db.insert(principalPermissionGrants).values({
        companyId: company.id,
        principalType: "user",
        principalId,
        permissionKey: "tasks:assign",
      });
    }
    const privateProject = await db.insert(projects).values({
      companyId: company.id,
      name: "Synthetic private project",
      visibility: "private",
      status: "in_progress",
    }).returning().then((rows) => rows[0]!);
    await db.insert(projectAccessMembers).values([
      { companyId: company.id, projectId: privateProject.id, subjectType: "user", subjectId: MEMBER },
      { companyId: company.id, projectId: privateProject.id, subjectType: "agent", subjectId: summarizer.id },
    ]);
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
    const apps = {
      nonMember: createApp(db, boardActor(company.id, NON_MEMBER)),
      member: createApp(db, boardActor(company.id, MEMBER)),
    };
    return { company, summarizer, openIssue, privateIssue, apps };
  }

  type Fixture = Awaited<ReturnType<typeof seedFixture>>;

  /** A compiled card with a summary, one ledger row and one revision. */
  async function seedCard(fixture: Fixture, overrides: Partial<typeof statusCards.$inferInsert> = {}) {
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
      changeSummary: PRIVATE_CHANGE_SUMMARY,
    });
    const card = await db.insert(statusCards).values({
      companyId: company.id,
      createdByUserId: "synthetic-owner",
      interestPrompt: "Synthetic scope prompt",
      documentId: document.id,
      queries: [VALID_QUERY],
      queryVersion: 1,
      refreshPolicy: defaultStatusCardRefreshPolicy,
      state: "active",
      fingerprint: {},
      mentionedIssueIds: [],
      ...overrides,
    }).returning().then((rows) => rows[0]!);
    await db.insert(statusCardUpdates).values({
      cardId: card.id,
      kind: "full",
      trigger: "manual",
      status: "ok",
      finishedAt: new Date(),
      queryVersion: 1,
      changes: [{ issueId: openIssue.id, identifier: openIssue.identifier!, from: null, to: "todo", changeKind: "new" }],
      changeSummary: PRIVATE_CHANGE_SUMMARY,
    });
    return card;
  }

  async function readIssue(app: express.Express, issueId: string) {
    return request(app).get(`/api/issues/${issueId}`);
  }

  function expectNoPrivatePayload(body: unknown, privateIssue: { id: string; identifier: string | null }) {
    const json = JSON.stringify(body);
    expect(json).not.toContain(privateIssue.id);
    expect(json).not.toContain(privateIssue.identifier!);
    expect(json).not.toContain(PRIVATE_TITLE);
  }

  async function startSummarizerRun(fixture: Fixture, generationIssueId: string) {
    const run = await db.insert(heartbeatRuns)
      .values({ companyId: fixture.company.id, agentId: fixture.summarizer.id, status: "running" })
      .returning().then((rows) => rows[0]!);
    await db.update(issues).set({ checkoutRunId: run.id }).where(eq(issues.id, generationIssueId));
    return createApp(db, agentActor(fixture.company.id, fixture.summarizer.id, run.id));
  }

  // ---------------------------------------------------------------- R1

  it("R1: a manual refresh creates a generation task only the Summarizer can read, and the response omits its payload", async () => {
    const fixture = await seedFixture();
    const { privateIssue, summarizer } = fixture;
    const card = await seedCard(fixture);
    const wakes: WakeCall[] = [];
    const nonMemberApp = createApp(db, boardActor(fixture.company.id, NON_MEMBER), wakes);

    const refreshed = await request(nonMemberApp).post(`/api/status-cards/${card.id}/refresh`).send({ full: true });
    expect(refreshed.status).toBe(202);
    expect(Object.keys(refreshed.body.generatingIssue).sort())
      .toEqual(["assigneeAgentId", "id", "identifier", "status", "title"]);
    expect(refreshed.body.generatingIssue).not.toHaveProperty("description");
    expectNoPrivatePayload(refreshed.body, privateIssue);

    const generationIssueId = refreshed.body.generatingIssue.id as string;
    const row = await db.select().from(issues).where(eq(issues.id, generationIssueId)).then((rows) => rows[0]!);
    // The task really carries Summarizer-scoped private data...
    expect(row.description).toContain(PRIVATE_TITLE);
    // ...so it is private, has no creating user (an implicit reader), and is
    // assigned to the Summarizer.
    expect(row).toMatchObject({ visibility: "private", createdByUserId: null, assigneeAgentId: summarizer.id });

    // The manual path still wakes the Summarizer for this task.
    expect(wakes).toHaveLength(1);
    expect(JSON.stringify(wakes[0])).toContain(generationIssueId);

    // Direct read by id: the non-member and the project member are refused;
    // only the Summarizer reads it.
    for (const app of [fixture.apps.nonMember, fixture.apps.member]) {
      const denied = await readIssue(app, generationIssueId);
      expect([403, 404]).toContain(denied.status);
      expect(JSON.stringify(denied.body)).not.toContain(PRIVATE_TITLE);
    }
    const summarizerRead = await readIssue(createApp(db, agentActor(fixture.company.id, summarizer.id, null)), generationIssueId);
    expect(summarizerRead.status).toBe(200);
    expect(summarizerRead.body.description).toContain(PRIVATE_TITLE);
  });

  it("R1: a member refresh response and the recompile response also omit the generation payload", async () => {
    const fixture = await seedFixture();
    const card = await seedCard(fixture);

    const refreshed = await request(fixture.apps.member).post(`/api/status-cards/${card.id}/refresh`).send({ full: true });
    expect(refreshed.status).toBe(202);
    expect(refreshed.body.generatingIssue).not.toHaveProperty("description");
    expect(JSON.stringify(refreshed.body.generatingIssue)).not.toContain(PRIVATE_TITLE);
    // A member still gets the full, unredacted card and change list.
    expect(refreshed.body.changes.map((change: { issueId: string }) => change.issueId)).toContain(fixture.privateIssue.id);

    const otherCard = await seedCard(fixture);
    const recompiled = await request(fixture.apps.member).post(`/api/status-cards/${otherCard.id}/recompile`).send({});
    expect(recompiled.status).toBe(202);
    expect(Object.keys(recompiled.body.generatingIssue).sort())
      .toEqual(["assigneeAgentId", "id", "identifier", "status", "title"]);
    const compileRow = await db.select().from(issues)
      .where(eq(issues.id, recompiled.body.generatingIssue.id)).then((rows) => rows[0]!);
    expect(compileRow).toMatchObject({ visibility: "private", createdByUserId: null, assigneeAgentId: fixture.summarizer.id });
    expect(compileRow.description).toContain("Synthetic scope prompt");
    for (const app of [fixture.apps.nonMember, fixture.apps.member]) {
      expect([403, 404]).toContain((await readIssue(app, compileRow.id)).status);
    }
  });

  it("R1: the scheduler path creates a private task and the index.ts wakeup still reaches the Summarizer", async () => {
    const fixture = await seedFixture();
    const now = new Date();
    const card = await seedCard(fixture, {
      refreshPolicy: { ...defaultStatusCardRefreshPolicy, mode: "interval", intervalMinutes: 15 },
      nextEvalAt: new Date(now.getTime() - 1000),
    });
    const tick = await statusCardService(db).tickDueStatusCards(now);
    expect(tick.enqueued).toHaveLength(1);
    const { cardId, generatingIssue } = tick.enqueued[0]!;
    expect(cardId).toBe(card.id);
    expect(generatingIssue).toMatchObject({ visibility: "private", createdByUserId: null, assigneeAgentId: fixture.summarizer.id });

    // The same call server/src/index.ts makes for each enqueued task.
    const wakes: WakeCall[] = [];
    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup: async (...args) => { wakes.push(args); return { queued: true } as any; } },
      issue: generatingIssue,
      reason: "status_card_update_assigned",
      mutation: "status_card.scheduler_update_requested",
      contextSource: "status_card_scheduler",
      requestedByActorType: "system",
      taskKey: `status-card:${cardId}`,
      rethrowOnError: true,
    });
    expect(wakes).toHaveLength(1);
    expect(wakes[0]![0]).toBe(fixture.summarizer.id);
  });

  // ------------------------------------------------- R2 + regression flow

  it("R2 + regression: compile, first summary and a reactive update work, and activity logs only digests", async () => {
    const fixture = await seedFixture();
    const { company, privateIssue, summarizer, apps } = fixture;
    const service = statusCardService(db);

    // Compile requested by an authorised member.
    const created = await request(apps.member)
      .post(`/api/companies/${company.id}/status-cards`)
      .send({ interestPrompt: "Synthetic launch scope" });
    expect(created.status).toBe(201);
    const compileIssueId = created.body.generatingIssueId as string;
    const compileIssue = await db.select().from(issues).where(eq(issues.id, compileIssueId)).then((rows) => rows[0]!);
    expect(compileIssue).toMatchObject({ visibility: "private", createdByUserId: null, assigneeAgentId: summarizer.id });

    // The Summarizer writes the query and the first summary from that task.
    const compileApp = await startSummarizerRun(fixture, compileIssueId);
    const queryWrite = await request(compileApp).put(`/api/status-cards/${created.body.id}/query`).send({
      queries: [VALID_QUERY],
      title: "Synthetic launch",
      changeSummary: PRIVATE_CHANGE_SUMMARY,
      generationIssueId: compileIssueId,
    });
    expect(queryWrite.status).toBe(200);
    const firstMarkdown = `Tracking ${fixture.openIssue.identifier} and ${PRIVATE_TITLE} (${privateIssue.identifier}).`;
    const summaryWrite = await request(compileApp).put(`/api/status-cards/${created.body.id}/summary`).send({
      markdown: firstMarkdown,
      changeSummary: PRIVATE_CHANGE_SUMMARY,
      generationIssueId: compileIssueId,
      model: "synthetic-model",
    });
    expect(summaryWrite.status).toBe(200);

    const memberCard = await request(apps.member).get(`/api/status-cards/${created.body.id}`);
    expect(memberCard.body).toMatchObject({ privacyRedacted: false, summaryBody: firstMarkdown });
    const nonMemberCard = await request(apps.nonMember).get(`/api/status-cards/${created.body.id}`);
    expect(nonMemberCard.body).toMatchObject({ privacyRedacted: true, summaryBody: null });
    expectNoPrivatePayload(nonMemberCard.body, privateIssue);

    // R2: status_card activity rows hold only a length + hash of the text.
    const stored = await db.select().from(activityLog).where(eq(activityLog.entityType, "status_card"));
    expect(stored.map((row) => row.action).sort())
      .toEqual(["status_card.created", "status_card.query_written", "status_card.summary_written"]);
    expect(JSON.stringify(stored)).not.toContain(PRIVATE_TITLE);
    const digest = { length: PRIVATE_CHANGE_SUMMARY.length, sha256: sha256(PRIVATE_CHANGE_SUMMARY) };
    const queryRow = stored.find((row) => row.action === "status_card.query_written")!;
    expect(queryRow.details).toMatchObject({
      changeSummary: digest,
      queryCount: 1,
      // Digest of the validated (default-filled) query array, never the text.
      queries: { length: expect.any(Number), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
    expect(stored.find((row) => row.action === "status_card.summary_written")!.details)
      .toMatchObject({ changeSummary: digest });

    for (const app of [apps.nonMember, apps.member]) {
      const activity = await request(app).get(`/api/companies/${company.id}/activity?entityType=status_card`);
      expect(activity.status).toBe(200);
      expect(activity.body.length).toBeGreaterThanOrEqual(3);
      expect(JSON.stringify(activity.body)).not.toContain(PRIVATE_TITLE);
    }
    // The member keeps the full text through the card's own ledger.
    const memberUpdates = await request(apps.member).get(`/api/status-cards/${created.body.id}/updates`);
    expect(memberUpdates.body.map((row: { changeSummary: string | null }) => row.changeSummary)).toContain(PRIVATE_CHANGE_SUMMARY);
    const nonMemberUpdates = await request(apps.nonMember).get(`/api/status-cards/${created.body.id}/updates`);
    expect(JSON.stringify(nonMemberUpdates.body)).not.toContain(PRIVATE_TITLE);

    // Cadence: a reactive card is re-evaluated at most 60 s after each tick.
    const reactive = { ...defaultStatusCardRefreshPolicy, mode: "reactive" as const, debounceSeconds: 60 };
    const t0 = new Date(Date.now() + 1000);
    await db.update(statusCards).set({ refreshPolicy: reactive, nextEvalAt: new Date(t0.getTime() - 1) })
      .where(eq(statusCards.id, created.body.id));
    const issueCountBefore = (await db.select({ id: issues.id }).from(issues)).length;

    // A tick with no watched-state change starts no model run.
    expect(await service.tickDueStatusCards(t0)).toMatchObject({ evaluated: 1, enqueued: [] });
    expect((await db.select({ id: issues.id }).from(issues)).length).toBe(issueCountBefore);
    const afterIdle = await service.getById(created.body.id);
    expect(afterIdle!.nextEvalAt!.getTime() - t0.getTime()).toBe(60_000);

    // A change to an underlying (private) task triggers a reactive update once
    // the debounce passes.
    await db.update(issues).set({ status: "in_progress", updatedAt: new Date() }).where(eq(issues.id, privateIssue.id));
    const t1 = new Date(t0.getTime() + 60_000);
    expect(await service.tickDueStatusCards(t1)).toMatchObject({ evaluated: 1, enqueued: [] });
    const t2 = new Date(t1.getTime() + 61_000);
    const tick = await service.tickDueStatusCards(t2);
    expect(tick.enqueued).toHaveLength(1);
    const updateIssue = tick.enqueued[0]!.generatingIssue;
    expect(updateIssue).toMatchObject({ visibility: "private", createdByUserId: null, assigneeAgentId: summarizer.id });
    expect(updateIssue.description).toContain(PRIVATE_TITLE);
    for (const app of [apps.nonMember, apps.member]) {
      expect([403, 404]).toContain((await readIssue(app, updateIssue.id)).status);
    }

    // The Summarizer reads its task and writes the normal update.
    const updateApp = await startSummarizerRun(fixture, updateIssue.id);
    expect((await readIssue(updateApp, updateIssue.id)).status).toBe(200);
    const updatedMarkdown = `${PRIVATE_TITLE} (${privateIssue.identifier}) is now in progress.`;
    const update = await request(updateApp).put(`/api/status-cards/${created.body.id}/summary`).send({
      markdown: updatedMarkdown,
      changeSummary: PRIVATE_CHANGE_SUMMARY,
      generationIssueId: updateIssue.id,
      model: "synthetic-model",
    });
    expect(update.status).toBe(200);
    expect((await request(apps.member).get(`/api/status-cards/${created.body.id}`)).body.summaryBody).toBe(updatedMarkdown);
    expect((await request(apps.nonMember).get(`/api/status-cards/${created.body.id}`)).body.summaryBody).toBeNull();
    expect(JSON.stringify(await db.select().from(activityLog).where(eq(activityLog.entityType, "status_card"))))
      .not.toContain(PRIVATE_TITLE);
  });

  // ---------------------------------------------------------------- N2

  it("N2: every card read path fails closed when the watched-issue visibility read throws", async () => {
    const fixture = await seedFixture();
    const { company, privateIssue, apps } = fixture;
    // A stored query that no longer parses makes the visibility read throw.
    const card = await seedCard(fixture, { queries: [{ scope: "not-a-scope" } as never] });

    for (const app of [apps.nonMember, apps.member]) {
      const detail = await request(app).get(`/api/status-cards/${card.id}`);
      expect(detail.status).toBe(200);
      // The failure branch ran (no count) and the summary is withheld.
      expect(detail.body).not.toHaveProperty("watchedIssueCount");
      expect(detail.body).toMatchObject({ privacyRedacted: true, summaryBody: null });

      const list = await request(app).get(`/api/companies/${company.id}/status-cards`);
      expect(list.status).toBe(200);
      expect(list.body[0]).toMatchObject({ privacyRedacted: true, summaryBody: null });

      const updates = await request(app).get(`/api/status-cards/${card.id}/updates`);
      expect(updates.status).toBe(200);
      expect(updates.body[0].changeSummary).toBeNull();

      const revisions = await request(app).get(`/api/status-cards/${card.id}/summary-revisions`);
      expect(revisions.status).toBe(200);
      expect(revisions.body[0]).toMatchObject({ body: null, changeSummary: null });

      const patched = await request(app).patch(`/api/status-cards/${card.id}`).send({ titlePinned: true });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({ privacyRedacted: true, summaryBody: null });

      for (const body of [detail.body, list.body, updates.body, revisions.body, patched.body]) {
        expect(JSON.stringify(body)).not.toContain(PRIVATE_TITLE);
        expect(JSON.stringify(body)).not.toContain(privateIssue.identifier!);
      }
    }

    // Control: with a parsable query the member reads the same card in full.
    await db.update(statusCards).set({ queries: [VALID_QUERY] }).where(eq(statusCards.id, card.id));
    const memberDetail = await request(apps.member).get(`/api/status-cards/${card.id}`);
    expect(memberDetail.body).toMatchObject({ privacyRedacted: false });
    expect(memberDetail.body.summaryBody).toContain(PRIVATE_TITLE);
    const memberRevisions = await request(apps.member).get(`/api/status-cards/${card.id}/summary-revisions`);
    expect(memberRevisions.body[0].body).toContain(PRIVATE_TITLE);
  });

  // ------------------------------------------------------------ cadence

  it("cadence gap (characterisation): a card whose generation task ended without a write is not re-evaluated", async () => {
    // Documents current behaviour for the BLA-1487 cadence report; not a fix.
    // tickDueStatusCards only selects cards with no generatingIssueId, and the
    // link clears only on a successful summary write or archive.
    const fixture = await seedFixture();
    const now = new Date();
    const card = await seedCard(fixture, {
      refreshPolicy: { ...defaultStatusCardRefreshPolicy, mode: "reactive", debounceSeconds: 60 },
      nextEvalAt: new Date(now.getTime() - 1000),
    });
    const ended = await db.insert(issues).values({
      companyId: fixture.company.id,
      title: "Synthetic ended generation task",
      status: "cancelled",
      priority: "medium",
      assigneeAgentId: fixture.summarizer.id,
    }).returning().then((rows) => rows[0]!);
    await db.update(statusCards).set({ generatingIssueId: ended.id }).where(eq(statusCards.id, card.id));
    expect(await statusCardService(db).tickDueStatusCards(now)).toMatchObject({ evaluated: 0, enqueued: [] });
    // A manual refresh still supersedes the ended task.
    const manual = await request(fixture.apps.member).post(`/api/status-cards/${card.id}/refresh`).send({ full: true });
    expect(manual.status).toBe(202);
  });
});
