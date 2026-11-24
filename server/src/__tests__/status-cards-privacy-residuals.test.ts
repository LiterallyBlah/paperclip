import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  authUsers,
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
import { STATUS_CARD_REACTIVE_MIN_SPACING_SECONDS } from "../services/status-card-update-engine.js";
import { statusCardService } from "../services/status-cards.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// Synthetic fixtures only (BLA-1007 R1/R2/N2). A card covers one open issue and
// one issue inside a private project. MEMBER is a member of that project,
// NON_MEMBER is not; both are active company operators allowed to manage cards.
// The Summarizer is a project member. Its runs act on behalf of the generation
// task's responsible user U (the card's creator, else the company default
// responsible user, else the owner), and the authorization layer intersects
// the Summarizer's read with U's. So a task holds the private title only when
// U can read it too, and R1 proves only the Summarizer and U read the task.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

const PRIVATE_TITLE = "Synthetic restricted item";
const OPEN_TITLE = "Synthetic open item";
const PRIVATE_CHANGE_SUMMARY = `Covered ${PRIVATE_TITLE} moving forward`;
const NON_MEMBER = "synthetic-non-member";
const MEMBER = "synthetic-member";
const VALID_QUERY = { scope: "issues", status: ["todo", "in_progress"], sort: "updated", limit: 20, offset: 0 } as unknown as (typeof statusCards.$inferSelect.queries)[number];

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

/** A Summarizer request as agent_jwt really sends it (middleware/auth.ts):
 * the run's responsible user as `onBehalfOfUserId`, with that user's active
 * memberships (empty when the user does not exist). */
