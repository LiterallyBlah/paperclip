import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentConfigRevisions,
  agents,
  companies,
  companySecretBindings,
  companySecretVersions,
  companySecrets,
  createDb,
  heartbeatRuns,
  principalPermissionGrants,
  type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Disposable fixture values only. None of them is a real credential.
const FIXTURE_VALUE_A = "fixture-removal-value-a";
const FIXTURE_VALUE_B = "fixture-removal-value-b";
const FIXTURE_VALUE_C = "fixture-removal-value-c";

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(async () => ({ allowed: true, reason: "allow_explicit_grant", explanation: "allowed" })),
  hasPermission: vi.fn(),
  getMembership: vi.fn(async () => null),
  listPrincipalGrants: vi.fn(async () => []),
}));

// A test hook that runs inside the removal transaction, after the removal's
// own checks and before the configuration update, to simulate a conflicting
// change that the existing expectedConfiguration check must catch.
const configurationHook = vi.hoisted(() => ({
  beforeUpdate: null as null | ((tx: unknown, agentId: string) => Promise<void>),
}));

vi.mock("../services/index.js", async () => {
  const actualAgents = await vi.importActual<typeof import("../services/agents.js")>("../services/agents.js");
  return {
    agentService: actualAgents.agentService,
    agentInstructionsService: () => ({}),
    accessService: () => mockAccessService,
    approvalService: () => ({}),
    builtInAgentService: () => ({ ensureCompanyDefaultAgentGrants: vi.fn() }),
    companySkillService: () => ({
      listRuntimeSkillEntries: vi.fn(async () => []),
      resolveRequestedSkillKeys: vi.fn(async () => []),
    }),
    budgetService: () => ({}),
    heartbeatService: () => ({ wakeup: vi.fn(), cancelActiveForAgent: vi.fn(), cancelBudgetScopeWork: vi.fn() }),
    ISSUE_LIST_DEFAULT_LIMIT: 50,
    issueApprovalService: () => ({}),
    issueRecoveryActionService: () => ({}),
    issueService: () => ({}),
    logActivity: vi.fn(),
    syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
    workspaceOperationService: () => ({}),
  };
});

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({ defaultEnvironmentId: null })),
    getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
    getExperimental: vi.fn(async () => ({ enableManagedSandboxOnly: false })),
  }),
}));

vi.mock("../services/agent-configuration-transaction.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/agent-configuration-transaction.js")>();
  return {
    ...actual,
    updateAgentConfigurationInTransaction: async (...args: Parameters<typeof actual.updateAgentConfigurationInTransaction>) => {
      if (configurationHook.beforeUpdate) await configurationHook.beforeUpdate(args[0], args[1]);
      return actual.updateAgentConfigurationInTransaction(...args);
    },
  };
});

import { secretService } from "../services/secrets.js";
import { createAgentLifecycle } from "../services/agent-lifecycle.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping agent secret binding removal route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type TestActor = Express.Request["actor"];

