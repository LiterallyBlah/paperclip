import { createPrivateKey, createPublicKey, randomBytes, randomUUID, sign, verify } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { activityLog, agentIdentityKeys, agents, companies, companyMemberships, createDb, principalPermissionGrants, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentIdentityService } from "../services/agent-identity.js";
import { createAgentIdentityRedactor } from "../services/agent-identity-redaction.js";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/error-handler.js";

const board = { actorType: "user" as const, actorId: "rotation-test-board" };

function spki(pem: string) {
  return createPublicKey(pem).export({ type: "spki", format: "der" });
}

describe("agent identity rotation", () => {
  let db: Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let directory: string;
  let companyId: string;
  let otherCompanyId: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "paperclip-identity-rotation-"));
    vi.stubEnv("PAPERCLIP_HOME", directory);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "");
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", join(directory, "master.key"));
    database = await startEmbeddedPostgresTestDatabase("paperclip-identity-rotation-");
    db = createDb(database.connectionString);
    companyId = randomUUID();
    otherCompanyId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "Rotation test", issuePrefix: "ROT", defaultResponsibleUserId: "rotation-test-owner" },
      { id: otherCompanyId, name: "Rotation other", issuePrefix: "ROO", defaultResponsibleUserId: "rotation-test-owner" },
    ]);
  }, 60_000);
  afterAll(async () => {
    await database?.cleanup();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  async function newAgent(company = companyId) {
    const [agent] = await db.insert(agents).values({ companyId: company, name: randomUUID(), role: "engineer" }).returning();
    return agent;
  }

  async function storedRow(agentId: string) {
    return (await db.select().from(agentIdentityKeys).where(eq(agentIdentityKeys.agentId, agentId)))[0];
  }

  it("replaces the pair in place; new runs sign with the new key and the old key no longer matches", async () => {
    const agent = await newAgent();
    const svc = agentIdentityService(db);
    const before = await svc.ensureAgentIdentity(companyId, agent.id);
    const beforeRow = await storedRow(agent.id);
    await new Promise(resolve => setTimeout(resolve, 5));

    const rotated = await svc.rotateAgentIdentity(companyId, agent.id, board);
    expect(Object.keys(rotated).sort()).toEqual(["algorithm", "createdAt", "keyId", "publicKeyPem"]);
    expect(rotated.algorithm).toBe("Ed25519");
    expect(rotated.keyId).not.toBe(before.keyId);
    expect(rotated.publicKeyPem).not.toBe(before.publicKeyPem);
    expect(JSON.stringify(rotated)).not.toContain("PRIVATE KEY");
    expect(await svc.getPublicIdentity(companyId, agent.id)).toEqual(rotated);

    const afterRow = await storedRow(agent.id);
    expect(afterRow.agentId).toBe(beforeRow.agentId);
    expect(afterRow.privateKeyMaterial).not.toEqual(beforeRow.privateKeyMaterial);
    expect(afterRow.createdAt.getTime()).toBeGreaterThan(beforeRow.createdAt.getTime());
    expect(await db.select().from(agentIdentityKeys).where(eq(agentIdentityKeys.agentId, agent.id))).toHaveLength(1);

    const after = await svc.ensureAgentIdentity(companyId, agent.id);
    expect(after.keyId).toBe(rotated.keyId);
    expect(after.publicKeyPem).toBe(rotated.publicKeyPem);
    expect(after.privateKeyPem).not.toBe(before.privateKeyPem);
    expect(spki(createPublicKey(createPrivateKey(after.privateKeyPem)).export({ type: "spki", format: "pem" }).toString()).equals(spki(rotated.publicKeyPem))).toBe(true);
    const challenge = randomBytes(32);
    const signature = sign(null, challenge, after.privateKeyPem);
    expect(verify(null, challenge, rotated.publicKeyPem, signature)).toBe(true);
    expect(verify(null, challenge, before.publicKeyPem, signature)).toBe(false);

    // The previous private key no longer derives to the stored public key.
    const oldDerived = createPublicKey(createPrivateKey(before.privateKeyPem)).export({ type: "spki", format: "der" });
    expect(oldDerived.equals(spki(afterRow.publicKeyPem))).toBe(false);
    // Signatures made earlier with the old key remain valid against the old public key only.
    const oldSignature = sign(null, challenge, before.privateKeyPem);
    expect(verify(null, challenge, before.publicKeyPem, oldSignature)).toBe(true);
    expect(verify(null, challenge, rotated.publicKeyPem, oldSignature)).toBe(false);

    // A run prepared before rotation still masks the old key it was given;
    // a run prepared after rotation masks the new key.
    const oldRunRedactor = createAgentIdentityRedactor(before.privateKeyPem);
    const newRunRedactor = createAgentIdentityRedactor(after.privateKeyPem);
    expect(oldRunRedactor.redact({ output: before.privateKeyPem }).output).not.toContain(before.privateKeyPem.split("\n")[1]);
    expect(newRunRedactor.redact({ output: after.privateKeyPem }).output).not.toContain(after.privateKeyPem.split("\n")[1]);

    const activity = await db.select().from(activityLog).where(and(
      eq(activityLog.entityId, agent.id), eq(activityLog.action, "agent.identity.rotated"),
    ));
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ companyId, actorType: "user", actorId: board.actorId, entityType: "agent" });
    expect(activity[0].details).toEqual({ algorithm: "Ed25519", previousKeyId: before.keyId, keyId: rotated.keyId });
    const serialized = JSON.stringify(activity);
    for (const forbidden of ["PRIVATE KEY", "PUBLIC KEY", before.privateKeyPem.split("\n")[1], after.privateKeyPem.split("\n")[1]]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("never provisions a missing identity and refuses unknown agents and other companies", async () => {
    const svc = agentIdentityService(db);
    const unprovisioned = await newAgent();
    await expect(svc.rotateAgentIdentity(companyId, unprovisioned.id, board)).rejects.toMatchObject({ status: 404 });
    expect(await storedRow(unprovisioned.id)).toBeUndefined();

    await expect(svc.rotateAgentIdentity(companyId, randomUUID(), board)).rejects.toMatchObject({ status: 404 });

    const provisioned = await newAgent();
    const original = await svc.ensureAgentIdentity(companyId, provisioned.id);
    await expect(svc.rotateAgentIdentity(otherCompanyId, provisioned.id, board)).rejects.toMatchObject({ status: 404 });
    expect((await svc.getPublicIdentity(companyId, provisioned.id))?.keyId).toBe(original.keyId);
    expect(await db.select().from(activityLog).where(and(
      eq(activityLog.action, "agent.identity.rotated"),
      eq(activityLog.entityId, provisioned.id),
    ))).toHaveLength(0);
  });

  it("serializes with concurrent run preparation: every caller gets a matching pair", async () => {
    const agent = await newAgent();
    const svc = agentIdentityService(db);
    const original = await svc.ensureAgentIdentity(companyId, agent.id);
    const otherDb = createDb(database.connectionString);
    const results = await Promise.all([
      ...Array.from({ length: 6 }, (_, i) => agentIdentityService(i % 2 ? otherDb : db).ensureAgentIdentity(companyId, agent.id)),
      agentIdentityService(otherDb).rotateAgentIdentity(companyId, agent.id, board),
      ...Array.from({ length: 6 }, (_, i) => agentIdentityService(i % 2 ? db : otherDb).ensureAgentIdentity(companyId, agent.id)),
    ]);
    const rotated = results[6] as Awaited<ReturnType<typeof svc.rotateAgentIdentity>>;
    for (const pair of [...results.slice(0, 6), ...results.slice(7)] as Awaited<ReturnType<typeof svc.ensureAgentIdentity>>[]) {
      expect([original.keyId, rotated.keyId]).toContain(pair.keyId);
      const derived = createPublicKey(createPrivateKey(pair.privateKeyPem)).export({ type: "spki", format: "der" });
      expect(derived.equals(spki(pair.publicKeyPem))).toBe(true);
    }
    expect((await svc.ensureAgentIdentity(companyId, agent.id)).keyId).toBe(rotated.keyId);
  });

  describe("POST /api/agents/:id/identity/rotate", () => {
    function app(actor: Record<string, unknown>) {
      const server = express();
      server.use(express.json());
      server.use((req, _res, next) => { req.actor = actor as typeof req.actor; next(); });
      server.use("/api", agentRoutes(db));
      server.use(errorHandler);
      return server;
    }
    const sessionBoard = (userId: string, role: string) => ({
      type: "board", userId, source: "session", companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole: role }],
    });

    it("lets an agent-managing board user rotate and returns public fields only", async () => {
      const agent = await newAgent();
      const original = await agentIdentityService(db).ensureAgentIdentity(companyId, agent.id);
      const local = await request(app({ type: "board", userId: "local-board", source: "local_implicit" }))
        .post(`/api/agents/${agent.id}/identity/rotate`);
      expect(local.status).toBe(200);
      expect(Object.keys(local.body).sort()).toEqual(["algorithm", "createdAt", "keyId", "publicKeyPem"]);
      expect(local.body.keyId).not.toBe(original.keyId);
      expect(local.text).not.toContain("PRIVATE KEY");
      expect(local.text).not.toContain(original.privateKeyPem.split("\n")[1]);

      await db.insert(companyMemberships).values({
        companyId, principalType: "user", principalId: "rotation-owner", status: "active", membershipRole: "owner",
      });
      await db.insert(principalPermissionGrants).values({
        companyId, principalType: "user", principalId: "rotation-owner", permissionKey: "agents:create",
      });
      const owner = await request(app(sessionBoard("rotation-owner", "owner"))).post(`/api/agents/${agent.id}/identity/rotate`);
      expect(owner.status, owner.text).toBe(200);
      expect(owner.body.keyId).not.toBe(local.body.keyId);
      expect(owner.text).not.toContain("PRIVATE KEY");
      const [latest] = await db.select().from(activityLog).where(and(
        eq(activityLog.entityId, agent.id), eq(activityLog.action, "agent.identity.rotated"), eq(activityLog.actorId, "rotation-owner"),
      ));
      expect(latest.details).toEqual({ algorithm: "Ed25519", previousKeyId: local.body.keyId, keyId: owner.body.keyId });
      expect((await request(app(sessionBoard("rotation-owner", "owner"))).post(`/api/agents/${randomUUID()}/identity/rotate`)).status).toBe(404);
    });

    it("refuses agent tokens, including the agent's own, and board users without agent management", async () => {
      const agent = await newAgent();
      const peer = await newAgent();
      const original = await agentIdentityService(db).ensureAgentIdentity(companyId, agent.id);
      for (const actor of [
        { type: "agent", agentId: agent.id, companyId, source: "agent_jwt" },
        { type: "agent", agentId: agent.id, companyId, source: "agent_key" },
        { type: "agent", agentId: peer.id, companyId, source: "agent_jwt" },
      ]) {
        const response = await request(app(actor)).post(`/api/agents/${agent.id}/identity/rotate`);
        expect(response.status).toBe(403);
        expect(response.text).not.toContain("PRIVATE KEY");
      }

      // Company members without the agent-management grant are forbidden.
      for (const role of ["viewer", "member"]) {
        const userId = `rotation-${role}`;
        await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: role });
        const denied = await request(app(sessionBoard(userId, role))).post(`/api/agents/${agent.id}/identity/rotate`);
        expect(denied.status, denied.text).toBe(403);
        if (role === "member") expect(denied.body.error).toContain("agents:create");
      }

      // A board user outside the company gets the same not-found answer as the
      // other agent-management routes, so agent ids are not disclosed.
      const outsider = { type: "board", userId: "rotation-outsider", source: "session", companyIds: [otherCompanyId],
        memberships: [{ companyId: otherCompanyId, status: "active", membershipRole: "owner" }] };
      const outside = await request(app(outsider)).post(`/api/agents/${agent.id}/identity/rotate`);
      expect(outside.status).toBe(404);

      expect((await agentIdentityService(db).getPublicIdentity(companyId, agent.id))?.keyId).toBe(original.keyId);
      expect(await db.select().from(activityLog).where(and(
        eq(activityLog.entityId, agent.id), eq(activityLog.action, "agent.identity.rotated"),
      ))).toHaveLength(0);
    });
  });
});