async function agentActor(
  db: Db,
  companyId: string,
  agentId: string,
  runId: string | null,
  onBehalfOfUserId: string,
): Promise<Express.Request["actor"]> {
  const user = await db.select({ id: authUsers.id }).from(authUsers)
    .where(eq(authUsers.id, onBehalfOfUserId)).then((rows) => rows[0] ?? null);
  const memberships = user
    ? await db.select({
      companyId: companyMemberships.companyId,
      membershipRole: companyMemberships.membershipRole,
      status: companyMemberships.status,
    }).from(companyMemberships).where(and(
      eq(companyMemberships.companyId, companyId),
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, onBehalfOfUserId),
      eq(companyMemberships.status, "active"),
    ))
    : [];
  return {
    type: "agent",
    companyId,
    agentId,
    runId,
    source: "agent_jwt",
    onBehalfOfUserId,
    onBehalfOfMemberships: memberships,
  } as Express.Request["actor"];
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
    await db.delete(authUsers);
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
      await db.insert(authUsers).values({
        id: principalId,
        name: principalId,
        email: `${principalId}-${randomUUID()}@example.test`,
        createdAt: new Date(),
        updatedAt: new Date(),
      }).onConflictDoNothing();
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
      // Cards are created by an active operator; MEMBER by default.
      createdByUserId: MEMBER,
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

  /** The user the Summarizer's run acts for: the task's responsible user,
   * which is what heartbeat run preparation resolves for this task. */
  async function generationRunUser(generationIssueId: string) {
    const row = await db.select({ responsibleUserId: issues.responsibleUserId })
      .from(issues).where(eq(issues.id, generationIssueId)).then((rows) => rows[0]!);
    expect(row.responsibleUserId).toBeTruthy();
    return row.responsibleUserId!;
  }

  async function startSummarizerRun(fixture: Fixture, generationIssueId: string) {
    const responsibleUserId = await generationRunUser(generationIssueId);
    const run = await db.insert(heartbeatRuns)
      .values({ companyId: fixture.company.id, agentId: fixture.summarizer.id, status: "running", responsibleUserId })
      .returning().then((rows) => rows[0]!);
    await db.update(issues).set({ checkoutRunId: run.id }).where(eq(issues.id, generationIssueId));
    return createApp(db, await agentActor(db, fixture.company.id, fixture.summarizer.id, run.id, responsibleUserId));
  }

  async function summarizerReadApp(fixture: Fixture, generationIssueId: string) {
    return createApp(db, await agentActor(db, fixture.company.id, fixture.summarizer.id, null, await generationRunUser(generationIssueId)));
  }

  // ---------------------------------------------------------------- R1

  it("R1: a manual refresh creates a generation task only the Summarizer and its responsible user can read, and the response omits its payload", async () => {
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
    // The task really carries private data (the card's creator MEMBER can read
    // the private issue, and so can the Summarizer)...
    expect(row.description).toContain(PRIVATE_TITLE);
    // ...so it is private, has no creating user, its one implicit user reader
    // is the card's creator (the run's on-behalf user), and it is assigned to
    // the Summarizer. The refreshing NON_MEMBER gains nothing.
    expect(row).toMatchObject({
      visibility: "private",
      createdByUserId: null,
      responsibleUserId: MEMBER,
      assigneeAgentId: summarizer.id,
    });

    // The manual path still wakes the Summarizer for this task.
    expect(wakes).toHaveLength(1);
    expect(JSON.stringify(wakes[0])).toContain(generationIssueId);

    // Direct read by id: the non-member is refused. The Summarizer, acting on
    // behalf of the task's responsible user as its real run does (B1), reads it.
    const denied = await readIssue(fixture.apps.nonMember, generationIssueId);
    expect([403, 404]).toContain(denied.status);
    expect(JSON.stringify(denied.body)).not.toContain(PRIVATE_TITLE);
    const summarizerRead = await readIssue(await summarizerReadApp(fixture, generationIssueId), generationIssueId);
    expect(summarizerRead.status).toBe(200);
    expect(summarizerRead.body.description).toContain(PRIVATE_TITLE);
    // The Summarizer acting for a different user is refused (no wider set).
    const otherUser = await readIssue(createApp(db, await agentActor(db, fixture.company.id, summarizer.id, null, NON_MEMBER)), generationIssueId);
    expect([403, 404]).toContain(otherUser.status);
  });

  it("R1/B1: the payload is built in the Summarizer-on-behalf-of-U scope, so U sees only what U can already read", async () => {
    const fixture = await seedFixture();
    const { privateIssue, openIssue, summarizer, apps } = fixture;
    // A card created by NON_MEMBER, who cannot read the private issue.
    const card = await seedCard(fixture, { createdByUserId: NON_MEMBER });

    const refreshed = await request(apps.member).post(`/api/status-cards/${card.id}/refresh`).send({ full: true });
    expect(refreshed.status).toBe(202);
    const generationIssueId = refreshed.body.generatingIssue.id as string;
    const row = await db.select().from(issues).where(eq(issues.id, generationIssueId)).then((rows) => rows[0]!);
    expect(row).toMatchObject({ visibility: "private", responsibleUserId: NON_MEMBER, assigneeAgentId: summarizer.id });
    // The Summarizer alone could read the private issue, but the run acts for
    // NON_MEMBER, so the payload holds only the open issue.
    expect(row.description).toContain(OPEN_TITLE);
    expect(row.description).toContain(openIssue.identifier!);
    expect(row.description).not.toContain(PRIVATE_TITLE);
    expect(row.description).not.toContain(privateIssue.id);
    expect(row.description).not.toContain(privateIssue.identifier!);

    // NON_MEMBER, the responsible user, reads the task but finds nothing new.
    const asOwner = await readIssue(apps.nonMember, generationIssueId);
    expect(asOwner.status).toBe(200);
    expectNoPrivatePayload(asOwner.body, privateIssue);
    // MEMBER (not the responsible user) is refused even though it can read the
    // private issue; the Summarizer's run (for NON_MEMBER) reads the task.
    expect([403, 404]).toContain((await readIssue(apps.member, generationIssueId)).status);
    expect((await readIssue(await summarizerReadApp(fixture, generationIssueId), generationIssueId)).status).toBe(200);
  });

  it("R1/B1: with no card creator the company default responsible user is used, and with no active user nothing is created", async () => {
    const fixture = await seedFixture();
    const { company, privateIssue } = fixture;
    await db.update(companies).set({ defaultResponsibleUserId: NON_MEMBER }).where(eq(companies.id, company.id));
    const card = await seedCard(fixture, { createdByUserId: null });
    const refreshed = await request(fixture.apps.member).post(`/api/status-cards/${card.id}/refresh`).send({ full: true });
    expect(refreshed.status).toBe(202);
    const row = await db.select().from(issues)
      .where(eq(issues.id, refreshed.body.generatingIssue.id)).then((rows) => rows[0]!);
    expect(row).toMatchObject({ visibility: "private", responsibleUserId: NON_MEMBER });
    expect(row.description).not.toContain(PRIVATE_TITLE);
    expect(row.description).not.toContain(privateIssue.identifier!);

    // An inactive creator and an inactive default: no candidate, fail closed.
    await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.companyId, company.id));
    const orphan = await seedCard(fixture, { createdByUserId: MEMBER });
    const issueCount = (await db.select({ id: issues.id }).from(issues)).length;
    await expect(statusCardService(db).requestRefresh(orphan.id, { full: true }))
      .rejects.toMatchObject({ status: 422 });
    expect((await db.select({ id: issues.id }).from(issues)).length).toBe(issueCount);
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
    expect(compileRow).toMatchObject({
      visibility: "private",
      createdByUserId: null,
      responsibleUserId: MEMBER,
      assigneeAgentId: fixture.summarizer.id,
    });
    expect(compileRow.description).toContain("Synthetic scope prompt");
    expect([403, 404]).toContain((await readIssue(fixture.apps.nonMember, compileRow.id)).status);
    expect((await readIssue(await summarizerReadApp(fixture, compileRow.id), compileRow.id)).status).toBe(200);
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
    expect(generatingIssue).toMatchObject({
      visibility: "private",
      createdByUserId: null,
      responsibleUserId: MEMBER,
      assigneeAgentId: fixture.summarizer.id,
    });
    // The Summarizer's scheduler-woken run (system wake, so it resolves the
    // task's responsible user) can read the task.
    expect((await readIssue(await summarizerReadApp(fixture, generatingIssue.id), generatingIssue.id)).status).toBe(200);

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
    expect(compileIssue).toMatchObject({
      visibility: "private",
      createdByUserId: null,
      responsibleUserId: MEMBER,
      assigneeAgentId: summarizer.id,
    });

    // The Summarizer (on behalf of MEMBER, as its run is) reads the task and
    // writes the query and the first summary from it.
    const compileApp = await startSummarizerRun(fixture, compileIssueId);
    expect((await readIssue(compileApp, compileIssueId)).status).toBe(200);
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

    // Cadence: v2026.1117.0 evaluates a reactive card on change events, not
    // by polling. An idle tick leaves no polling deadline behind.
    const reactive = { ...defaultStatusCardRefreshPolicy, mode: "reactive" as const, debounceSeconds: 60 };
    const t0 = new Date(Date.now() + 1000);
    await db.update(statusCards).set({ refreshPolicy: reactive, nextEvalAt: new Date(t0.getTime() - 1) })
      .where(eq(statusCards.id, created.body.id));
    const issueCountBefore = (await db.select({ id: issues.id }).from(issues)).length;

    // A tick with no watched-state change starts no model run.
    expect(await service.tickDueStatusCards(t0)).toMatchObject({ evaluated: 1, enqueued: [] });
    expect((await db.select({ id: issues.id }).from(issues)).length).toBe(issueCountBefore);
    const afterIdle = await service.getById(created.body.id);
    expect(afterIdle!.nextEvalAt).toBeNull();
    const changed = new Set([afterIdle!.companyId]);

    // A change to an underlying (private) task triggers a reactive update once
    // the debounce passes and the minimum spacing since the first summary has
    // elapsed (a burst after a generation is coalesced into one run).
    await db.update(issues).set({ status: "in_progress", updatedAt: new Date() }).where(eq(issues.id, privateIssue.id));
    const t1 = new Date(t0.getTime() + 60_000);
    expect(await service.tickDueStatusCards(t1, changed)).toMatchObject({ evaluated: 1, enqueued: [] });
    const waiting = await service.getById(created.body.id);
    const spacedUntil = waiting!.lastGeneratedAt!.getTime() + STATUS_CARD_REACTIVE_MIN_SPACING_SECONDS * 1000;
    expect(waiting!.nextEvalAt!.getTime()).toBe(Math.max(t1.getTime() + 60_000, spacedUntil));
    const t2 = new Date(Math.max(t1.getTime() + 61_000, spacedUntil + 1000));
    const tick = await service.tickDueStatusCards(t2, changed);
    expect(tick.enqueued).toHaveLength(1);
    const updateIssue = tick.enqueued[0]!.generatingIssue;
    expect(updateIssue).toMatchObject({
      visibility: "private",
      createdByUserId: null,
      responsibleUserId: MEMBER,
      assigneeAgentId: summarizer.id,
    });
    expect(updateIssue.description).toContain(PRIVATE_TITLE);
    expect([403, 404]).toContain((await readIssue(apps.nonMember, updateIssue.id)).status);

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

  it("cadence: the tick releases a card whose generation task ended without a write (BLA-1691)", async () => {
    // BLA-1487 reported this gap; BLA-1691 closes it in the existing tick. The
    // task here ends by a direct row update, so no transition hook ran. Retry
    // timing is covered in status-cards.test.ts.
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
    const released = await db.select().from(statusCards).where(eq(statusCards.id, card.id)).then((rows) => rows[0]!);
    expect(released).toMatchObject({ generatingIssueId: null, state: "error", failureReason: expect.stringContaining("cancelled") });
    // The release carries no private payload into the visible failure reason.
    expect(released.failureReason).not.toContain(PRIVATE_TITLE);
    // A manual refresh still runs.
    const manual = await request(fixture.apps.member).post(`/api/status-cards/${card.id}/refresh`).send({ full: true });
    expect(manual.status).toBe(202);
  });
});
