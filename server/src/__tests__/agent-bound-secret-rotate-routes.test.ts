import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import express from "express";
import pino from "pino";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
  heartbeatRuns,
  principalPermissionGrants,
  secretAccessEvents,
} from "@paperclipai/db";
import type { AgentApiKeyScope } from "@paperclipai/shared";
import { errorHandler } from "../middleware/error-handler.js";
import { isSecretSensitiveHttpRequest } from "../middleware/http-log-policy.js";
import { createHttpLogger, logger } from "../middleware/logger.js";
import { HttpError } from "../errors.js";
import { secretRoutes } from "../routes/secrets.js";
import { accessService } from "../services/access.js";
import { agentService } from "../services/agents.js";
import { authorizationService, parseBoundSecretRotationScope } from "../services/authorization.js";
import { secretService } from "../services/secrets.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// Disposable dummy values only. None of them is a real credential.
const OLD_VALUE = "fixture-old-rotate-value";
const NEW_VALUE = "fixture-new-rotate-value";
const OTHER_VALUE = "fixture-other-record-value";
const BOARD_USER_ID = "fixture-board-user";

type ActorOptions = {
  keyScope?: AgentApiKeyScope;
  source?: "agent_jwt" | "agent_key";
  runId?: string | null;
};

describe("parseBoundSecretRotationScope", () => {
  it("accepts exactly one secretId and one bindingId", () => {
    expect(parseBoundSecretRotationScope({ secretId: "s", bindingId: "b" })).toEqual({ secretId: "s", bindingId: "b" });
  });

  it.each([
    ["null", null],
    ["array", [{ secretId: "s", bindingId: "b" }]],
    ["string", "s"],
    ["empty object", {}],
    ["missing bindingId", { secretId: "s" }],
    ["list of secrets", { secretId: ["s", "t"], bindingId: "b" }],
    ["extra key", { secretId: "s", bindingId: "b", projectId: "p" }],
    ["blank ids", { secretId: " ", bindingId: "b" }],
    ["numeric ids", { secretId: 1, bindingId: 2 }],
  ])("rejects %s", (_name, scope) => {
    expect(parseBoundSecretRotationScope(scope)).toBeNull();
  });
});

