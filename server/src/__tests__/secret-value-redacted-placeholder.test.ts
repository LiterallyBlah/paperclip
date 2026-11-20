import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companySecretBindings,
  companySecretProposals,
  companySecretVersions,
  companySecrets,
  createDb,
  heartbeatRuns,
  issueComments,
  issueThreadInteractions,
  issues,
  userSecretDeclarations,
  userSecretDefinitions,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import { secretRoutes } from "../routes/secrets.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import { validateProjectInstanceSecretChanges } from "../services/project-instance-secrets.js";
import {
  SECRET_VALUE_REDACTED_PLACEHOLDER_CODE,
  secretService,
} from "../services/secrets.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// Synthetic values only. The placeholder is the read-side display mask that
// agent config reads return for every plain env value.
const MASK = REDACTED_EVENT_VALUE;
const PLACEHOLDER_VARIANTS = [MASK, `  ${MASK}  `, `\n${MASK}\t`];

describe("validateProjectInstanceSecretChanges", () => {
  it("rejects the display placeholder and keeps legitimate values", () => {
    for (const value of PLACEHOLDER_VARIANTS) {
      expect(() => validateProjectInstanceSecretChanges({ runtime: value })).toThrow(
        "Invalid project instance secret changes",
      );
    }
    expect(() => validateProjectInstanceSecretChanges({ runtime: `x${MASK}y` })).not.toThrow();
    expect(() => validateProjectInstanceSecretChanges({ runtime: null })).not.toThrow();
  });
});

