import { createHmac, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  companySecrets,
  companySecretVersions,
  companySecretBindings,
  secretAccessEvents,
  createDb,
  documentAnnotationAnchorSnapshots,
  documentAnnotationComments,
  documentAnnotationThreads,
  documentRevisions,
  documents,
  executionWorkspaces,
  folders,
  heartbeatRunEvents,
  heartbeatRuns,
  instanceSettings,
  issues,
  principalPermissionGrants,
  projectAccessMembers,
  projectWorkspaces,
  projects,
  routineDocuments,
  routineRevisions,
  routineRuns,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { accessService } from "../services/access.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";

function registerRoutineServiceMock() {
  vi.doMock("../services/routines.js", async () => {
    const actual = await vi.importActual<typeof import("../services/routines.js")>("../services/routines.js");

    return {
      ...actual,
      routineService: (db: any) =>
        actual.routineService(db, {
          heartbeat: {
            wakeup: async (agentId: string, wakeupOpts: any) => {
              const issueId =
                (typeof wakeupOpts?.payload?.issueId === "string" && wakeupOpts.payload.issueId) ||
                (typeof wakeupOpts?.contextSnapshot?.issueId === "string" && wakeupOpts.contextSnapshot.issueId) ||
                null;
              if (!issueId) return null;

              const issue = await db
                .select({ companyId: issues.companyId })
                .from(issues)
                .where(eq(issues.id, issueId))
                .then((rows: Array<{ companyId: string }>) => rows[0] ?? null);
              if (!issue) return null;

              const queuedRunId = randomUUID();
              await db.insert(heartbeatRuns).values({
                id: queuedRunId,
                companyId: issue.companyId,
                agentId,
                invocationSource: wakeupOpts?.source ?? "assignment",
                triggerDetail: wakeupOpts?.triggerDetail ?? null,
                status: "queued",
                contextSnapshot: { ...(wakeupOpts?.contextSnapshot ?? {}), issueId },
              });
              await db
                .update(issues)
                .set({
                  executionRunId: queuedRunId,
                  executionLockedAt: new Date(),
                })
                .where(eq(issues.id, issueId));
              return { id: queuedRunId };
            },
          },
        }),
    };
  });
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routine route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("routine routes end-to-end", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routines-e2e-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.delete(activityLog);
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(documentAnnotationAnchorSnapshots);
    await db.delete(documentAnnotationComments);
    await db.delete(documentAnnotationThreads);
    await db.delete(routineRuns);
    await db.delete(routineTriggers);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(routineDocuments);
    await db.delete(routines);
    await db.delete(folders);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(projectAccessMembers);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../services/companies.js");
    vi.doUnmock("../services/projects.js");
    vi.doUnmock("../services/company-skills.js");
    vi.doUnmock("../services/assets.js");
    vi.doUnmock("../services/agent-instructions.js");
    vi.doUnmock("../services/workspace-runtime.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/routines.js");
    vi.doUnmock("../routes/routines.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerRoutineServiceMock();
    vi.doMock("../services/index.js", async () => {
      const [{ accessService }, { documentAnnotationService }, { logActivity }, { routineService }, { folderService }] = await Promise.all([
        import("../services/access.js"), import("../services/document-annotations.js"),
        import("../services/activity-log.js"), import("../services/routines.js"),
        import("../services/folders.js"),
      ]);
      return { accessService, documentAnnotationService, logActivity, routineService, folderService };
    });
    vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));
    vi.clearAllMocks();
  });

  async function createApp(actor: Record<string, unknown>) {
    const { errorHandler } = await import("../middleware/index.js");
    const { routineRoutes } = await import("../routes/routines.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", routineRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function createAuthenticatedApp() {
    const { actorMiddleware } = await import("../middleware/auth.js");
    const { routineRoutes } = await import("../routes/routines.js");
    const { errorHandler } = await import("../middleware/index.js");
    const resolveSession = vi.fn(async () => null);
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession }));
    app.use("/api", routineRoutes(db));
    app.use(errorHandler);
    return { app, resolveSession };
  }

  async function postRoutineRun(
    app: express.Express,
    routineId: string,
    body: Record<string, unknown>,
  ) {
    let response = await request(app)
      .post(`/api/routines/${routineId}/run`)
      .send(body);
    if (response.status === 500) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      response = await request(app)
        .post(`/api/routines/${routineId}/run`)
        .send(body);
    }
    return response;
  }

  async function seedFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const userId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Routine Project",
      status: "in_progress",
    });

    const access = accessService(db);
    const membership = await access.ensureMembership(companyId, "user", userId, "owner", "active");
    await access.setMemberPermissions(
      companyId,
      membership.id,
      [{ permissionKey: "tasks:assign" }],
      userId,
    );

    return { companyId, agentId, projectId, userId };
  }

  function routineResourceRequests(app: express.Express, routineId: string, triggerId = routineId) {
    const path = `/api/routines/${encodeURIComponent(routineId)}`;
    const triggerPath = `/api/routine-triggers/${encodeURIComponent(triggerId)}`;
    const nestedId = "12345678-1234-4234-8234-123456789abc";
    return [
      request(app).get(path),
      request(app).get(`${path}/runs`),
      request(app).get(`${path}/revisions`),
      request(app).get(`${path}/description/annotations`),
      request(app).get(`${path}/description/annotations/${nestedId}`),
      request(app).post(`${path}/description/annotations`).send({
        baseRevisionId: nestedId, baseRevisionNumber: 1, body: "Review this text",
        selector: {
          quote: { exact: "text" },
          position: { normalizedStart: 0, normalizedEnd: 4, markdownStart: 0, markdownEnd: 4 },
        },
      }),
      request(app).post(`${path}/description/annotations/${nestedId}/comments`).send({ body: "Review" }),
      request(app).patch(`${path}/description/annotations/${nestedId}`).send({ status: "resolved" }),
      request(app).patch(path).send({ title: "Updated routine" }),
      request(app).post(`${path}/revisions/${nestedId}/restore`).send({}),
      request(app).post(`${path}/triggers`).send({ kind: "api" }),
      request(app).post(`${path}/run`).send({}),
      request(app).patch(triggerPath).send({ enabled: false }),
      request(app).delete(triggerPath),
      request(app).post(`${triggerPath}/rotate-secret`).send({}),
    ];
  }

  it("returns not found without queries for malformed routine and trigger IDs on every resource route", async () => {
    const { companyId, agentId, userId } = await seedFixture();
    const actors = [
      { type: "board", userId, source: "session", companyIds: [companyId] },
      { type: "agent", agentId, companyId },
      { type: "none" },
    ];
    const fullId = "12345678-1234-4234-8234-123456789abc";
    for (const actor of actors) {
      const app = await createApp(actor);
      const spies = [
        vi.spyOn(db, "select"), vi.spyOn(db, "insert"),
        vi.spyOn(db, "update"), vi.spyOn(db, "delete"),
      ];
      try {
        for (const id of [fullId.slice(0, 8), "not-a-uuid", ` ${fullId}`, `${fullId}\n`, `{${fullId}\n}`]) {
          for (const pending of routineResourceRequests(app, id)) {
            const response = (await pending) as unknown as { req: { path: string; method: string }; status: number; body: unknown };
            expect(response.status, JSON.stringify(response.body)).toBe(404);
            expect(response.body).toEqual({ error: pending.url.includes("/routine-triggers/")
              ? "Routine trigger not found" : "Routine not found" });
          }
        }
        const invalidBody = await request(app).patch("/api/routines/not-a-uuid").send({ title: 42 });
        expect(invalidBody.status).toBe(400);
        for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    }
  }, 20_000);

  it("keeps missing and cross-company routine resources indistinguishable", async () => {
    const { companyId, agentId, userId } = await seedFixture();
    const routineId = randomUUID();
    const triggerId = randomUUID();
    await db.insert(routines).values({ id: routineId, companyId, assigneeAgentId: agentId, title: "Private routine" });
    await db.insert(routineTriggers).values({ id: triggerId, companyId, routineId, kind: "api" });
    for (const actor of [
      { type: "board", userId, source: "session", isInstanceAdmin: true, companyIds: [randomUUID()] },
      { type: "agent", agentId: randomUUID(), companyId: randomUUID() },
      { type: "none" },
    ]) {
      const app = await createApp(actor);
      for (const [id, tid] of [[routineId, triggerId], [routineId.toUpperCase(), `{${triggerId}}`], [randomUUID(), randomUUID()]]) {
        for (const pending of routineResourceRequests(app, id!, tid!)) {
          const response = await pending;
          expect(response.status, JSON.stringify(response.body)).toBe(404);
          expect(response.body).toEqual({ error: pending.url.includes("/routine-triggers/")
            ? "Routine trigger not found" : "Routine not found" });
        }
      }
    }
    expect(await db.select().from(routines)).toMatchObject([{ id: routineId, title: "Private routine" }]);
    expect(await db.select().from(routineTriggers)).toMatchObject([{ id: triggerId, enabled: true }]);
    expect(await db.select().from(activityLog)).toEqual([]);
  }, 20_000);

  it("preserves UUID routine reads and assignee-only mutations", async () => {
    const { companyId, agentId, userId } = await seedFixture();
    const routineId = randomUUID();
    const triggerId = randomUUID();
    await db.insert(routines).values({ id: routineId, companyId, assigneeAgentId: agentId, title: "Private routine" });
    await db.insert(routineTriggers).values({ id: triggerId, companyId, routineId, kind: "api" });
    const owner = await createApp({ type: "agent", agentId, companyId });
    const otherAgent = await createApp({ type: "agent", agentId: randomUUID(), companyId });
    const board = await createApp({ type: "board", userId, source: "session", companyIds: [companyId] });
    for (const app of [owner, otherAgent, board]) {
      const response = await request(app).get(`/api/routines/${routineId.toUpperCase()}`);
      expect(response.status).toBe(200);
      expect(response.body.id).toBe(routineId);
    }
    for (const [index, pending] of routineResourceRequests(otherAgent, routineId, triggerId).entries()) {
      const response = await pending;
      expect(response.status, JSON.stringify(response.body)).toBe(index < 2 ? 200 : 403);
    }
    const updated = await request(owner).patch(`/api/routines/${routineId}`).send({ title: "Owner update" });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.title).toBe("Owner update");
    const changedTrigger = await request(board).patch(`/api/routine-triggers/${triggerId}`).send({ enabled: false });
    expect(changedTrigger.status, JSON.stringify(changedTrigger.body)).toBe(200);
    expect(changedTrigger.body.enabled).toBe(false);
  }, 20_000);

  it("LR-1: routine reads follow private-project read access (synthetic)", async () => {
    vi.stubEnv("PAPERCLIP_API_URL", "http://localhost:3100");
    vi.stubEnv("PAPERCLIP_IN_WORKTREE", "false");
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
    const { companyId, agentId, projectId, userId: ownerUserId } = await seedFixture();
    const memberUserId = randomUUID();
    const outsiderUserId = randomUUID();
    const outsiderAgentId = randomUUID();
    await db.insert(agents).values({
      id: outsiderAgentId, companyId, name: "Synthetic Outsider", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    const access = accessService(db);
    await access.ensureMembership(companyId, "user", memberUserId, "member", "active");
    await access.ensureMembership(companyId, "user", outsiderUserId, "member", "active");
    await db.update(projects).set({ visibility: "private", privacyOwnerUserId: ownerUserId }).where(eq(projects.id, projectId));
    await db.insert(projectAccessMembers).values([
      { companyId, projectId, subjectType: "user", subjectId: ownerUserId },
      { companyId, projectId, subjectType: "user", subjectId: memberUserId },
      { companyId, projectId, subjectType: "agent", subjectId: agentId },
    ]);
    const admin = await createApp({ type: "board", source: "local_implicit", userId: ownerUserId, isInstanceAdmin: true });
    const created = await request(admin).post(`/api/companies/${companyId}/routines`).send({
      projectId, assigneeAgentId: agentId, title: "Synthetic private routine", description: "Synthetic",
      concurrencyPolicy: "always_enqueue",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const routineId = created.body.id as string;
    const openRoutineId = randomUUID();
    await db.insert(routines).values({ id: openRoutineId, companyId, assigneeAgentId: agentId, title: "Synthetic no-project routine" });
    const configured = await request(admin).post(`/api/routines/${routineId}/triggers`).send({ kind: "webhook", signingMode: "bearer" });
    expect(configured.status, JSON.stringify(configured.body)).toBe(201);
    const { secretMaterial } = configured.body;

    // The signed public fire endpoint is unchanged.
    const [{ actorMiddleware }, { boardMutationGuard }, { routineRoutes }, { errorHandler }] = await Promise.all([
      import("../middleware/auth.js"), import("../middleware/board-mutation-guard.js"),
      import("../routes/routines.js"), import("../middleware/error-handler.js"),
    ]);
    const ingress = express();
    ingress.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));
    ingress.use(actorMiddleware(db, {
      deploymentMode: "authenticated",
      resolveSession: async () => { throw new Error("Webhook must not resolve a browser session"); },
    }));
    ingress.use("/api", boardMutationGuard(), routineRoutes(db));
    ingress.use(errorHandler);
    const fired = await request(ingress).post(new URL(secretMaterial.webhookUrl).pathname)
      .set("Content-Type", "application/json").set("Authorization", `Bearer ${secretMaterial.webhookSecret}`)
      .send('{ "event": "synthetic" }');
    expect(fired.status, JSON.stringify(fired.body)).toBe(202);

    const board = (userId: string) => ({
      type: "board", userId, source: "session", isInstanceAdmin: false, companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole: "member" }],
    });
    const readPaths = [
      `/api/routines/${routineId}`,
      `/api/routines/${routineId}/runs`,
      `/api/routines/${routineId}/revisions`,
      `/api/routines/${routineId}/description/annotations`,
      `/api/routines/${routineId}/description/annotations/${randomUUID()}`,
    ];
    for (const [name, actor] of [
      ["outsiderUser", board(outsiderUserId)],
      ["outsiderAgent", { type: "agent", agentId: outsiderAgentId, companyId }],
    ] as const) {
      const app = await createApp(actor);
      for (const path of readPaths) {
        const response = await request(app).get(path);
        expect({ name, path, status: response.status, body: response.body })
          .toEqual({ name, path, status: 404, body: { error: "Routine not found" } });
      }
      const list = await request(app).get(`/api/companies/${companyId}/routines`);
      expect(list.status).toBe(200);
      const ids = (list.body as Array<{ id: string }>).map((routine) => routine.id);
      expect(ids).not.toContain(routineId);
      expect(ids).toContain(openRoutineId);
      const filtered = await request(app).get(`/api/companies/${companyId}/routines?projectId=${projectId}`);
      expect(filtered.body).toEqual([]);
    }
    for (const [name, actor] of [
      ["owner", board(ownerUserId)],
      ["memberUser", board(memberUserId)],
      ["memberAgent", { type: "agent", agentId, companyId }],
    ] as const) {
      const app = await createApp(actor);
      for (const path of readPaths.slice(0, 4)) {
        const response = await request(app).get(path);
        expect({ name, path, status: response.status }).toEqual({ name, path, status: 200 });
      }
      const runs = await request(app).get(`/api/routines/${routineId}/runs`);
      expect(runs.body.length).toBeGreaterThan(0);
      const list = await request(app).get(`/api/companies/${companyId}/routines`);
      expect((list.body as Array<{ id: string }>).map((routine) => routine.id)).toEqual(expect.arrayContaining([routineId, openRoutineId]));
    }
  }, 30_000);

  it("Slice H: routine writes follow private-project read access (synthetic)", async () => {
    vi.stubEnv("PAPERCLIP_API_URL", "http://localhost:3100");
    vi.stubEnv("PAPERCLIP_IN_WORKTREE", "false");
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
    const { companyId, agentId, projectId, userId: ownerUserId } = await seedFixture();
    const memberUserId = randomUUID();
    const outsiderUserId = randomUUID();
    const outsiderAgentId = randomUUID();
    const memberOtherAgentId = randomUUID();
    await db.insert(agents).values([
      { id: outsiderAgentId, companyId, name: "Synthetic Outsider", role: "engineer", status: "active",
        adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: memberOtherAgentId, companyId, name: "Synthetic Member Non-Assignee", role: "engineer", status: "active",
        adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    const access = accessService(db);
    await access.ensureMembership(companyId, "user", memberUserId, "member", "active");
    const outsiderMembership = await access.ensureMembership(companyId, "user", outsiderUserId, "member", "active");
    // The outsider may assign tasks in the company, so only project read access stands between it and the routine.
    await access.setMemberPermissions(companyId, outsiderMembership.id, [{ permissionKey: "tasks:assign" }], ownerUserId);
    await db.update(projects).set({ visibility: "private", privacyOwnerUserId: ownerUserId }).where(eq(projects.id, projectId));
    await db.insert(projectAccessMembers).values([
      { companyId, projectId, subjectType: "user", subjectId: ownerUserId },
      { companyId, projectId, subjectType: "user", subjectId: memberUserId },
      { companyId, projectId, subjectType: "agent", subjectId: agentId },
      { companyId, projectId, subjectType: "agent", subjectId: memberOtherAgentId },
    ]);
    const admin = await createApp({ type: "board", source: "local_implicit", userId: ownerUserId, isInstanceAdmin: true });
    const created = await request(admin).post(`/api/companies/${companyId}/routines`).send({
      projectId, assigneeAgentId: agentId, title: "Synthetic private routine", description: "Synthetic private body",
      concurrencyPolicy: "always_enqueue",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const routineId = created.body.id as string;
    const configured = await request(admin).post(`/api/routines/${routineId}/triggers`).send({ kind: "api" });
    expect(configured.status, JSON.stringify(configured.body)).toBe(201);
    const triggerId = configured.body.trigger.id as string;

    const snapshot = async () => ({
      routines: await db.select().from(routines).where(eq(routines.id, routineId)),
      revisions: await db.select().from(routineRevisions).where(eq(routineRevisions.routineId, routineId)),
      triggers: await db.select().from(routineTriggers).where(eq(routineTriggers.routineId, routineId)),
      runs: await db.select().from(routineRuns).where(eq(routineRuns.routineId, routineId)),
      issues: await db.select().from(issues).where(eq(issues.companyId, companyId)),
      threads: await db.select().from(documentAnnotationThreads),
      comments: await db.select().from(documentAnnotationComments),
      activity: await db.select().from(activityLog).where(eq(activityLog.companyId, companyId)),
    });
    const before = await snapshot();
    expect(before.triggers).toHaveLength(1);

    const board = (userId: string) => ({
      type: "board", userId, source: "session", isInstanceAdmin: false, companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole: "member" }],
    });
    for (const [name, actor] of [
      ["outsiderUser", board(outsiderUserId)],
      ["outsiderAgent", { type: "agent", agentId: outsiderAgentId, companyId }],
    ] as const) {
      const app = await createApp(actor);
      for (const [label, id, tid] of [
        ["private", routineId, triggerId],
        ["randomControl", randomUUID(), randomUUID()],
      ] as const) {
        for (const pending of routineResourceRequests(app, id, tid)) {
          const response = (await pending) as unknown as { req: { path: string; method: string }; status: number; body: unknown };
          const expectedError = response.req.path.includes("/routine-triggers/") ? "Routine trigger not found" : "Routine not found";
          expect({ name, label, method: response.req.method, path: response.req.path, status: response.status, body: response.body })
            .toEqual({ name, label, method: response.req.method, path: response.req.path, status: 404, body: { error: expectedError } });
        }
      }
    }
    expect(await snapshot()).toEqual(before);

    // Members keep the existing manage rule: the assignee agent and board members may write, a
    // non-assignee member agent still gets the existing 403.
    const memberAgent = await createApp({ type: "agent", agentId, companyId });
    const agentPatch = await request(memberAgent).patch(`/api/routines/${routineId}`).send({ title: "Synthetic assignee edit" });
    expect(agentPatch.status, JSON.stringify(agentPatch.body)).toBe(200);
    const otherMemberAgent = await createApp({ type: "agent", agentId: memberOtherAgentId, companyId });
    const otherPatch = await request(otherMemberAgent).patch(`/api/routines/${routineId}`).send({ title: "Nope" });
    expect(otherPatch.status).toBe(403);
    const memberUser = await createApp(board(memberUserId));
    const userPatch = await request(memberUser).patch(`/api/routines/${routineId}`).send({ title: "Synthetic member edit" });
    expect(userPatch.status, JSON.stringify(userPatch.body)).toBe(200);
    const owner = await createApp(board(ownerUserId));
    const triggerPatch = await request(owner).patch(`/api/routine-triggers/${triggerId}`).send({ enabled: false });
    expect(triggerPatch.status, JSON.stringify(triggerPatch.body)).toBe(200);
    const run = await postRoutineRun(owner, routineId, {});
    expect(run.status, JSON.stringify(run.body)).toBe(202);
  }, 30_000);

  it("Slice H F-H1: routine writes into a private project follow project read access (synthetic)", async () => {
    vi.stubEnv("PAPERCLIP_API_URL", "http://localhost:3100");
    vi.stubEnv("PAPERCLIP_IN_WORKTREE", "false");
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
    const { companyId, agentId, projectId: privateProjectId, userId: ownerUserId } = await seedFixture();
    const openProjectId = randomUUID();
    await db.insert(projects).values({ id: openProjectId, companyId, name: "Synthetic Open Project", status: "in_progress" });
    const memberUserId = randomUUID();
    const outsiderUserId = randomUUID();
    const outsiderAgentId = randomUUID();
    await db.insert(agents).values({
      id: outsiderAgentId, companyId, name: "Synthetic Outsider", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    const access = accessService(db);
    const memberMembership = await access.ensureMembership(companyId, "user", memberUserId, "member", "active");
    await access.setMemberPermissions(companyId, memberMembership.id, [{ permissionKey: "tasks:assign" }], ownerUserId);
    const outsiderMembership = await access.ensureMembership(companyId, "user", outsiderUserId, "member", "active");
    // The outsider may assign tasks in the company, so only project read access stands between it and the project.
    await access.setMemberPermissions(companyId, outsiderMembership.id, [{ permissionKey: "tasks:assign" }], ownerUserId);
    await db.update(projects).set({ visibility: "private", privacyOwnerUserId: ownerUserId }).where(eq(projects.id, privateProjectId));
    await db.insert(projectAccessMembers).values([
      { companyId, projectId: privateProjectId, subjectType: "user", subjectId: ownerUserId },
      { companyId, projectId: privateProjectId, subjectType: "user", subjectId: memberUserId },
      { companyId, projectId: privateProjectId, subjectType: "agent", subjectId: agentId },
    ]);
    const board = (userId: string) => ({
      type: "board", userId, source: "session", isInstanceAdmin: false, companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole: "member" }],
    });
    const admin = await createApp({ type: "board", source: "local_implicit", userId: ownerUserId, isInstanceAdmin: true });
    const outsiderUser = await createApp(board(outsiderUserId));
    const outsiderAgent = await createApp({ type: "agent", agentId: outsiderAgentId, companyId });

    // The outsiders' own routines: no project. One of them has an earlier revision in the private project
    // (the owner created it there and then moved it out), so restoring that revision would move it back in.
    const createRoutine = async (app: express.Express, body: Record<string, unknown>) => {
      const response = await request(app).post(`/api/companies/${companyId}/routines`).send({
        title: "Synthetic routine", description: "Synthetic body", concurrencyPolicy: "always_enqueue", ...body,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      return response.body as { id: string; latestRevisionId: string };
    };
    const userRoutine = await createRoutine(outsiderUser, { assigneeAgentId: agentId });
    const agentRoutine = await createRoutine(outsiderAgent, { assigneeAgentId: outsiderAgentId });
    const movedOut = await createRoutine(admin, { projectId: privateProjectId, assigneeAgentId: outsiderAgentId });
    const movedOutPatch = await request(admin).patch(`/api/routines/${movedOut.id}`).send({ projectId: null });
    expect(movedOutPatch.status, JSON.stringify(movedOutPatch.body)).toBe(200);
    expect(movedOutPatch.body.projectId).toBeNull();

    const snapshot = async () => ({
      routines: await db.select().from(routines).where(eq(routines.companyId, companyId)),
      revisions: await db.select().from(routineRevisions).where(eq(routineRevisions.companyId, companyId)),
      triggers: await db.select().from(routineTriggers),
      runs: await db.select().from(routineRuns).where(eq(routineRuns.companyId, companyId)),
      issues: await db.select().from(issues).where(eq(issues.companyId, companyId)),
    });
    const before = await snapshot();

    const attempts = (app: express.Express, assigneeAgentId: string, ownRoutineId: string, targetProjectId: string) => [
      ["create", request(app).post(`/api/companies/${companyId}/routines`).send({
        projectId: targetProjectId, assigneeAgentId, title: "Synthetic outsider", description: "Synthetic outsider body",
      })],
      ["patch", request(app).patch(`/api/routines/${ownRoutineId}`).send({ projectId: targetProjectId })],
      ["run", request(app).post(`/api/routines/${ownRoutineId}/run`).send({ projectId: targetProjectId })],
    ] as const;
    for (const [name, app, assignee, ownRoutineId] of [
      ["outsiderUser", outsiderUser, agentId, userRoutine.id],
      ["outsiderAgent", outsiderAgent, outsiderAgentId, agentRoutine.id],
    ] as const) {
      for (const [label, target] of [["private", privateProjectId], ["randomControl", randomUUID()]] as const) {
        for (const [route, pending] of attempts(app, assignee, ownRoutineId, target)) {
          const response = await pending;
          expect({ name, label, route, status: response.status, body: response.body })
            .toEqual({ name, label, route, status: 404, body: { error: "Project not found" } });
        }
      }
    }
    // Revision restore whose snapshot is in the private project (the outsider agent is the assignee,
    // and the outsider user may assign tasks, so the manage rule alone allows both).
    for (const [name, app] of [["outsiderUser", outsiderUser], ["outsiderAgent", outsiderAgent]] as const) {
      const restore = await request(app).post(`/api/routines/${movedOut.id}/revisions/${movedOut.latestRevisionId}/restore`).send({});
      expect({ name, route: "restore", status: restore.status, body: restore.body })
        .toEqual({ name, route: "restore", status: 404, body: { error: "Project not found" } });
    }
    expect(await snapshot()).toEqual(before);

    // Readable-project controls: the same routes into a project the outsider can read still work.
    for (const [name, app, assignee, ownRoutineId] of [
      ["outsiderUser", outsiderUser, agentId, userRoutine.id],
      ["outsiderAgent", outsiderAgent, outsiderAgentId, agentRoutine.id],
    ] as const) {
      const [[, create], [, patch], [, run]] = attempts(app, assignee, ownRoutineId, openProjectId);
      const created = await create;
      expect({ name, status: created.status, projectId: created.body.projectId }).toEqual({ name, status: 201, projectId: openProjectId });
      const patched = await patch;
      expect({ name, status: patched.status, projectId: patched.body.projectId }).toEqual({ name, status: 200, projectId: openProjectId });
      const ran = await run;
      expect({ name, status: ran.status }).toEqual({ name, status: 202 });
      const [runIssue] = await db.select().from(issues).where(eq(issues.id, ran.body.linkedIssueId));
      expect(runIssue?.projectId).toBe(openProjectId);
    }
    // Restoring a revision whose project did not change (no project) is unaffected.
    const ownRevisions = await request(outsiderAgent).get(`/api/routines/${agentRoutine.id}/revisions`);
    const firstRevision = (ownRevisions.body as Array<{ id: string; revisionNumber: number }>).find((r) => r.revisionNumber === 1)!;
    const ownRestore = await request(outsiderAgent).post(`/api/routines/${agentRoutine.id}/revisions/${firstRevision.id}/restore`).send({});
    expect(ownRestore.status, JSON.stringify(ownRestore.body)).toBe(200);

    // Members of the private project keep their access: create, move in, run override and restore.
    const memberUser = await createApp(board(memberUserId));
    const memberCreated = await request(memberUser).post(`/api/companies/${companyId}/routines`).send({
      projectId: privateProjectId, assigneeAgentId: agentId, title: "Synthetic member routine", description: "Synthetic",
    });
    expect(memberCreated.status, JSON.stringify(memberCreated.body)).toBe(201);
    const memberOwn = await createRoutine(memberUser, { assigneeAgentId: agentId });
    const memberMove = await request(memberUser).patch(`/api/routines/${memberOwn.id}`).send({ projectId: privateProjectId });
    expect(memberMove.status, JSON.stringify(memberMove.body)).toBe(200);
    const memberRun = await postRoutineRun(memberUser, memberCreated.body.id, { projectId: privateProjectId });
    expect(memberRun.status, JSON.stringify(memberRun.body)).toBe(202);
    const memberRestore = await request(memberUser).post(`/api/routines/${movedOut.id}/revisions/${movedOut.latestRevisionId}/restore`).send({});
    expect(memberRestore.status, JSON.stringify(memberRestore.body)).toBe(200);
    const [restored] = await db.select().from(routines).where(eq(routines.id, movedOut.id));
    expect(restored?.projectId).toBe(privateProjectId);
  }, 30_000);

  it("Slice H F-H2: routine reference fields follow read access (synthetic)", async () => {
    vi.stubEnv("PAPERCLIP_API_URL", "http://localhost:3100");
    vi.stubEnv("PAPERCLIP_IN_WORKTREE", "false");
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
    const { companyId, agentId, projectId: privateProjectId, userId: ownerUserId } = await seedFixture();
    const openProjectId = randomUUID();
    await db.insert(projects).values({ id: openProjectId, companyId, name: "Synthetic Open Project", status: "in_progress" });
    const memberUserId = randomUUID();
    const outsiderUserId = randomUUID();
    const outsiderAgentId = randomUUID();
    await db.insert(agents).values({
      id: outsiderAgentId, companyId, name: "Synthetic Outsider", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    const access = accessService(db);
    const memberMembership = await access.ensureMembership(companyId, "user", memberUserId, "member", "active");
    await access.setMemberPermissions(companyId, memberMembership.id, [{ permissionKey: "tasks:assign" }], ownerUserId);
    const outsiderMembership = await access.ensureMembership(companyId, "user", outsiderUserId, "member", "active");
    await access.setMemberPermissions(companyId, outsiderMembership.id, [{ permissionKey: "tasks:assign" }], ownerUserId);
    await db.update(projects).set({ visibility: "private", privacyOwnerUserId: ownerUserId }).where(eq(projects.id, privateProjectId));
    await db.insert(projectAccessMembers).values([
      { companyId, projectId: privateProjectId, subjectType: "user", subjectId: ownerUserId },
      { companyId, projectId: privateProjectId, subjectType: "user", subjectId: memberUserId },
      { companyId, projectId: privateProjectId, subjectType: "agent", subjectId: agentId },
    ]);
    // Synthetic referenced objects: a private issue and private workspaces, plus readable twins in the open project.
    const privateIssueId = randomUUID();
    const openIssueId = randomUUID();
    await db.insert(issues).values([
      { id: privateIssueId, companyId, projectId: privateProjectId, title: "SYNTHETIC-PRIVATE-TITLE", description: "SYNTHETIC-PRIVATE-BODY", status: "todo" },
      { id: openIssueId, companyId, projectId: openProjectId, title: "Synthetic open parent", description: "Synthetic", status: "todo" },
    ]);
    const privateWorkspaceId = randomUUID();
    const openWorkspaceId = randomUUID();
    await db.insert(projectWorkspaces).values([
      { id: privateWorkspaceId, companyId, projectId: privateProjectId, name: "SYNTHETIC-PRIVATE-WS", isPrimary: true, sharedWorkspaceKey: "fh2-private" },
      { id: openWorkspaceId, companyId, projectId: openProjectId, name: "Synthetic open ws", isPrimary: true, sharedWorkspaceKey: "fh2-open" },
    ]);
    const privateExecWorkspaceId = randomUUID();
    const openExecWorkspaceId = randomUUID();
    await db.insert(executionWorkspaces).values([
      { id: privateExecWorkspaceId, companyId, projectId: privateProjectId, projectWorkspaceId: privateWorkspaceId,
        mode: "shared_workspace", strategyType: "project_primary", name: "SYNTHETIC-PRIVATE-EXEC", status: "active", providerType: "local_fs" },
      { id: openExecWorkspaceId, companyId, projectId: openProjectId, projectWorkspaceId: openWorkspaceId,
        mode: "shared_workspace", strategyType: "project_primary", name: "Synthetic open exec", status: "active", providerType: "local_fs" },
    ]);
    // Isolated workspaces on, so an execution-workspace override is actually bound to the run's issue.
    await db.insert(instanceSettings).values({ experimental: { enableIsolatedWorkspaces: true } })
      .onConflictDoUpdate({ target: instanceSettings.singletonKey, set: { experimental: { enableIsolatedWorkspaces: true } } });
    const board = (userId: string) => ({
      type: "board", userId, source: "session", isInstanceAdmin: false, companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole: "member" }],
    });
    const admin = await createApp({ type: "board", source: "local_implicit", userId: ownerUserId, isInstanceAdmin: true });
    const outsiderUser = await createApp(board(outsiderUserId));
    const outsiderAgent = await createApp({ type: "agent", agentId: outsiderAgentId, companyId });
    const createRoutine = async (app: express.Express, body: Record<string, unknown>) => {
      const response = await request(app).post(`/api/companies/${companyId}/routines`).send({
        title: "Synthetic routine", description: "Synthetic body", concurrencyPolicy: "always_enqueue", ...body,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      return response.body as { id: string; latestRevisionId: string };
    };
    // The outsiders' own routines (no project, no parent).
    const userRoutine = await createRoutine(outsiderUser, { assigneeAgentId: agentId });
    const agentRoutine = await createRoutine(outsiderAgent, { assigneeAgentId: outsiderAgentId });
    // An earlier revision had the private parent; restoring it would bring the parent back.
    const movedOut = await createRoutine(admin, { parentIssueId: privateIssueId, assigneeAgentId: outsiderAgentId });
    const movedOutPatch = await request(admin).patch(`/api/routines/${movedOut.id}`).send({ parentIssueId: null });
    expect(movedOutPatch.status, JSON.stringify(movedOutPatch.body)).toBe(200);
    // An existing routine with no project but a private parent: its runs land in the private project.
    const privateParented = await createRoutine(admin, { parentIssueId: privateIssueId, assigneeAgentId: outsiderAgentId });
    // An owner run of a no-project routine into the private project: its run links a private issue.
    const ownerRunRoutine = await createRoutine(admin, { assigneeAgentId: agentId, title: "Synthetic owner run" });
    const ownerRun = await postRoutineRun(admin, ownerRunRoutine.id, { projectId: privateProjectId });
    expect(ownerRun.status, JSON.stringify(ownerRun.body)).toBe(202);
    await db.update(issues).set({ title: "SYNTHETIC-PRIVATE-RUN-TITLE", description: "SYNTHETIC-PRIVATE-RUN-BODY" })
      .where(eq(issues.id, ownerRun.body.linkedIssueId));

    const snapshot = async () => ({
      routines: await db.select().from(routines).where(eq(routines.companyId, companyId)),
      revisions: await db.select().from(routineRevisions).where(eq(routineRevisions.companyId, companyId)),
      triggers: await db.select().from(routineTriggers),
      runs: await db.select().from(routineRuns).where(eq(routineRuns.companyId, companyId)),
      issues: await db.select().from(issues).where(eq(issues.companyId, companyId)),
    });
    const before = await snapshot();

    const attempts = (app: express.Express, assigneeAgentId: string, ownRoutineId: string, target: {
      issueId: string; workspaceId: string; execWorkspaceId: string;
    }) => [
      ["create parentIssueId", request(app).post(`/api/companies/${companyId}/routines`).send({
        parentIssueId: target.issueId, assigneeAgentId, title: "Synthetic outsider", description: "Synthetic outsider body",
      }), "Parent issue not found"],
      ["patch parentIssueId", request(app).patch(`/api/routines/${ownRoutineId}`).send({ parentIssueId: target.issueId }), "Parent issue not found"],
      ["run projectWorkspaceId", request(app).post(`/api/routines/${ownRoutineId}/run`).send({ projectWorkspaceId: target.workspaceId }), "Project workspace not found"],
      ["run executionWorkspaceId", request(app).post(`/api/routines/${ownRoutineId}/run`).send({
        executionWorkspaceId: target.execWorkspaceId, executionWorkspacePreference: "reuse_existing",
      }), "Execution workspace not found"],
    ] as const;
    const outsiders = [
      ["outsiderUser", outsiderUser, agentId, userRoutine.id],
      ["outsiderAgent", outsiderAgent, outsiderAgentId, agentRoutine.id],
    ] as const;
    for (const [name, app, assignee, ownRoutineId] of outsiders) {
      for (const [label, target] of [
        ["private", { issueId: privateIssueId, workspaceId: privateWorkspaceId, execWorkspaceId: privateExecWorkspaceId }],
        ["randomControl", { issueId: randomUUID(), workspaceId: randomUUID(), execWorkspaceId: randomUUID() }],
      ] as const) {
        for (const [route, pending, error] of attempts(app, assignee, ownRoutineId, target)) {
          const response = await pending;
          expect({ name, label, route, status: response.status, body: response.body })
            .toEqual({ name, label, route, status: 404, body: { error } });
        }
      }
      // Restore of a snapshot whose parent is private.
      const restore = await request(app).post(`/api/routines/${movedOut.id}/revisions/${movedOut.latestRevisionId}/restore`).send({});
      expect({ name, route: "restore", status: restore.status, body: restore.body })
        .toEqual({ name, route: "restore", status: 404, body: { error: "Parent issue not found" } });
      // Writes and runs on an existing routine whose parent is private: the same 404 as a random routine id.
      for (const [label, routineId] of [["private", privateParented.id], ["randomControl", randomUUID()]] as const) {
        const patch = await request(app).patch(`/api/routines/${routineId}`).send({ description: "Synthetic outsider body" });
        const run = await request(app).post(`/api/routines/${routineId}/run`).send({});
        for (const [route, response] of [["patch existing", patch], ["run existing", run]] as const) {
          expect({ name, label, route, status: response.status, body: response.body })
            .toEqual({ name, label, route, status: 404, body: { error: "Routine not found" } });
        }
      }
      // Defence in depth: reads do not return issues the reader cannot read.
      const detail = await request(app).get(`/api/routines/${privateParented.id}`);
      expect(detail.status).toBe(200);
      expect(detail.body.parentIssue).toBeNull();
      const ownerRunDetail = await request(app).get(`/api/routines/${ownerRunRoutine.id}`);
      expect(ownerRunDetail.status).toBe(200);
      expect(ownerRunDetail.body.activeIssue).toBeNull();
      expect(ownerRunDetail.body.recentRuns.map((run: any) => [run.linkedIssueId, run.linkedIssue])).toEqual([[null, null]]);
      const runs = await request(app).get(`/api/routines/${ownerRunRoutine.id}/runs`);
      expect(runs.status).toBe(200);
      expect(runs.body.map((run: any) => [run.linkedIssueId, run.linkedIssue])).toEqual([[null, null]]);
      expect(JSON.stringify([detail.body, ownerRunDetail.body, runs.body])).not.toContain("SYNTHETIC-PRIVATE");
    }
    expect(await snapshot()).toEqual(before);

    // Readable-object controls: the same routes with readable references still work.
    for (const [name, app, assignee, ownRoutineId] of outsiders) {
      const [[, create], [, patch], [, runWorkspace], [, runExec]] =
        attempts(app, assignee, ownRoutineId, { issueId: openIssueId, workspaceId: openWorkspaceId, execWorkspaceId: openExecWorkspaceId });
      const created = await create;
      expect({ name, status: created.status, parentIssueId: created.body.parentIssueId }).toEqual({ name, status: 201, parentIssueId: openIssueId });
      const patched = await patch;
      expect({ name, status: patched.status, parentIssueId: patched.body.parentIssueId }).toEqual({ name, status: 200, parentIssueId: openIssueId });
      const detail = await request(app).get(`/api/routines/${ownRoutineId}`);
      expect(detail.body.parentIssue?.id).toBe(openIssueId);
      const ranWorkspace = await runWorkspace;
      expect({ name, status: ranWorkspace.status }, JSON.stringify(ranWorkspace.body)).toEqual({ name, status: 202 });
      const ranExec = await runExec;
      expect({ name, status: ranExec.status }, JSON.stringify(ranExec.body)).toEqual({ name, status: 202 });
      const [execIssue] = await db.select().from(issues).where(eq(issues.id, ranExec.body.linkedIssueId));
      expect(execIssue?.executionWorkspaceId).toBe(openExecWorkspaceId);
    }

    // Members keep their access: parent, restore, existing routine, workspaces and full detail.
    const memberUser = await createApp(board(memberUserId));
    const memberCreated = await request(memberUser).post(`/api/companies/${companyId}/routines`).send({
      parentIssueId: privateIssueId, assigneeAgentId: agentId, title: "Synthetic member routine", description: "Synthetic",
    });
    expect(memberCreated.status, JSON.stringify(memberCreated.body)).toBe(201);
    const memberRun = await postRoutineRun(memberUser, memberCreated.body.id, { projectWorkspaceId: privateWorkspaceId });
    expect(memberRun.status, JSON.stringify(memberRun.body)).toBe(202);
    const memberExecRun = await postRoutineRun(memberUser, privateParented.id, {
      executionWorkspaceId: privateExecWorkspaceId, executionWorkspacePreference: "reuse_existing",
    });
    expect(memberExecRun.status, JSON.stringify(memberExecRun.body)).toBe(202);
    const memberDetail = await request(memberUser).get(`/api/routines/${privateParented.id}`);
    expect(memberDetail.body.parentIssue?.id).toBe(privateIssueId);
    const memberRuns = await request(memberUser).get(`/api/routines/${ownerRunRoutine.id}/runs`);
    expect(memberRuns.body[0].linkedIssue?.title).toBe("SYNTHETIC-PRIVATE-RUN-TITLE");
    const memberRestore = await request(memberUser).post(`/api/routines/${movedOut.id}/revisions/${movedOut.latestRevisionId}/restore`).send({});
    expect(memberRestore.status, JSON.stringify(memberRestore.body)).toBe(200);
    const [restored] = await db.select().from(routines).where(eq(routines.id, movedOut.id));
    expect(restored?.parentIssueId).toBe(privateIssueId);
  }, 60_000);

  it("Slice H F-H2: folder item moves of a routine follow routine read access (synthetic)", async () => {
    vi.stubEnv("PAPERCLIP_API_URL", "http://localhost:3100");
    vi.stubEnv("PAPERCLIP_IN_WORKTREE", "false");
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
    const { companyId, agentId, projectId: privateProjectId, userId: ownerUserId } = await seedFixture();
    const memberUserId = randomUUID();
    const outsiderUserId = randomUUID();
    const outsiderAgentId = randomUUID();
    await db.insert(agents).values({
      id: outsiderAgentId, companyId, name: "Synthetic Outsider", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    const access = accessService(db);
    await access.ensureMembership(companyId, "user", memberUserId, "member", "active");
    const outsiderMembership = await access.ensureMembership(companyId, "user", outsiderUserId, "member", "active");
    await access.setMemberPermissions(companyId, outsiderMembership.id, [{ permissionKey: "tasks:assign" }], ownerUserId);
    await db.update(projects).set({ visibility: "private", privacyOwnerUserId: ownerUserId }).where(eq(projects.id, privateProjectId));
    await db.insert(projectAccessMembers).values([
      { companyId, projectId: privateProjectId, subjectType: "user", subjectId: ownerUserId },
      { companyId, projectId: privateProjectId, subjectType: "user", subjectId: memberUserId },
      { companyId, projectId: privateProjectId, subjectType: "agent", subjectId: agentId },
    ]);
    const privateIssueId = randomUUID();
    await db.insert(issues).values({ id: privateIssueId, companyId, projectId: privateProjectId, title: "SYNTHETIC-PRIVATE-TITLE", status: "todo" });
    const folderId = randomUUID();
    await db.insert(folders).values({ id: folderId, companyId, kind: "routine", name: "Synthetic folder", slug: "synthetic-folder" });
    const { errorHandler } = await import("../middleware/index.js");
    const { routineRoutes } = await import("../routes/routines.js");
    const { folderRoutes } = await import("../routes/folders.js");
    const appFor = (actor: Record<string, unknown>) => {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { (req as any).actor = actor; next(); });
      app.use("/api", routineRoutes(db));
      app.use("/api", folderRoutes(db));
      app.use(errorHandler);
      return app;
    };
    const board = (userId: string) => ({
      type: "board", userId, source: "session", isInstanceAdmin: false, companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole: "member" }],
    });
    const admin = appFor({ type: "board", source: "local_implicit", userId: ownerUserId, isInstanceAdmin: true });
    const created = async (body: Record<string, unknown>) => {
      const response = await request(admin).post(`/api/companies/${companyId}/routines`).send({
        title: "Synthetic routine", description: "Synthetic body", assigneeAgentId: outsiderAgentId, ...body,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      return response.body.id as string;
    };
    const inPrivateProject = await created({ projectId: privateProjectId, assigneeAgentId: agentId });
    const withPrivateParent = await created({ parentIssueId: privateIssueId });
    const openRoutine = await created({});
    const move = (app: express.Express, itemId: string) =>
      request(app).post(`/api/companies/${companyId}/folders/items/move`).send({ kind: "routine", itemId, folderId });
    const before = await db.select().from(routines).where(eq(routines.companyId, companyId));
    for (const [name, app] of [["outsiderUser", appFor(board(outsiderUserId))], ["outsiderAgent", appFor({ type: "agent", agentId: outsiderAgentId, companyId })]] as const) {
      const control = await move(app, randomUUID());
      expect({ name, status: control.status, body: control.body }).toEqual({ name, status: 404, body: { error: "Routine not found" } });
      for (const [label, routineId] of [["private project", inPrivateProject], ["private parent", withPrivateParent]] as const) {
        const response = await move(app, routineId);
        expect({ name, label, status: response.status, body: response.body }).toEqual({ name, label, status: 404, body: control.body });
      }
    }
    expect(await db.select().from(routines).where(eq(routines.companyId, companyId))).toEqual(before);
    // Controls: a readable routine still moves, and a member still moves the private routine.
    const outsiderOpen = await move(appFor(board(outsiderUserId)), openRoutine);
    expect(outsiderOpen.status, JSON.stringify(outsiderOpen.body)).toBe(200);
    const memberMove = await move(appFor(board(memberUserId)), inPrivateProject);
    expect(memberMove.status, JSON.stringify(memberMove.body)).toBe(200);
    const memberParentMove = await move(appFor(board(memberUserId)), withPrivateParent);
    expect(memberParentMove.status, JSON.stringify(memberParentMove.body)).toBe(200);
  }, 30_000);

  it.each(["bearer", "hmac_sha256", "github_hmac", "none"] as const)(
    "authenticates %s HTTP deliveries, persists payloads, and enforces trigger lifecycle",
    async (signingMode) => {
      vi.stubEnv("PAPERCLIP_API_URL", "http://localhost:3100");
      vi.stubEnv("PAPERCLIP_IN_WORKTREE", "false");
      const { companyId, agentId, projectId, userId } = await seedFixture();
      const board = await createApp({ type: "board", source: "local_implicit", userId, isInstanceAdmin: true });
      const created = await request(board).post(`/api/companies/${companyId}/routines`).send({
        projectId, assigneeAgentId: agentId, title: "Webhook {{event}}",
        description: "Handle {{event}}", variables: [{ name: "event", type: "text", required: true }],
        concurrencyPolicy: "always_enqueue",
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const routineId = created.body.id;
      const configured = await request(board).post(`/api/routines/${routineId}/triggers`).send({ kind: "webhook", signingMode });
      expect(configured.status, JSON.stringify(configured.body)).toBe(201);
      const { trigger, secretMaterial } = configured.body;
      const detail = await request(board).get(`/api/routines/${routineId}`);
      expect(detail.body.triggers[0].webhookUrl).toBe(secretMaterial.webhookUrl);
      const path = new URL(secretMaterial.webhookUrl).pathname;
      const [{ actorMiddleware }, { boardMutationGuard }, { routineRoutes }, { errorHandler }] = await Promise.all([
        import("../middleware/auth.js"), import("../middleware/board-mutation-guard.js"),
        import("../routes/routines.js"), import("../middleware/error-handler.js"),
      ]);
      const ingress = express();
      ingress.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));
      ingress.use(actorMiddleware(db, {
        deploymentMode: "authenticated",
        // A webhook must not acquire an ambient board session or need CSRF headers.
        resolveSession: async () => { throw new Error("Webhook must not resolve a browser session"); },
      }));
      ingress.use("/api", boardMutationGuard(), routineRoutes(db));
      ingress.use(errorHandler);
      const raw = '{ "event": "deploy", "detail": { "text": "café" } }';
      const timestamp = String(Math.floor(Date.now() / 1000));
      function delivery(secret = secretMaterial.webhookSecret, body = raw, ts = timestamp) {
        const req = request(ingress).post(path).set("Content-Type", "application/json");
        if (signingMode === "bearer") req.set("Authorization", `Bearer ${secret}`);
        if (signingMode === "hmac_sha256") {
          req.set("X-Paperclip-Timestamp", ts).set("X-Paperclip-Signature",
            `sha256=${createHmac("sha256", secret).update(`${ts}.`).update(raw).digest("hex")}`);
        }
        if (signingMode === "github_hmac") req.set("X-Hub-Signature-256",
          `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`);
        return req.send(body);
      }
      if (signingMode !== "none") expect((await delivery("wrong-secret")).status).toBe(401);
      if (signingMode === "hmac_sha256" || signingMode === "github_hmac") {
        expect((await delivery(undefined, raw.replace("deploy", "tampered"))).status).toBe(401);
      }
      if (signingMode === "hmac_sha256") {
        expect((await delivery(undefined, raw, "1")).status).toBe(401);
        const malformed = await request(ingress).post(path).set("Content-Type", "application/json")
          .set("X-Paperclip-Timestamp", timestamp).set("X-Paperclip-Signature", "é".repeat(64)).send(raw);
        expect(malformed.status).toBe(401);
      }
      expect((await request(ingress).post(path).type("text").send(raw)).status).toBe(415);
      expect((await request(ingress).post(path).send([])).status).toBe(400);
      const accepted = await delivery();
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
      expect(accepted.body).toMatchObject({ source: "webhook", status: "issue_created" });
      const [issue] = await db.select().from(issues).where(eq(issues.id, accepted.body.linkedIssueId));
      expect(issue).toMatchObject({ companyId, assigneeAgentId: agentId, title: "Webhook deploy", description: "Handle deploy" });
      const history = await request(board).get(`/api/routines/${routineId}/runs`);
      expect(history.body[0].triggerPayload).toMatchObject({ event: "deploy", detail: { text: "café" } });
      await db.update(issues).set({ status: "done", executionRunId: null }).where(eq(issues.id, issue.id));
      if (signingMode === "hmac_sha256") {
        expect((await delivery()).status).toBe(409);
      } else {
        const first = await delivery().set("Idempotency-Key", "delivery-2");
        const retry = await delivery().set("Idempotency-Key", "delivery-2");
        expect(retry.status).toBe(202);
        expect(retry.body.id).toBe(first.body.id);
        await db.update(issues).set({ status: "done", executionRunId: null }).where(eq(issues.id, first.body.linkedIssueId));
      }
      if (signingMode !== "none") {
        const rotated = await request(board).post(`/api/routine-triggers/${trigger.id}/rotate-secret`).send({});
        expect(rotated.status).toBe(200);
        expect(rotated.body.trigger.lastWebhookDelivery).toBeNull();
        expect((await delivery()).status).toBe(401);
        expect((await delivery(rotated.body.secretMaterial.webhookSecret)).status).toBe(202);
      }
      await request(board).patch(`/api/routine-triggers/${trigger.id}`).send({ enabled: false });
      expect((await delivery()).status).toBe(409);
      await request(board).patch(`/api/routine-triggers/${trigger.id}`).send({ enabled: true });
      await request(board).patch(`/api/routines/${routineId}`).send({ status: "paused" });
      expect((await delivery()).status).toBe(409);
    },
  );

  it("uses the normal public webhook for verified caller provenance and routine-wide receipts", async () => {
    vi.stubEnv("PAPERCLIP_API_URL", "http://localhost:3100");
    vi.stubEnv("PAPERCLIP_IN_WORKTREE", "false");
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", randomUUID().repeat(2));
    const { companyId, agentId, projectId, userId } = await seedFixture();
    const board = await createApp({ type: "board", source: "local_implicit", userId, isInstanceAdmin: true });
    const created = await request(board).post(`/api/companies/${companyId}/routines`).send({
      projectId, assigneeAgentId: agentId, title: "Ordinary webhook", concurrencyPolicy: "always_enqueue",
    });
    expect(created.status).toBe(201);
    const routineId = created.body.id;
    const a = await request(board).post(`/api/routines/${routineId}/triggers`).send({ kind: "webhook", signingMode: "app_webhook" });
    const b = await request(board).post(`/api/routines/${routineId}/triggers`).send({ kind: "webhook", signingMode: "app_webhook" });
    expect(a.status).toBe(201); expect(b.status).toBe(201);
    const [source] = await db.insert(issues).values({ companyId, title: "Caller source", createdByUserId: userId }).returning();
    const [caller] = await db.insert(heartbeatRuns).values({ companyId, agentId, nativeIssueId: source!.id, status: "running" }).returning();
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", caller!.id)!;
    const { app: publicApp, resolveSession } = await createAuthenticatedApp();
    const delivery = (config: typeof a.body, scope = "routine") => request(publicApp)
      .post(new URL(config.secretMaterial.webhookUrl).pathname)
      .set("Authorization", `Bearer ${config.secretMaterial.webhookSecret}`)
      .set("X-Paperclip-Source-Run-Token", token).set("X-Paperclip-Idempotency-Scope", scope)
      .set("Idempotency-Key", "external-occurrence-1").send({ event: "any-provider.failure", createdByRunId: randomUUID() });
    expect((await delivery(a.body, "global")).status).toBe(400);
    const first = await delivery(a.body), retry = await delivery(b.body);
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    expect(retry.status).toBe(202);
    expect(first.body.createdByRunId).toBe(caller!.id);
    expect(retry.body.id).toBe(first.body.id);
    expect(await db.select().from(routineRuns)).toHaveLength(1);
    expect(await db.select().from(issues)).toHaveLength(2);
    expect(resolveSession).not.toHaveBeenCalled();
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, caller!.id));
    expect((await delivery(a.body)).status).toBe(401);
    expect(await db.select().from(routineRuns)).toHaveLength(1);
    const removedPath = new URL(a.body.secretMaterial.webhookUrl).pathname.replace(/\/fire$/, "/sentry-run-failures");
    expect((await request(publicApp).post(removedPath).send({})).status).toBe(404);
  });

  it("preserves the authenticated caller and upstream routine through the routine HTTP API", async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", randomUUID().repeat(2));
    const { companyId, agentId, projectId, userId } = await seedFixture();
    const board = await createApp({ type: "board", source: "local_implicit", userId, isInstanceAdmin: true });
    const create = (title: string) => request(board).post(`/api/companies/${companyId}/routines`)
      .send({ projectId, assigneeAgentId: agentId, title });
    const upstream = await create("Upstream routine"), downstream = await create("API consumer");
    expect(upstream.status).toBe(201); expect(downstream.status).toBe(201);
    const source = await request(board).post(`/api/routines/${upstream.body.id}/run`).send({});
    expect(source.status, JSON.stringify(source.body)).toBe(202);
    const [task] = await db.select().from(issues).where(eq(issues.id, source.body.linkedIssueId));
    const [caller] = await db.update(heartbeatRuns).set({ status: "running" })
      .where(eq(heartbeatRuns.id, task!.executionRunId!)).returning();
    const { app } = await createAuthenticatedApp();
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", caller!.id)!;
    const response = await request(app).post(`/api/routines/${downstream.body.id}/run`)
      .set("Authorization", `Bearer ${token}`).send({ source: "api" });
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    expect(response.body.createdByRunId).toBe(caller!.id);
    const [receipt] = await db.select().from(routineRuns).where(eq(routineRuns.id, response.body.id));
    expect(receipt?.createdByRunId).toBe(caller!.id);
    const { readTaskCreationProvenance } = await import("../services/task-creation-provenance.js");
    expect(await readTaskCreationProvenance(db, companyId, response.body.linkedIssueId))
      .toEqual({ status: "complete", routineIds: [upstream.body.id, downstream.body.id].sort(), shareable: true });
  });

  it("keeps setup deliveries out of runs, persists test receipts, and restores removed triggers", async () => {
    vi.stubEnv("PAPERCLIP_API_URL", "http://localhost:3100");
    vi.stubEnv("PAPERCLIP_IN_WORKTREE", "false");
    const { companyId, agentId, projectId, userId } = await seedFixture();
    const board = await createApp({ type: "board", source: "local_implicit", userId, isInstanceAdmin: true });
    const created = await request(board).post(`/api/companies/${companyId}/routines`).send({
      projectId, assigneeAgentId: agentId, title: "Verify deployment", description: "Inspect deployment", concurrencyPolicy: "always_enqueue",
    });
    expect(created.status).toBe(201);
    const routineId = created.body.id;
    const configured = await request(board).post(`/api/routines/${routineId}/triggers`).send({ kind: "webhook", signingMode: "bearer", setupPending: true });
    expect(configured.status).toBe(201);
    const { trigger, secretMaterial } = configured.body;
    const path = new URL(secretMaterial.webhookUrl).pathname;
    const publicApp = await createApp({ type: "none" });
    const deliver = (key: string, secret = secretMaterial.webhookSecret) => request(publicApp).post(path).set("Authorization", `Bearer ${secret}`).set("Idempotency-Key", key).send({ event: "deployment.completed" });
    await request(board).patch(`/api/routines/${routineId}`).send({ status: "paused" });
    expect((await deliver("bad", "wrong")).status).toBe(401);
    let detail = await request(board).get(`/api/routines/${routineId}`);
    expect(detail.body.triggers[0]).toMatchObject({ setupPending: true, lastWebhookDelivery: { status: "rejected", test: true } });
    const tested = await deliver("setup-event");
    expect(tested.status, JSON.stringify(tested.body)).toBe(202);
    expect(tested.body).toMatchObject({ status: "test_received", routineStarted: false, linkedIssueId: null });
    expect(await db.select().from(routineRuns)).toHaveLength(0);
    expect(await db.select().from(issues)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    // Read through a fresh app instance to prove the state is database-backed.
    const reopened = await createApp({ type: "board", source: "local_implicit", userId, isInstanceAdmin: true });
    detail = await request(reopened).get(`/api/routines/${routineId}`);
    expect(detail.body.triggers[0]).toMatchObject({ setupPending: true, lastWebhookDelivery: { status: "received", test: true } });
    expect(JSON.stringify(detail.body)).not.toContain(secretMaterial.webhookSecret);
    expect((await request(board).patch(`/api/routine-triggers/${trigger.id}`).send({ setupPending: false })).status).toBe(200);
    await request(board).patch(`/api/routines/${routineId}`).send({ status: "active" });
    expect((await deliver("setup-event")).body.status).toBe("test_received");
    expect(await db.select().from(routineRuns)).toHaveLength(0);
    const live = await deliver("live-event");
    expect(live.status, JSON.stringify(live.body)).toBe(202);
    expect(live.body.status).toBe("issue_created");
    expect(await db.select().from(issues)).toHaveLength(1);
    expect((await deliver("live-event")).body.id).toBe(live.body.id);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "routine.run_triggered"))).toHaveLength(1);
    expect(await db.select().from(issues)).toHaveLength(1);
    expect((await request(board).patch(`/api/routine-triggers/${trigger.id}`).send({ setupPending: true })).status).toBe(400);
    expect((await request(board).patch(`/api/routine-triggers/${trigger.id}`).send({ archived: true })).status).toBe(200);
    expect((await deliver("removed-event")).status).toBe(404);
    expect((await request(board).get(`/api/routines/${routineId}`)).body.triggers).toHaveLength(0);
    expect((await request(board).patch(`/api/routine-triggers/${trigger.id}`).send({ archived: false })).status).toBe(200);
    detail = await request(board).get(`/api/routines/${routineId}`);
    expect(detail.body.triggers[0].webhookUrl).toBe(secretMaterial.webhookUrl);
    expect((await deliver("restored-event")).status).toBe(202);
    const schedule = await request(board).post(`/api/routines/${routineId}/triggers`).send({ kind: "schedule", cronExpression: "0 9 * * 1-5", timezone: "America/Chicago" });
    expect(schedule.status).toBe(201);
    await request(board).patch(`/api/routine-triggers/${schedule.body.trigger.id}`).send({ archived: true });
    expect((await request(board).get(`/api/routines/${routineId}`)).body.triggers).toHaveLength(1);
    await request(board).patch(`/api/routine-triggers/${schedule.body.trigger.id}`).send({ archived: false });
    expect((await request(board).get(`/api/routines/${routineId}`)).body.triggers).toHaveLength(2);
  });

  it("supports creating, scheduling, and manually running a routine through the API", async () => {
    const { companyId, agentId, projectId, userId } = await seedFixture();
    const app = await createApp({
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const createRes = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        projectId,
        title: "Daily standup prep",
        description: "Summarize blockers and open PRs",
        assigneeAgentId: agentId,
        priority: "high",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        activityGatePolicy: "require_external_activity",
        activityGateScope: "project",
      });

    expect([200, 201]).toContain(createRes.status);
    expect(createRes.body.title).toBe("Daily standup prep");
    expect(createRes.body.assigneeAgentId).toBe(agentId);
    expect(createRes.body.activityGatePolicy).toBe("require_external_activity");
    expect(createRes.body.activityGateScope).toBe("project");

    const routineId = createRes.body.id as string;

    const updateRes = await request(app)
      .patch(`/api/routines/${routineId}`)
      .send({
        activityGatePolicy: "always",
        activityGateScope: "company",
      });

    expect(updateRes.status).toBe(200);
    expect(updateRes.body.activityGatePolicy).toBe("always");
    expect(updateRes.body.activityGateScope).toBe("company");

    const triggerRes = await request(app)
      .post(`/api/routines/${routineId}/triggers`)
      .send({
        kind: "schedule",
        label: "Weekday morning",
        cronExpression: "0 10 * * 1-5",
        timezone: "UTC",
      });

    expect([200, 201], JSON.stringify(triggerRes.body)).toContain(triggerRes.status);
    const createdTrigger = triggerRes.body.trigger ?? triggerRes.body;
    expect(createdTrigger.kind).toBe("schedule");
    expect(createdTrigger.enabled).toBe(true);
    expect(triggerRes.body.secretMaterial).toBeNull();

    const runRes = await postRoutineRun(app, routineId, {
      source: "manual",
      payload: { origin: "e2e-test" },
    });

    expect(runRes.status).toBe(202);
    expect(runRes.body.status).toBe("issue_created");
    expect(runRes.body.source).toBe("manual");
    expect(runRes.body.linkedIssueId).toBeTruthy();

    const listRes = await request(app).get(`/api/companies/${companyId}/routines`);
    expect(listRes.status).toBe(200);
    const listed = listRes.body.find((r: { id: string }) => r.id === routineId);
    expect(listed).toBeDefined();
    expect(listed.activityGatePolicy).toBe("always");
    expect(listed.activityGateScope).toBe("company");
    expect(listed.triggers).toHaveLength(1);
    expect(listed.triggers[0].cronExpression).toBe("0 10 * * 1-5");
    expect(listed.triggers[0].timezone).toBe("UTC");

    const detailRes = await request(app).get(`/api/routines/${routineId}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.activityGatePolicy).toBe("always");
    expect(detailRes.body.activityGateScope).toBe("company");
    expect(detailRes.body.triggers).toHaveLength(1);
    expect(detailRes.body.triggers[0]?.id).toBe(createdTrigger.id);
    expect(detailRes.body.recentRuns).toHaveLength(1);
    expect(detailRes.body.recentRuns[0]?.id).toBe(runRes.body.id);
    expect(detailRes.body.activeIssue?.id).toBe(runRes.body.linkedIssueId);

    const runsRes = await request(app).get(`/api/routines/${routineId}/runs?limit=10`);
    expect(runsRes.status).toBe(200);
    const [persistedRun] = await db
      .select({ id: routineRuns.id })
      .from(routineRuns)
      .where(eq(routineRuns.id, runRes.body.id));
    expect(persistedRun?.id).toBe(runRes.body.id);

    const [issue] = await db
      .select({
        id: issues.id,
        originId: issues.originId,
        originKind: issues.originKind,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, runRes.body.linkedIssueId));

    expect(issue).toMatchObject({
      id: runRes.body.linkedIssueId,
      originId: routineId,
      originKind: "routine_execution",
    });
    expect(issue?.executionRunId).toBeTruthy();

    const actions = await db
      .select({
        action: activityLog.action,
      })
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId));

    expect(actions.map((entry) => entry.action)).toEqual(
      expect.arrayContaining([
        "routine.created",
        "routine.trigger_created",
        "routine.run_triggered",
      ]),
    );
  }, 15_000);

  it("runs routines with variable inputs and interpolates the execution issue description", async () => {
    const { companyId, agentId, projectId, userId } = await seedFixture();
    const app = await createApp({
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const createRes = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        projectId,
        title: "Repository triage",
        description: "Review {{repo}} for {{priority}} bugs",
        assigneeAgentId: agentId,
        variables: [
          { name: "repo", type: "text", required: true },
          { name: "priority", type: "select", required: true, defaultValue: "high", options: ["high", "low"] },
        ],
      });

    expect([200, 201], JSON.stringify(createRes.body)).toContain(createRes.status);

    const runRes = await postRoutineRun(app, createRes.body.id, {
      source: "manual",
      variables: { repo: "paperclip" },
    });

    expect(runRes.status).toBe(202);
    expect(runRes.body.triggerPayload).toEqual({
      variables: {
        repo: "paperclip",
        priority: "high",
      },
    });

    const [issue] = await db
      .select({ description: issues.description })
      .from(issues)
      .where(eq(issues.id, runRes.body.linkedIssueId));

    expect(issue?.description).toBe("Review paperclip for high bugs");
  });

  it("defaults activity gates and rejects invalid activity gate values", async () => {
    const { companyId, agentId, projectId, userId } = await seedFixture();
    const app = await createApp({
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const createRes = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        projectId,
        title: "Default activity gate",
        assigneeAgentId: agentId,
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.activityGatePolicy).toBe("always");
    expect(createRes.body.activityGateScope).toBe("company");

    const invalidCreateRes = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        projectId,
        title: "Invalid activity gate",
        assigneeAgentId: agentId,
        activityGatePolicy: "when_busy",
      });

    expect(invalidCreateRes.status).toBe(400);

    const invalidPatchRes = await request(app)
      .patch(`/api/routines/${createRes.body.id}`)
      .send({ activityGateScope: "agent" });

    expect(invalidPatchRes.status).toBe(400);
  });

  it("allows drafting a routine without defaults and running it with one-off overrides", async () => {
    const { companyId, agentId, projectId, userId } = await seedFixture();
    const app = await createApp({
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const createRes = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        title: "Draft routine",
        description: "No saved defaults",
      });

    expect([200, 201], JSON.stringify(createRes.body)).toContain(createRes.status);
    expect(createRes.body.projectId ?? null).toBeNull();
    expect(createRes.body.assigneeAgentId ?? null).toBeNull();
    expect(createRes.body.status).toBe("paused");

    const runRes = await postRoutineRun(app, createRes.body.id, {
      source: "manual",
      projectId,
      assigneeAgentId: agentId,
    });

    expect(runRes.status).toBe(202);
    expect(runRes.body.status).toBe("issue_created");

    const [issue] = await db
      .select({
        projectId: issues.projectId,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(eq(issues.id, runRes.body.linkedIssueId));

    expect(issue).toEqual({
      projectId,
      assigneeAgentId: agentId,
    });
  });

  it("persists execution workspace selections from manual routine runs", async () => {
    const { companyId, agentId, projectId, userId } = await seedFixture();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const app = await createApp({
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
      sharedWorkspaceKey: "routine-primary",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Routine worktree",
      status: "active",
      providerType: "git_worktree",
    });
    await db
      .update(projects)
      .set({
        executionWorkspacePolicy: {
          enabled: true,
          defaultMode: "shared_workspace",
          defaultProjectWorkspaceId: projectWorkspaceId,
        },
      })
      .where(eq(projects.id, projectId));
    await db.insert(instanceSettings).values({
      experimental: { enableIsolatedWorkspaces: true },
    });

    const createRes = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        projectId,
        title: "Workspace-aware routine",
        assigneeAgentId: agentId,
      });

    expect([200, 201], JSON.stringify(createRes.body)).toContain(createRes.status);

    const runRes = await postRoutineRun(app, createRes.body.id, {
      source: "manual",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });

    expect(runRes.status).toBe(202);

    const [issue] = await db
      .select({
        projectWorkspaceId: issues.projectWorkspaceId,
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
        executionWorkspaceSettings: issues.executionWorkspaceSettings,
      })
      .from(issues)
      .where(eq(issues.id, runRes.body.linkedIssueId));

    expect(issue).toEqual({
      projectWorkspaceId,
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });
  });
});