describe("agent bound-secret rotate log policy", () => {
  it("classes the route as secret-sensitive", () => {
    expect(isSecretSensitiveHttpRequest("POST", "/api/agents/me/secrets/any_key/rotate")).toBe(true);
    expect(isSecretSensitiveHttpRequest("POST", "/API/AGENTS/ME/SECRETS/ANY_KEY/ROTATE")).toBe(true);
  });

  it.each([
    ["absolute http", "http://localhost/api/agents/me/secrets/any_key/rotate"],
    ["absolute https upper case", "HTTPS://LOCALHOST:3100/API/Agents/Me/Secrets/ANY_KEY/Rotate?x=1"],
    ["trailing slash", "/api/agents/me/secrets/any_key/rotate/"],
    ["percent-encoded", "/api/agents/me/secrets/any_key/%72otate"],
    ["encoded key", "/api/agents/me/secrets/a%2Fb/rotate"],
  ])("classes the %s form as secret-sensitive for every method", (_name, url) => {
    for (const method of ["POST", "PUT", "GET", "DELETE", "OPTIONS"]) {
      expect(isSecretSensitiveHttpRequest(method, url), `${method} ${url}`).toBe(true);
    }
  });

  it.each([
    [422, "origin", "/api/agents/me/secrets/dummy/rotate"],
    [422, "absolute", "http://localhost/api/agents/me/secrets/dummy/rotate"],
    [502, "origin", "/api/agents/me/secrets/dummy/rotate"],
    [502, "absolute", "http://localhost/api/agents/me/secrets/dummy/rotate"],
    [502, "absolute upper case", "HTTP://LOCALHOST/API/AGENTS/ME/SECRETS/dummy/ROTATE"],
  ])("keeps an echoed value out of the %i response and HTTP log for the %s form", async (status, _form, target) => {
    const canary = "fixture-rotate-echo-canary";
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });
    const app = express();
    app.use(createHttpLogger(pino({}, stream)));
    app.use(express.json());
    let reached = false;
    app.post("/api/agents/me/secrets/:key/rotate", (_req, _res, next) => {
      reached = true;
      // A controlled provider-style error that echoes the submitted value.
      next(new HttpError(status, `Provider refused ${canary}`));
    });
    app.use(errorHandler);
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    let body = "";
    let responseStatus = 0;
    try {
      const { port } = server.address() as { port: number };
      await new Promise<void>((resolve, reject) => {
        const client = httpRequest(
          { hostname: "127.0.0.1", port, method: "POST", path: target, headers: { "content-type": "application/json" } },
          (res) => {
            responseStatus = res.statusCode ?? 0;
            res.on("data", (chunk) => { body += chunk; });
            res.on("end", resolve);
          },
        );
        client.on("error", reject);
        client.end(JSON.stringify({ value: canary }));
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
    // Wait for the asynchronous log write to land.
    await new Promise((resolve) => setImmediate(resolve));
    expect(reached).toBe(true);
    expect(responseStatus).toBe(status);
    expect(body).not.toContain(canary);
    expect(chunks.join("")).not.toContain(canary);
  });
});

describeEmbeddedPostgres("agent bound-secret rotate route", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-agent-bound-rotate-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("agent-bound-secret-rotate");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(activityLog);
    await db.delete(secretAccessEvents);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
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

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Bound rotate fixture",
      issuePrefix: `R${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name: string) {
    const agentId = randomUUID();
    const heartbeatRunId = randomUUID();
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
    await db.insert(heartbeatRuns).values({
      id: heartbeatRunId,
      companyId,
      agentId,
      status: "running",
      contextSnapshot: {},
    });
    await accessService(db).ensureMembership(companyId, "agent", agentId, "member", "active");
    return { companyId, agentId, heartbeatRunId };
  }

  type AgentFixture = Awaited<ReturnType<typeof seedAgent>>;

  function agentApp(fixture: AgentFixture, options: ActorOptions = {}) {
    const source = options.source ?? "agent_jwt";
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "agent",
        agentId: fixture.agentId,
        companyId: fixture.companyId,
        runId: options.runId === undefined ? fixture.heartbeatRunId : (options.runId ?? undefined),
        keyScope: options.keyScope ?? { kind: "standard" },
        keyId: source === "agent_key" ? randomUUID() : undefined,
        source,
      };
      next();
    });
    app.use("/api", secretRoutes(db));
    app.use(errorHandler);
    return app;
  }

  function boardApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: BOARD_USER_ID,
        companyIds: [companyId],
        isInstanceAdmin: true,
        source: "local_implicit",
      } as typeof req.actor;
      next();
    });
    app.use("/api", secretRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function createBoundSecret(fixture: AgentFixture, key: string, value: string) {
    const svc = secretService(db);
    const secret = await svc.create(fixture.companyId, {
      key,
      name: `${key} name`,
      description: "Rotation fixture",
      provider: "local_encrypted",
      value,
    });
    const binding = await svc.createBinding({
      companyId: fixture.companyId,
      secretId: secret.id,
      targetType: "agent",
      targetId: fixture.agentId,
      configPath: `access.${key}`,
    });
    return { secret, binding };
  }

  async function grant(fixture: AgentFixture, scope: Record<string, unknown> | null, grantedByUserId: string | null = BOARD_USER_ID) {
    await accessService(db).setPrincipalPermission(
      fixture.companyId,
      "agent",
      fixture.agentId,
      "secrets:rotate_bound",
      true,
      grantedByUserId,
      scope,
    );
    const [row] = await db.select().from(principalPermissionGrants)
      .where(eq(principalPermissionGrants.principalId, fixture.agentId));
    return row;
  }

  async function secretState(secretId: string) {
    const [row] = await db.select().from(companySecrets).where(eq(companySecrets.id, secretId));
    const versions = await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, secretId));
    return { row, versionCount: versions.length };
  }

  async function resolvedValue(companyId: string, secretId: string) {
    return secretService(db).resolveSecretValue(companyId, secretId, "latest");
  }

  function captureLogs() {
    const calls: unknown[][] = [];
    for (const level of ["info", "warn", "error", "debug", "trace", "fatal"] as const) {
      vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
        calls.push(args);
      }) as never);
    }
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        calls.push(args);
      });
    }
    return () => JSON.stringify(calls, (_key, value) => (value instanceof Error ? { message: value.message, stack: value.stack } : value));
  }

  async function rotate(app: express.Express, key: string, body: unknown = { value: NEW_VALUE }) {
    return request(app).post(`/api/agents/me/secrets/${key}/rotate`).send(body as object);
  }

  it("rotates exactly the granted bound record atomically and never discloses the value", async () => {
    const companyId = await seedCompany();
    const caller = await seedAgent(companyId, "Rotator");
    const peer = await seedAgent(companyId, "Peer");
    const target = await createBoundSecret(caller, "ROTATE_TARGET", OLD_VALUE);
    const other = await createBoundSecret(caller, "OTHER_RECORD", OTHER_VALUE);
    const peerBinding = await secretService(db).createBinding({
      companyId,
      secretId: target.secret.id,
      targetType: "agent",
      targetId: peer.agentId,
      configPath: "access.ROTATE_TARGET",
    });
    const grantRow = await grant(caller, { secretId: target.secret.id, bindingId: target.binding.id });
    const before = await secretState(target.secret.id);
    const otherBefore = await secretState(other.secret.id);
    const bindingsBefore = await db.select().from(companySecretBindings);
    const logs = captureLogs();

    const res = await rotate(agentApp(caller), "rotate_target");

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({ id: target.secret.id, key: "rotate_target", version: 2 });

    const after = await secretState(target.secret.id);
    expect(after.row.latestVersion).toBe(before.row.latestVersion + 1);
    expect(after.versionCount).toBe(before.versionCount + 1);
    expect(after.row).toMatchObject({
      key: before.row.key,
      name: before.row.name,
      description: before.row.description,
      provider: before.row.provider,
      providerConfigId: before.row.providerConfigId,
      managedMode: before.row.managedMode,
      scope: before.row.scope,
      status: "active",
      externalRef: before.row.externalRef,
    });
    expect(after.row.providerMetadata).toEqual(before.row.providerMetadata);
    expect(await resolvedValue(companyId, target.secret.id)).toBe(NEW_VALUE);
    const [newVersion] = await db.select().from(companySecretVersions)
      .where(eq(companySecretVersions.secretId, target.secret.id))
      .then((rows) => rows.filter((row) => row.version === 2));
    expect(newVersion).toMatchObject({ status: "current", createdByAgentId: caller.agentId, createdByUserId: null });

    // The agent's existing read path now resolves the new value.
    const read = await request(agentApp(caller)).post("/api/agents/me/secrets/rotate_target/value");
    expect(read.body).toMatchObject({ value: NEW_VALUE, version: 2 });

    // Other records and every binding are unchanged.
    expect(await secretState(other.secret.id)).toEqual(otherBefore);
    expect(await resolvedValue(companyId, other.secret.id)).toBe(OTHER_VALUE);
    expect(await db.select().from(companySecretBindings)).toEqual(expect.arrayContaining(bindingsBefore));
    expect((await db.select().from(companySecretBindings)).length).toBe(bindingsBefore.length);
    expect(bindingsBefore.some((binding) => binding.id === peerBinding.id)).toBe(true);

    // One audit row with the required fields and no value or fingerprint.
    const rotatedRows = (await db.select().from(activityLog)).filter((row) => row.action === "secret.rotated");
    expect(rotatedRows).toHaveLength(1);
    expect(rotatedRows[0]).toMatchObject({
      actorType: "agent",
      actorId: caller.agentId,
      agentId: caller.agentId,
      runId: caller.heartbeatRunId,
      entityType: "secret",
      entityId: target.secret.id,
      details: {
        secretId: target.secret.id,
        bindingId: target.binding.id,
        version: 2,
        grantId: grantRow.id,
        reason: "allow_explicit_grant",
      },
    });
    const fingerprint = createHash("sha256").update(NEW_VALUE).digest("hex");
    const allActivity = JSON.stringify(await db.select().from(activityLog));
    expect(allActivity).not.toContain(NEW_VALUE);
    expect(allActivity).not.toContain(OLD_VALUE);
    expect(allActivity).not.toContain(fingerprint);
    expect(JSON.stringify(res.body)).not.toContain(NEW_VALUE);
    expect(JSON.stringify(res.body)).not.toContain(fingerprint);
    expect(logs()).not.toContain(NEW_VALUE);
    expect(logs()).not.toContain(fingerprint);

    // The value is registered with the run redaction registry, encrypted.
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, caller.heartbeatRunId));
    expect(JSON.stringify(run.contextSnapshot)).not.toContain(NEW_VALUE);
    expect((run.contextSnapshot as { paperclipSecretRedactions?: Array<{ fingerprintSha256: string }> }).paperclipSecretRedactions)
      .toEqual(expect.arrayContaining([expect.objectContaining({ fingerprintSha256: fingerprint })]));
  });

  it("keeps a grant on an unchanged env binding working after unrelated adapterConfig edits, and denies it after a re-point", async () => {
    const companyId = await seedCompany();
    const caller = await seedAgent(companyId, "Rotator");
    const svc = secretService(db);
    const make = (key: string, value: string) => svc.create(companyId, {
      key, name: `${key} name`, description: "Rotation fixture", provider: "local_encrypted", value,
    });
    const target = await make("ENV_TARGET", OLD_VALUE);
    const other = await make("ENV_OTHER", OTHER_VALUE);
    const replacement = await make("ENV_REPLACEMENT", OTHER_VALUE);
    const ref = (secretId: string) => ({ type: "secret_ref" as const, secretId, version: "latest" as const });
    const setEnv = (env: Record<string, unknown>) => agentService(db).update(caller.agentId, { adapterConfig: { env } });

    await setEnv({ ENV_TARGET: ref(target.id) });
    const [binding] = await db.select().from(companySecretBindings)
      .where(eq(companySecretBindings.targetId, caller.agentId));
    await grant(caller, { secretId: target.id, bindingId: binding.id });

    // Unrelated add, then unrelated remove: the granted binding keeps its id.
    await setEnv({ ENV_TARGET: ref(target.id), ENV_OTHER: ref(other.id) });
    expect((await rotate(agentApp(caller), "env_target")).status).toBe(200);
    await setEnv({ ENV_TARGET: ref(target.id) });
    expect((await rotate(agentApp(caller), "env_target", { value: "fixture-third-rotate-value" })).status).toBe(200);
    expect(await resolvedValue(companyId, target.id)).toBe("fixture-third-rotate-value");
    const [kept] = await db.select().from(companySecretBindings)
      .where(eq(companySecretBindings.targetId, caller.agentId));
    expect(kept.id).toBe(binding.id);

    // Re-point the granted path to another secret: a new binding id, so the
    // old grant covers neither the new binding nor the unbound old secret.
    await setEnv({ ENV_TARGET: ref(replacement.id) });
    const [repointed] = await db.select().from(companySecretBindings)
      .where(eq(companySecretBindings.targetId, caller.agentId));
    expect(repointed.id).not.toBe(binding.id);
    const replacementBefore = await secretState(replacement.id);
    const denyNew = await rotate(agentApp(caller), "env_replacement");
    expect(denyNew.status).toBe(403);
    expect((await secretState(replacement.id)).versionCount).toBe(replacementBefore.versionCount);
    expect((await rotate(agentApp(caller), "env_target")).status).toBe(403);
    expect(await resolvedValue(companyId, target.id)).toBe("fixture-third-rotate-value");
  });

  it("denies a second bound record outside the grant scope and changes nothing", async () => {
    const companyId = await seedCompany();
    const caller = await seedAgent(companyId, "Rotator");
    const target = await createBoundSecret(caller, "ROTATE_TARGET", OLD_VALUE);
    const other = await createBoundSecret(caller, "OTHER_RECORD", OTHER_VALUE);
    const grantRow = await grant(caller, { secretId: target.secret.id, bindingId: target.binding.id });
    const otherBefore = await secretState(other.secret.id);

    const res = await rotate(agentApp(caller), "other_record");

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain(NEW_VALUE);
    expect(await secretState(other.secret.id)).toEqual(otherBefore);
    expect(await resolvedValue(companyId, other.secret.id)).toBe(OTHER_VALUE);
    const activity = await db.select().from(activityLog);
    expect(activity.filter((row) => row.action === "secret.rotated")).toEqual([]);
    expect(activity.filter((row) => row.action === "secret.rotate_denied")).toEqual([
      expect.objectContaining({
        actorType: "agent",
        agentId: caller.agentId,
        runId: caller.heartbeatRunId,
        entityId: other.secret.id,
        details: expect.objectContaining({ reason: "deny_scope", secretId: other.secret.id, grantId: grantRow.id }),
      }),
    ]);
    expect(JSON.stringify(activity)).not.toContain(NEW_VALUE);
  });

  it("denies unrelated callers and changes nothing", async () => {
    const companyId = await seedCompany();
    const caller = await seedAgent(companyId, "Rotator");
    const peer = await seedAgent(companyId, "Peer");
    const target = await createBoundSecret(caller, "ROTATE_TARGET", OLD_VALUE);
    await secretService(db).createBinding({
      companyId,
      secretId: target.secret.id,
      targetType: "agent",
      targetId: peer.agentId,
      configPath: "access.ROTATE_TARGET",
    });
    await grant(caller, { secretId: target.secret.id, bindingId: target.binding.id });
    const before = await secretState(target.secret.id);

    const logs = captureLogs();
    const cases: Array<{ name: string; app: express.Express; reason: string | null; runId?: string }> = [
      { name: "peer agent bound to the record without a grant", app: agentApp(peer), reason: "deny_missing_grant", runId: peer.heartbeatRunId },
      { name: "board actor", app: boardApp(companyId), reason: null },
      { name: "task bridge key", app: agentApp(caller, { source: "agent_key", keyScope: { kind: "task_bridge", parentIssueId: randomUUID() } }), reason: "deny_agent_key" },
      { name: "task bridge scope on a run token", app: agentApp(caller, { keyScope: { kind: "task_bridge", parentIssueId: randomUUID() } }), reason: "deny_key_scope_task_bridge" },
      { name: "skill test scope", app: agentApp(caller, { keyScope: { kind: "skill_test", issueId: randomUUID() } }), reason: "deny_key_scope_skill_test" },
      { name: "standard agent key", app: agentApp(caller, { source: "agent_key" }), reason: "deny_agent_key" },
      { name: "non-run token", app: agentApp(caller, { runId: null }), reason: "deny_no_run" },
      { name: "token for an unknown run", app: agentApp(caller, { runId: randomUUID() }), reason: "deny_run_not_verified" },
      { name: "token for a malformed run id", app: agentApp(caller, { runId: "not-a-run-id" }), reason: "deny_run_not_verified" },
      { name: "token for another agent's run", app: agentApp(caller, { runId: peer.heartbeatRunId }), reason: "deny_run_not_verified" },
    ];
    for (const testCase of cases) {
      const deniedBefore = (await db.select().from(activityLog)).filter((row) => row.action === "secret.rotate_denied").length;
      const res = await rotate(testCase.app, "rotate_target");
      expect(res.status, testCase.name).toBe(403);
      expect(JSON.stringify(res.body), testCase.name).not.toContain(NEW_VALUE);
      const denied = (await db.select().from(activityLog)).filter((row) => row.action === "secret.rotate_denied");
      if (testCase.reason === null) {
        // A board actor has no single company here, so no activity row is
        // attributed; a sanitised server audit line records the denial.
        expect(denied.length, testCase.name).toBe(deniedBefore);
        continue;
      }
      expect(denied.length, testCase.name).toBe(deniedBefore + 1);
      const latest = denied.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).at(-1)!;
      expect((latest.details as { reason?: string }).reason, testCase.name).toBe(testCase.reason);
      expect(latest.actorType, testCase.name).toBe("agent");
      expect(latest.companyId, testCase.name).toBe(companyId);
      // An unverified run claim is never stored as the audit run id.
      expect(latest.runId, testCase.name).toBe(testCase.runId ?? null);
    }
    const logText = logs();
    expect(logText).toContain("secret.rotate_denied");
    expect(logText).not.toContain(NEW_VALUE);

    expect(await secretState(target.secret.id)).toEqual(before);
    expect(await resolvedValue(companyId, target.secret.id)).toBe(OLD_VALUE);
    const activity = await db.select().from(activityLog);
    expect(activity.filter((row) => row.action === "secret.rotated")).toEqual([]);
    expect(JSON.stringify(activity)).not.toContain(NEW_VALUE);
  });

  it("records a denial when the access list refuses secret reads", async () => {
    const companyId = await seedCompany();
    const caller = await seedAgent(companyId, "Rotator");
    const target = await createBoundSecret(caller, "ROTATE_TARGET", OLD_VALUE);
    await grant(caller, { secretId: target.secret.id, bindingId: target.binding.id });
    // A low-trust review preset denies `secrets:read`, so the access list
    // itself rejects the caller before any binding is selected.
    await db.update(agents).set({
      permissions: {
        trustPreset: "low_trust_review",
        authorizationPolicy: { trustBoundary: { mode: "low_trust_review", rootIssueId: randomUUID() } },
      },
    }).where(eq(agents.id, caller.agentId));
    const before = await secretState(target.secret.id);

    const res = await rotate(agentApp(caller), "rotate_target");
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain(NEW_VALUE);
    expect(await secretState(target.secret.id)).toEqual(before);

    const activity = await db.select().from(activityLog);
    const denied = activity.filter((row) => row.action === "secret.rotate_denied");
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({
      actorType: "agent",
      actorId: caller.agentId,
      agentId: caller.agentId,
      runId: caller.heartbeatRunId,
      details: expect.objectContaining({ stage: "secret_access", runVerified: true, secretId: null }),
    });
    expect(activity.filter((row) => row.action === "secret.rotated")).toEqual([]);
    expect(JSON.stringify(activity)).not.toContain(NEW_VALUE);
  });

  it("denies a missing binding, a deleted record and a cross-company record", async () => {
    const companyId = await seedCompany();
    const caller = await seedAgent(companyId, "Rotator");
    const svc = secretService(db);

    // Missing binding: the grant names a real record the agent is not bound to.
    const unbound = await svc.create(companyId, { key: "UNBOUND", name: "Unbound", provider: "local_encrypted", value: OLD_VALUE });
    await grant(caller, { secretId: unbound.id, bindingId: randomUUID() });
    expect((await rotate(agentApp(caller), "unbound")).status).toBe(403);
    expect((await secretState(unbound.id)).row.latestVersion).toBe(1);

    // Deleted record: bound and granted, then deleted.
    const deleted = await createBoundSecret(caller, "DELETED_RECORD", OLD_VALUE);
    await grant(caller, { secretId: deleted.secret.id, bindingId: deleted.binding.id });
    await db.update(companySecrets).set({ status: "deleted" }).where(eq(companySecrets.id, deleted.secret.id));
    expect((await rotate(agentApp(caller), "deleted_record")).status).toBe(403);
    expect((await secretState(deleted.secret.id)).row.latestVersion).toBe(1);

    // Cross-company: a record in another company, with a binding row that
    // names this agent, and a grant that names that record.
    const foreignCompanyId = await seedCompany();
    const foreign = await svc.create(foreignCompanyId, { key: "FOREIGN_RECORD", name: "Foreign", provider: "local_encrypted", value: OTHER_VALUE });
    const [foreignBinding] = await db.insert(companySecretBindings).values({
      companyId: foreignCompanyId,
      secretId: foreign.id,
      targetType: "agent",
      targetId: caller.agentId,
      configPath: "access.FOREIGN_RECORD",
    }).returning();
    await grant(caller, { secretId: foreign.id, bindingId: foreignBinding.id });
    expect((await rotate(agentApp(caller), "foreign_record")).status).toBe(403);
    expect((await secretState(foreign.id)).row.latestVersion).toBe(1);
    expect(await resolvedValue(foreignCompanyId, foreign.id)).toBe(OTHER_VALUE);

    // A project binding reached only through the run manifest is not the
    // agent's own binding.
    const projectSecret = await svc.create(companyId, { key: "PROJECT_RECORD", name: "Project", provider: "local_encrypted", value: OLD_VALUE });
    const projectBinding = await svc.createBinding({
      companyId,
      secretId: projectSecret.id,
      targetType: "project",
      targetId: randomUUID(),
      configPath: "env.PROJECT_RECORD",
    });
    await db.update(heartbeatRuns).set({
      contextSnapshot: { paperclipSecrets: { manifest: [{ bindingId: projectBinding.id, secretId: projectSecret.id }] } },
    }).where(eq(heartbeatRuns.id, caller.heartbeatRunId));
    await grant(caller, { secretId: projectSecret.id, bindingId: projectBinding.id });
    expect((await rotate(agentApp(caller), "project_record")).status).toBe(403);
    expect((await secretState(projectSecret.id)).row.latestVersion).toBe(1);

    expect((await db.select().from(activityLog)).filter((row) => row.action === "secret.rotated")).toEqual([]);
  });

  it("denies a grant not recorded by a board user, an unparsable scope and a scope naming another binding", async () => {
    const companyId = await seedCompany();
    const caller = await seedAgent(companyId, "Rotator");
    const target = await createBoundSecret(caller, "ROTATE_TARGET", OLD_VALUE);

    await grant(caller, { secretId: target.secret.id, bindingId: target.binding.id }, null);
    expect((await rotate(agentApp(caller), "rotate_target")).status).toBe(403);

    for (const scope of [
      null,
      {},
      { secretId: target.secret.id },
      { secretId: [target.secret.id], bindingId: target.binding.id },
      { secretId: target.secret.id, bindingId: target.binding.id, extra: true },
      { secretId: target.secret.id, bindingId: randomUUID() },
    ]) {
      await grant(caller, scope);
      const res = await rotate(agentApp(caller), "rotate_target");
      expect(res.status, JSON.stringify(scope)).toBe(403);
    }
    expect((await secretState(target.secret.id)).row.latestVersion).toBe(1);

    // The generic decision path never authorises this key, whatever the grant.
    await grant(caller, { secretId: target.secret.id, bindingId: target.binding.id });
    const generic = await authorizationService(db).decide({
      actor: { type: "agent", agentId: caller.agentId, companyId, source: "agent_jwt", runId: caller.heartbeatRunId },
      action: "secrets:rotate_bound",
      resource: { type: "company", companyId },
    });
    expect(generic.allowed).toBe(false);
  });

  it("rejects bodies other than a bounded value without echoing input", async () => {
    const companyId = await seedCompany();
    const caller = await seedAgent(companyId, "Rotator");
    const target = await createBoundSecret(caller, "ROTATE_TARGET", OLD_VALUE);
    await grant(caller, { secretId: target.secret.id, bindingId: target.binding.id });

    const bodies = [
      {},
      { value: "" },
      { value: "   " },
      { value: NEW_VALUE, providerConfigId: randomUUID() },
      { value: NEW_VALUE, externalRef: "fixture-ref" },
      { value: `${NEW_VALUE}${"x".repeat(64 * 1024)}` },
    ];
    for (const body of bodies) {
      const res = await rotate(agentApp(caller), "rotate_target", body);
      expect(res.status, JSON.stringify(Object.keys(body))).toBe(422);
      expect(JSON.stringify(res.body)).not.toContain(NEW_VALUE);
    }
    expect((await secretState(target.secret.id)).row.latestVersion).toBe(1);
  });

  it("leaves the version and value unchanged when the provider fails mid-rotate", async () => {
    const companyId = await seedCompany();
    const caller = await seedAgent(companyId, "Rotator");
    const target = await createBoundSecret(caller, "ROTATE_TARGET", OLD_VALUE);
    await grant(caller, { secretId: target.secret.id, bindingId: target.binding.id });
    const before = await secretState(target.secret.id);
    const logs = captureLogs();
    vi.spyOn(localEncryptedProvider, "createVersion").mockRejectedValueOnce(
      new Error(`provider write failed for ${NEW_VALUE}`),
    );

    const res = await rotate(agentApp(caller), "rotate_target");

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).not.toContain(NEW_VALUE);
    expect(await secretState(target.secret.id)).toEqual(before);
    expect(await resolvedValue(companyId, target.secret.id)).toBe(OLD_VALUE);
    const activity = await db.select().from(activityLog);
    expect(activity.filter((row) => row.action === "secret.rotated")).toEqual([]);
    expect(JSON.stringify(activity)).not.toContain(NEW_VALUE);
    expect(logs()).not.toContain(NEW_VALUE);
  });

  it("fails closed with a stale conflict when another rotation wins the race", async () => {
    const companyId = await seedCompany();
    const caller = await seedAgent(companyId, "Rotator");
    const target = await createBoundSecret(caller, "ROTATE_TARGET", OLD_VALUE);
    await grant(caller, { secretId: target.secret.id, bindingId: target.binding.id });
    const svc = secretService(db);
    // A concurrent board rotation lands after the access list is read but
    // before this rotation writes.
    const original = localEncryptedProvider.createVersion.bind(localEncryptedProvider);
    let raced = false;
    vi.spyOn(localEncryptedProvider, "createVersion").mockImplementation(async (input) => {
      if (!raced) {
        raced = true;
        await svc.rotate(target.secret.id, { value: OTHER_VALUE }, { userId: BOARD_USER_ID, agentId: null });
      }
      return original(input);
    });

    const res = await rotate(agentApp(caller), "rotate_target");

    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).not.toContain(NEW_VALUE);
    expect((await secretState(target.secret.id)).row.latestVersion).toBe(2);
    expect(await resolvedValue(companyId, target.secret.id)).toBe(OTHER_VALUE);
    expect((await db.select().from(activityLog)).filter((row) => row.action === "secret.rotated")).toEqual([]);
  });

  it("denies the next attempt after the grant is removed", async () => {
    const companyId = await seedCompany();
    const caller = await seedAgent(companyId, "Rotator");
    const target = await createBoundSecret(caller, "ROTATE_TARGET", OLD_VALUE);
    await grant(caller, { secretId: target.secret.id, bindingId: target.binding.id });

    expect((await rotate(agentApp(caller), "rotate_target")).status).toBe(200);

    await accessService(db).setPrincipalPermission(companyId, "agent", caller.agentId, "secrets:rotate_bound", false, BOARD_USER_ID);
    const denied = await rotate(agentApp(caller), "rotate_target", { value: `${NEW_VALUE}-again` });

    expect(denied.status).toBe(403);
    expect((await secretState(target.secret.id)).row.latestVersion).toBe(2);
    expect(await resolvedValue(companyId, target.secret.id)).toBe(NEW_VALUE);
    expect((await db.select().from(activityLog)).filter((row) => row.action === "secret.rotate_denied")).toEqual([
      expect.objectContaining({ details: expect.objectContaining({ reason: "deny_missing_grant", grantId: null }) }),
    ]);
  });
});