describeEmbeddedPostgres("POST /api/agents/:id/secret-bindings/remove", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let currentActor: TestActor | undefined;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-agent-binding-removal-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("agent-secret-binding-removal");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 30_000);

  beforeEach(() => {
    currentActor = undefined;
    configurationHook.beforeUpdate = null;
    mockAccessService.decide.mockResolvedValue({ allowed: true, reason: "allow_explicit_grant", explanation: "allowed" });
  });

  afterEach(async () => {
    configurationHook.beforeUpdate = null;
    await db.delete(activityLog);
    await db.delete(agentConfigRevisions);
    await db.delete(principalPermissionGrants);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function createApp() {
    const { agentRoutes } = await vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js");
    const { errorHandler } = await vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = currentActor;
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedAgent(companyId: string, name: string, adapterConfig: Record<string, unknown>) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      permissions: {},
      status: "idle",
    });
    // The ordinary configuration path creates the binding rows.
    await createAgentLifecycle(db).updateConfiguration(agentId, { adapterConfig });
    return agentId;
  }

  async function seedFixture() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Binding removal fixture",
      issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6)}`.toUpperCase(),
      status: "active",
    });
    const secrets = secretService(db);
    const secretA = await secrets.create(companyId, { name: `fixture-a-${randomUUID()}`, provider: "local_encrypted", value: FIXTURE_VALUE_A });
    const secretB = await secrets.create(companyId, { name: `fixture-b-${randomUUID()}`, provider: "local_encrypted", value: FIXTURE_VALUE_B });
    const secretC = await secrets.create(companyId, { name: `fixture-c-${randomUUID()}`, provider: "local_encrypted", value: FIXTURE_VALUE_C });
    const adapterConfig = {
      model: "fixture-model",
      env: {
        REMOVE_ME: { type: "secret_ref", secretId: secretA.id, version: "latest" },
        KEEP_PINNED: { type: "secret_ref", secretId: secretB.id, version: 1 },
        PLAIN_FLAG: { type: "plain", value: "on" },
      },
      "access.FIXTURE_ALIAS": { type: "secret_ref", secretId: secretC.id, version: "latest" },
    };
    const agentId = await seedAgent(companyId, "Removal target", adapterConfig);
    const otherAgentId = await seedAgent(companyId, "Other agent", {
      env: { REMOVE_ME: { type: "secret_ref", secretId: secretA.id, version: "latest" } },
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: otherAgentId, status: "running", contextSnapshot: {} });

    const bindingFor = async (target: string, configPath: string) => {
      const [row] = await db.select().from(companySecretBindings).where(and(
        eq(companySecretBindings.targetId, target), eq(companySecretBindings.configPath, configPath)));
      if (!row) throw new Error(`fixture binding missing: ${configPath}`);
      return row;
    };
    const removeBinding = await bindingFor(agentId, "env.REMOVE_ME");
    const keepBinding = await bindingFor(agentId, "env.KEEP_PINNED");
    const accessBinding = await bindingFor(agentId, "access.FIXTURE_ALIAS");
    const otherBinding = await bindingFor(otherAgentId, "env.REMOVE_ME");

    await db.insert(principalPermissionGrants).values([
      { companyId, principalType: "agent", principalId: agentId, permissionKey: "secrets:rotate_bound",
        scope: { secretId: secretB.id, bindingId: keepBinding.id }, grantedByUserId: "fixture-board-user" },
      { companyId, principalType: "agent", principalId: otherAgentId, permissionKey: "secrets:rotate_bound",
        scope: { secretId: secretA.id, bindingId: otherBinding.id }, grantedByUserId: "fixture-board-user" },
    ]);

    const board: TestActor = {
      type: "board",
      userId: "fixture-board-user",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
      runId,
    } as TestActor;
    return { companyId, agentId, otherAgentId, runId, secretA, secretB, secretC, removeBinding, keepBinding, accessBinding, otherBinding, board };
  }

  type Fixture = Awaited<ReturnType<typeof seedFixture>>;

  async function snapshot() {
    const agentRows = await db.select().from(agents).orderBy(asc(agents.id));
    const bindings = await db.select().from(companySecretBindings).orderBy(asc(companySecretBindings.id));
    const grants = await db.select().from(principalPermissionGrants).orderBy(asc(principalPermissionGrants.id));
    const revisions = await db.select().from(agentConfigRevisions);
    const activity = await db.select().from(activityLog);
    return { agentRows, bindings, grants, revisions, activity };
  }

  function validBody(f: Fixture) {
    return { configPath: "env.REMOVE_ME", secretId: f.secretA.id, bindingId: f.removeBinding.id, version: "latest" as const };
  }

  it("removes only the env leaf and its binding row, and keeps everything else byte-equal", async () => {
    const f = await seedFixture();
    currentActor = f.board;
    const before = await snapshot();
    const app = await createApp();

    const res = await request(app).post(`/api/agents/${f.agentId}/secret-bindings/remove`).send(validBody(f));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.removed).toEqual({ secretId: f.secretA.id, bindingId: f.removeBinding.id, configPath: "env.REMOVE_ME" });
    expect(res.body.id).toBe(f.agentId);
    expect(res.body.adapterConfig.env.REMOVE_ME).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(FIXTURE_VALUE_A);

    const after = await snapshot();
    const beforeTarget = before.agentRows.find((row) => row.id === f.agentId)!;
    const afterTarget = after.agentRows.find((row) => row.id === f.agentId)!;
    const beforeConfig = beforeTarget.adapterConfig as Record<string, any>;
    const { REMOVE_ME: _gone, ...expectedEnv } = beforeConfig.env;
    expect(afterTarget.adapterConfig).toEqual({ ...beforeConfig, env: expectedEnv });
    expect(JSON.stringify((afterTarget.adapterConfig as Record<string, any>).env)).toBe(JSON.stringify(expectedEnv));
    expect(afterTarget.runtimeConfig).toEqual(beforeTarget.runtimeConfig);
    expect(afterTarget.adapterType).toBe(beforeTarget.adapterType);
    // The other agent row is untouched.
    expect(after.agentRows.find((row) => row.id === f.otherAgentId)).toEqual(before.agentRows.find((row) => row.id === f.otherAgentId));
    // Exactly the one binding row is gone; every other row is byte-equal.
    expect(after.bindings).toEqual(before.bindings.filter((row) => row.id !== f.removeBinding.id));
    expect(after.bindings.map((row) => row.id)).toEqual(expect.arrayContaining([f.keepBinding.id, f.accessBinding.id, f.otherBinding.id]));
    // Grants are byte-equal.
    expect(after.grants).toEqual(before.grants);

    const newRevisions = after.revisions.filter((row) => !before.revisions.some((prior) => prior.id === row.id));
    expect(newRevisions).toHaveLength(1);
    expect(newRevisions[0]).toMatchObject({ agentId: f.agentId, source: "secret_binding_removal", createdByUserId: "fixture-board-user" });

    const removals = after.activity.filter((row) => row.action === "agent.secret_binding_removed");
    expect(removals).toHaveLength(1);
    expect(removals[0]).toMatchObject({
      companyId: f.companyId,
      actorType: "user",
      actorId: "fixture-board-user",
      runId: f.runId,
      entityType: "agent",
      entityId: f.agentId,
      details: { secretId: f.secretA.id, bindingId: f.removeBinding.id, configPath: "env.REMOVE_ME" },
    });
    expect(JSON.stringify(after.activity)).not.toContain(FIXTURE_VALUE_A);
  });

  it("answers 409 on a repeat call and writes nothing", async () => {
    const f = await seedFixture();
    currentActor = f.board;
    const app = await createApp();
    const first = await request(app).post(`/api/agents/${f.agentId}/secret-bindings/remove`).send(validBody(f));
    expect(first.status).toBe(200);
    const before = await snapshot();

    const repeat = await request(app).post(`/api/agents/${f.agentId}/secret-bindings/remove`).send(validBody(f));

    expect(repeat.status).toBe(409);
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    ["key", (f: Fixture) => ({ ...validBody(f), configPath: "env.NOT_PRESENT" })],
    ["secretId", (f: Fixture) => ({ ...validBody(f), secretId: f.secretB.id })],
    ["bindingId", (f: Fixture) => ({ ...validBody(f), bindingId: randomUUID() })],
    ["bindingId of a sibling binding", (f: Fixture) => ({ ...validBody(f), bindingId: f.keepBinding.id })],
    ["version", (f: Fixture) => ({ ...validBody(f), version: 1 })],
    ["pinned version given as latest", (f: Fixture) => ({ configPath: "env.KEEP_PINNED", secretId: f.secretB.id, bindingId: f.keepBinding.id, version: "latest" })],
    ["plain non-ref value", (f: Fixture) => ({ ...validBody(f), configPath: "env.PLAIN_FLAG" })],
    ["binding owned by another agent", (f: Fixture) => ({ ...validBody(f), bindingId: f.otherBinding.id })],
  ])("answers 409 with no change on a %s mismatch", async (_name, body) => {
    const f = await seedFixture();
    currentActor = f.board;
    const before = await snapshot();
    const app = await createApp();

    const res = await request(app).post(`/api/agents/${f.agentId}/secret-bindings/remove`).send(body(f));

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(await snapshot()).toEqual(before);
  });

  it("answers 409 through the existing configuration conflict path and rolls back", async () => {
    const f = await seedFixture();
    currentActor = f.board;
    const before = await snapshot();
    configurationHook.beforeUpdate = async (tx, agentId) => {
      // A conflicting change inside the same transaction, after the removal
      // checks ran. The expectedConfiguration check must refuse it.
      const txDb = tx as Db;
      const [row] = await txDb.select().from(agents).where(eq(agents.id, agentId));
      await txDb.update(agents).set({ adapterConfig: { ...(row!.adapterConfig as Record<string, unknown>), model: "concurrent-change" } })
        .where(eq(agents.id, agentId));
    };
    const app = await createApp();

    const res = await request(app).post(`/api/agents/${f.agentId}/secret-bindings/remove`).send(validBody(f));

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toMatch(/configuration changed while saving/i);
    expect(await snapshot()).toEqual(before);
  });

  it("applies the removal to the locked current row, keeping a concurrent unrelated edit", async () => {
    const f = await seedFixture();
    currentActor = f.board;
    const app = await createApp();
    const [seeded] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    const keptBefore = (seeded!.adapterConfig as Record<string, any>).env.KEEP_PINNED;
    expect(keptBefore).toMatchObject({ type: "secret_ref", secretId: f.secretB.id, version: 1 });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
    const concurrent = db.transaction(async (tx) => {
      const [row] = await tx.select().from(agents).where(eq(agents.id, f.agentId)).for("update");
      const config = row!.adapterConfig as Record<string, any>;
      await tx.update(agents).set({ adapterConfig: { ...config, model: "concurrent-model", env: { ...config.env, ADDED_LATER: { type: "plain", value: "x" } } } })
        .where(eq(agents.id, f.agentId));
      locked();
      await held;
    });
    await lockTaken;
    const pending = request(app).post(`/api/agents/${f.agentId}/secret-bindings/remove`).send(validBody(f)).then((res) => res);
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await concurrent;
    const res = await pending;

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [row] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    const config = row!.adapterConfig as Record<string, any>;
    expect(config.model).toBe("concurrent-model");
    expect(config.env.ADDED_LATER).toEqual({ type: "plain", value: "x" });
    expect(config.env.REMOVE_ME).toBeUndefined();
    expect(config.env.KEEP_PINNED).toEqual(keptBefore);
  });

  it("refuses an agent actor with 403 and writes nothing", async () => {
    const f = await seedFixture();
    currentActor = { type: "agent", agentId: f.agentId, companyId: f.companyId, runId: f.runId, source: "agent_jwt",
      keyScope: { kind: "standard" } } as TestActor;
    const before = await snapshot();
    const app = await createApp();

    const res = await request(app).post(`/api/agents/${f.agentId}/secret-bindings/remove`).send(validBody(f));

    expect(res.status).toBe(403);
    expect(await snapshot()).toEqual(before);
  });

  it("refuses a board actor without the agent-config permission with 403", async () => {
    const f = await seedFixture();
    currentActor = f.board;
    mockAccessService.decide.mockResolvedValue({ allowed: false, reason: "deny_no_grant", explanation: "denied" } as never);
    const before = await snapshot();
    const app = await createApp();

    const res = await request(app).post(`/api/agents/${f.agentId}/secret-bindings/remove`).send(validBody(f));

    expect(res.status).toBe(403);
    expect(mockAccessService.decide).toHaveBeenCalledWith(expect.objectContaining({ action: "agent_config:update" }));
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    ["an unknown field", (f: Fixture) => ({ ...validBody(f), adapterConfig: {} })],
    ["a non-env configPath", (f: Fixture) => ({ ...validBody(f), configPath: "access.FIXTURE_ALIAS" })],
    ["a missing version", (f: Fixture) => { const { version: _v, ...rest } = validBody(f); return rest; }],
    ["a non-uuid bindingId", (f: Fixture) => ({ ...validBody(f), bindingId: "not-a-uuid" })],
  ])("answers 422 for %s", async (_name, body) => {
    const f = await seedFixture();
    currentActor = f.board;
    const before = await snapshot();
    const app = await createApp();

    const res = await request(app).post(`/api/agents/${f.agentId}/secret-bindings/remove`).send(body(f));

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(await snapshot()).toEqual(before);
  });
});