describeEmbeddedPostgres("secret value writes reject the redacted display placeholder", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-redacted-placeholder-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("secret-redacted-placeholder");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(companySecretProposals);
    await db.delete(issueThreadInteractions);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(userSecretDeclarations);
    await db.delete(userSecretDefinitions);
    await db.delete(issues);
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

  async function seedRun() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const heartbeatRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Placeholder fixture",
      issuePrefix: `R${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Proposer",
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
      responsibleUserId: "user-1",
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Needs credential",
      identifier: "RED-1",
      status: "in_progress",
      responsibleUserId: "user-1",
      executionRunId: heartbeatRunId,
    });
    return { companyId, agentId, heartbeatRunId, issueId };
  }

  function boardApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "board-user",
        companyIds: [companyId],
        source: "local_implicit",
      };
      next();
    });
    app.use("/api", secretRoutes(db));
    app.use(errorHandler);
    return app;
  }

  function agentApp(fixture: Awaited<ReturnType<typeof seedRun>>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "agent",
        agentId: fixture.agentId,
        companyId: fixture.companyId,
        runId: fixture.heartbeatRunId,
        source: "agent_jwt",
        keyScope: { kind: "standard" },
      };
      next();
    });
    app.use("/api", secretRoutes(db));
    app.use(errorHandler);
    return app;
  }

  function expectPlaceholderRejection(res: request.Response) {
    expect(res.status).toBe(422);
    expect(res.body.code).toBe(SECRET_VALUE_REDACTED_PLACEHOLDER_CODE);
    expect(typeof res.body.error).toBe("string");
    // The message never echoes the submitted value.
    expect(JSON.stringify(res.body)).not.toContain(MASK);
  }

  async function expectRejectsWithCode(promise: Promise<unknown>) {
    await expect(promise).rejects.toMatchObject({
      status: 422,
      details: { code: SECRET_VALUE_REDACTED_PLACEHOLDER_CODE },
    });
  }

  async function snapshot(companyId: string) {
    const secrets = await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId));
    const versions = await db.select().from(companySecretVersions);
    const bindings = await db.select().from(companySecretBindings).where(eq(companySecretBindings.companyId, companyId));
    return { secrets, versions, bindings };
  }

  it("repro: the env editor's Store-as-secret request cannot persist the mask as v1", async () => {
    // The UI's ConvertToSecretPopover calls createSecret.mutateAsync({ name, value })
    // -> POST /api/companies/:id/secrets with the row's displayed value. On a
    // read-back agent config that value is the mask.
    const { companyId } = await seedRun();
    const res = await request(boardApp(companyId))
      .post(`/api/companies/${companyId}/secrets`)
      .send({ name: "stripe_api_key", value: MASK });
    const stored = await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId));
    const storedValues = await Promise.all(
      stored.map((row) => secretService(db).resolveSecretValue(companyId, row.id, 1)),
    );
    expect(storedValues, "a stored secret v1 equals the display mask").not.toContain(MASK);
    expect(stored).toEqual([]);
    expectPlaceholderRejection(res);
  });

  it("POST /companies/:id/secrets rejects the placeholder (trimmed) and stores nothing", async () => {
    const { companyId } = await seedRun();
    const app = boardApp(companyId);
    for (const [index, value] of PLACEHOLDER_VARIANTS.entries()) {
      const res = await request(app)
        .post(`/api/companies/${companyId}/secrets`)
        .send({ name: `stripe_api_key_${index}`, value });
      expectPlaceholderRejection(res);
    }
    const after = await snapshot(companyId);
    expect(after.secrets).toEqual([]);
    expect(after.versions).toEqual([]);
  });

  it("POST /secrets/:id/rotate rejects the placeholder: no new version, binding unchanged", async () => {
    const { companyId, agentId } = await seedRun();
    const app = boardApp(companyId);
    const created = await request(app)
      .post(`/api/companies/${companyId}/secrets`)
      .send({ name: "stripe_api_key", value: "synthetic-original-value" });
    expect(created.status).toBe(201);
    const secretId = created.body.id as string;
    await secretService(db).createBinding({
      companyId,
      secretId,
      targetType: "agent",
      targetId: agentId,
      configPath: "env.STRIPE_API_KEY",
      versionSelector: "latest",
      required: true,
    });
    const before = await snapshot(companyId);

    for (const value of PLACEHOLDER_VARIANTS) {
      const res = await request(app).post(`/api/secrets/${secretId}/rotate`).send({ value });
      expectPlaceholderRejection(res);
    }

    const after = await snapshot(companyId);
    expect(after.versions).toEqual(before.versions);
    expect(after.bindings).toEqual(before.bindings);
    expect(after.secrets.map((row) => row.latestVersion)).toEqual([1]);
    const resolved = await secretService(db).resolveSecretValue(companyId, secretId, "latest");
    expect(resolved).toBe("synthetic-original-value");

    const rotated = await request(app)
      .post(`/api/secrets/${secretId}/rotate`)
      .send({ value: "synthetic-rotated-value" });
    expect(rotated.status).toBe(200);
    expect(rotated.body.latestVersion).toBe(2);
    expect(await secretService(db).resolveSecretValue(companyId, secretId, "latest")).toBe("synthetic-rotated-value");
  });

  it("keeps legitimate values: substring of the mask, very long and unicode values", async () => {
    const { companyId } = await seedRun();
    const app = boardApp(companyId);
    const legit = [
      `prefix-${MASK}`,
      `${MASK}-suffix`,
      "***REDACTED**",
      "x".repeat(60_000),
      "pässwörd-🔐-密码",
    ];
    for (const [index, value] of legit.entries()) {
      const res = await request(app)
        .post(`/api/companies/${companyId}/secrets`)
        .send({ name: `legit_${index}`, value });
      expect(res.status).toBe(201);
      expect(await secretService(db).resolveSecretValue(companyId, res.body.id, "latest")).toBe(value);
    }
  });

  it("service create/rotate (shared by every internal caller) reject the placeholder before writing", async () => {
    const { companyId } = await seedRun();
    const svc = secretService(db);
    await expectRejectsWithCode(svc.create(companyId, { name: "internal_create", provider: "local_encrypted", value: MASK }));
    expect((await snapshot(companyId)).secrets).toEqual([]);

    const created = await svc.create(companyId, { name: "internal_rotate", provider: "local_encrypted", value: "synthetic-v1" });
    await expectRejectsWithCode(svc.rotate(created.id, { value: ` ${MASK} ` }));
    expect((await svc.getById(created.id))!.latestVersion).toBe(1);
    expect(await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, created.id))).toHaveLength(1);
  });

  it("user secret value create, rotate and update reject the placeholder", async () => {
    const { companyId } = await seedRun();
    const svc = secretService(db);
    const app = boardApp(companyId);
    const definition = await svc.createUserSecretDefinition(companyId, {
      key: "personal_token",
      name: "Personal token",
      provider: "local_encrypted",
    });

    const rejectedCreate = await request(app)
      .post(`/api/companies/${companyId}/me/user-secrets`)
      .send({ definitionId: definition.id, value: MASK });
    expectPlaceholderRejection(rejectedCreate);
    expect((await snapshot(companyId)).secrets).toEqual([]);

    const created = await request(app)
      .post(`/api/companies/${companyId}/me/user-secrets`)
      .send({ definitionId: definition.id, value: "synthetic-user-v1" });
    expect(created.status).toBe(201);
    const secretId = created.body.id as string;

    const rejectedRotate = await request(app)
      .post(`/api/companies/${companyId}/me/user-secrets/${secretId}/rotate`)
      .send({ value: MASK });
    expectPlaceholderRejection(rejectedRotate);
    const rejectedUpdate = await request(app)
      .patch(`/api/companies/${companyId}/me/user-secrets/${secretId}`)
      .send({ value: `${MASK}\n` });
    expectPlaceholderRejection(rejectedUpdate);

    expect((await svc.getById(secretId))!.latestVersion).toBe(1);
    expect(await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, secretId))).toHaveLength(1);
  });

  it("instance secret set (agent and project instance scopes) rejects the placeholder", async () => {
    const { companyId, agentId } = await seedRun();
    const svc = secretService(db);
    const scope = { companyId, agentId, pluginId: randomUUID() };
    await expectRejectsWithCode(svc.agentInstance.set(scope, "runtime", MASK));
    expect((await snapshot(companyId)).secrets).toEqual([]);
  });

  it("secret proposal submission rejects the placeholder and stores no proposal", async () => {
    const fixture = await seedRun();
    const res = await request(agentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({ kind: "secret", name: "dev/placeholder/token", value: MASK, justification: "Needed" });
    expectPlaceholderRejection(res);
    expect(await db.select().from(companySecretProposals)).toEqual([]);
  });

  it("secret proposal approval never materialises a stored placeholder", async () => {
    const fixture = await seedRun();
    const proposed = await request(agentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({ kind: "secret", name: "dev/legacy/token", value: "synthetic-proposed", justification: "Needed" });
    expect(proposed.status).toBe(201);
    // A proposal recorded before submission-time rejection existed.
    const legacyCiphertext = (await localEncryptedProvider.createSecret({ value: MASK })).material;
    await db.update(companySecretProposals)
      .set({ valueCiphertext: legacyCiphertext })
      .where(eq(companySecretProposals.id, proposed.body.id));

    const approved = await request(boardApp(fixture.companyId))
      .post(`/api/companies/${fixture.companyId}/secret-proposals/${proposed.body.id}/approve`)
      .send({});
    expectPlaceholderRejection(approved);
    expect((await snapshot(fixture.companyId)).secrets).toEqual([]);
    const [proposal] = await db.select().from(companySecretProposals).where(eq(companySecretProposals.id, proposed.body.id));
    expect(proposal.status).toBe("pending");
  });

  it("env normalisation still refuses a plain env placeholder, now also when padded", async () => {
    const { companyId } = await seedRun();
    for (const value of PLACEHOLDER_VARIANTS) {
      await expect(secretService(db).normalizeEnvBindingsForPersistence(companyId, {
        STRIPE_API_KEY: { type: "plain", value },
      })).rejects.toMatchObject({ status: 422 });
    }
    await expect(secretService(db).normalizeEnvBindingsForPersistence(companyId, {
      NOTE: { type: "plain", value: `see ${MASK}` },
      EMPTY: { type: "plain", value: "" },
    })).resolves.toEqual({
      NOTE: { type: "plain", value: `see ${MASK}` },
      EMPTY: { type: "plain", value: "" },
    });
  });
});
