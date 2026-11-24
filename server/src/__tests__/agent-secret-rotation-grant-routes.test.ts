import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
  principalPermissionGrants,
  projects,
  secretAccessEvents,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { accessRoutes } from "../routes/access.js";
import { agentSecretRotationGrantRoutes } from "../routes/agent-secret-rotation-grant.js";
import { accessService } from "../services/access.js";
import { authorizationService } from "../services/authorization.js";
import { secretService } from "../services/secrets.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// Disposable dummy values only. None of them is a real credential.
const FIXTURE_VALUE = "fixture-grant-admin-secret-value";
const BOARD_USER_ID = "fixture-grant-board-user";
const GRANT_PATH = (agentId: string) => `/api/agents/${agentId}/secret-rotation-grant`;

describeEmbeddedPostgres("agent secret-rotation grant administration routes", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-rotation-grant-admin-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("agent-secret-rotation-grant");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(secretAccessEvents);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(projects);
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
      name: "Grant admin fixture",
      issuePrefix: `G${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name: string, role = "engineer") {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role,
      adapterType: "codex_local",
      adapterConfig: {},
      permissions: {},
      status: "idle",
    });
    await accessService(db).ensureMembership(companyId, "agent", agentId, "member", "active");
    return { companyId, agentId };
  }

  type AgentFixture = Awaited<ReturnType<typeof seedAgent>>;

  async function createBoundSecret(fixture: AgentFixture, key: string) {
    const svc = secretService(db);
    const secret = await svc.create(fixture.companyId, {
      key,
      name: `${key} name`,
      description: "Grant admin fixture",
      provider: "local_encrypted",
      value: FIXTURE_VALUE,
    });
    const binding = await svc.createBinding({
      companyId: fixture.companyId,
      secretId: secret.id,
      targetType: "agent",
      targetId: fixture.agentId,
      configPath: `access.${key}`,
    });
    return { secretId: secret.id, bindingId: binding.id };
  }

  function appWith(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", agentSecretRotationGrantRoutes(db));
    app.use(errorHandler);
    return app;
  }

  function boardApp(companyIds: string[], overrides: Record<string, unknown> = {}) {
    return appWith({
      type: "board",
      userId: BOARD_USER_ID,
      companyIds,
      isInstanceAdmin: true,
      source: "session",
      ...overrides,
    } as Express.Request["actor"]);
  }

  function agentApp(fixture: AgentFixture) {
    return appWith({
      type: "agent",
      agentId: fixture.agentId,
      companyId: fixture.companyId,
      runId: randomUUID(),
      keyScope: { kind: "standard" },
      source: "agent_jwt",
    } as Express.Request["actor"]);
  }

  async function grantRows(agentId: string) {
    return db.select().from(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, agentId));
  }

  async function rotateGrant(fixture: AgentFixture) {
    const [row] = await db.select().from(principalPermissionGrants).where(and(
      eq(principalPermissionGrants.principalId, fixture.agentId),
      eq(principalPermissionGrants.permissionKey, "secrets:rotate_bound"),
    ));
    return row ?? null;
  }

  async function decision(fixture: AgentFixture, ids: { secretId: string; bindingId: string }) {
    return authorizationService(db).decideBoundSecretRotation({
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      ...ids,
    });
  }

  function expectNoValue(...bodies: unknown[]) {
    for (const body of bodies) expect(JSON.stringify(body)).not.toContain(FIXTURE_VALUE);
  }

  it("creates, reads back, repeats idempotently and authorises exactly that binding", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId, "Rotator");
    const target = await createBoundSecret(agent, "GRANT_TARGET");
    const other = await createBoundSecret(agent, "GRANT_OTHER");
    const app = boardApp([companyId]);

    const before = await request(app).get(GRANT_PATH(agent.agentId));
    expect(before.status).toBe(200);
    expect(before.body).toEqual({ grant: null });

    const created = await request(app).put(GRANT_PATH(agent.agentId)).send(target);
    expect(created.status).toBe(201);
    expect(created.body.created).toBe(true);
    expect(created.headers["cache-control"]).toBe("no-store");

    const read = await request(app).get(GRANT_PATH(agent.agentId));
    expect(read.status).toBe(200);
    expect(read.body.grant).toMatchObject({
      id: created.body.grant.id,
      permissionKey: "secrets:rotate_bound",
      scope: target,
      scopeValid: true,
      grantedByUserId: BOARD_USER_ID,
    });

    const row = await rotateGrant(agent);
    expect(row?.scope).toEqual(target);
    expect(row?.grantedByUserId).toBe(BOARD_USER_ID);

    const repeat = await request(app).put(GRANT_PATH(agent.agentId)).send(target);
    expect(repeat.status).toBe(200);
    expect(repeat.body).toMatchObject({ created: false, grant: { id: created.body.grant.id } });
    expect(await grantRows(agent.agentId)).toHaveLength(1);

    expect((await decision(agent, target)).allowed).toBe(true);
    expect((await decision(agent, other)).allowed).toBe(false);
    expect((await decision(agent, { secretId: target.secretId, bindingId: other.bindingId })).allowed).toBe(false);

    const activity = await db.select().from(activityLog).where(eq(activityLog.action, "agent.secret_rotation_grant_created"));
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ actorType: "user", actorId: BOARD_USER_ID, entityId: agent.agentId });
    expect(activity[0].details).toEqual({
      agentId: agent.agentId,
      grantId: created.body.grant.id,
      secretId: target.secretId,
      bindingId: target.bindingId,
    });

    expectNoValue(before.body, created.body, read.body, repeat.body, activity);
  });

  it("keeps the agent's existing membership role when granting", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId, "Owner-role agent");
    await accessService(db).ensureMembership(companyId, "agent", agent.agentId, "owner", "active");
    const target = await createBoundSecret(agent, "ROLE_TARGET");
    const res = await request(boardApp([companyId])).put(GRANT_PATH(agent.agentId)).send(target);
    expect(res.status).toBe(201);
    const membership = await accessService(db).getMembership(companyId, "agent", agent.agentId);
    expect(membership?.membershipRole).toBe("owner");
    expect(membership?.status).toBe("active");
  });

  it("creates an active membership when none exists and refuses a suspended one", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId, "No membership");
    const target = await createBoundSecret(agent, "MEMBER_TARGET");
    await db.delete(companyMemberships).where(eq(companyMemberships.principalId, agent.agentId));
    const created = await request(boardApp([companyId])).put(GRANT_PATH(agent.agentId)).send(target);
    expect(created.status).toBe(201);
    expect((await accessService(db).getMembership(companyId, "agent", agent.agentId))?.status).toBe("active");

    const suspended = await seedAgent(companyId, "Suspended");
    const suspendedTarget = await createBoundSecret(suspended, "SUSPENDED_TARGET");
    await accessService(db).ensureMembership(companyId, "agent", suspended.agentId, "member", "suspended");
    const refused = await request(boardApp([companyId])).put(GRANT_PATH(suspended.agentId)).send(suspendedTarget);
    expect(refused.status).toBe(409);
    expect(await rotateGrant(suspended)).toBeNull();
    expect((await accessService(db).getMembership(companyId, "agent", suspended.agentId))?.status).toBe("suspended");
  });

  it("returns 409 for an existing different, unparsable or non-board grant and never overwrites it", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId, "Conflicted");
    const first = await createBoundSecret(agent, "FIRST");
    const second = await createBoundSecret(agent, "SECOND");
    const app = boardApp([companyId]);

    const created = await request(app).put(GRANT_PATH(agent.agentId)).send(first);
    expect(created.status).toBe(201);
    const original = await rotateGrant(agent);

    const conflictRes = await request(app).put(GRANT_PATH(agent.agentId)).send(second);
    expect(conflictRes.status).toBe(409);
    expect(conflictRes.body.details).toEqual({
      grantId: original!.id,
      scopeValid: true,
      secretId: first.secretId,
      bindingId: first.bindingId,
      boardGranted: true,
    });
    const after = await rotateGrant(agent);
    expect(after).toEqual(original);

    // Unparsable stored scope.
    await db.update(principalPermissionGrants)
      .set({ scope: { secretId: first.secretId } })
      .where(eq(principalPermissionGrants.id, original!.id));
    const unparsable = await request(app).put(GRANT_PATH(agent.agentId)).send(first);
    expect(unparsable.status).toBe(409);
    expect(unparsable.body.details).toMatchObject({ scopeValid: false, secretId: null, bindingId: null });
    const read = await request(app).get(GRANT_PATH(agent.agentId));
    expect(read.body.grant).toMatchObject({ scope: { secretId: first.secretId }, scopeValid: false });

    // Same scope but recorded without a board grantor.
    await db.update(principalPermissionGrants)
      .set({ scope: first, grantedByUserId: null })
      .where(eq(principalPermissionGrants.id, original!.id));
    const noGrantor = await request(app).put(GRANT_PATH(agent.agentId)).send(first);
    expect(noGrantor.status).toBe(409);
    expect(noGrantor.body.details).toMatchObject({ boardGranted: false });
    expect((await rotateGrant(agent))?.grantedByUserId).toBeNull();

    expectNoValue(conflictRes.body, unparsable.body, noGrantor.body, read.body);
  });

  it("leaves unrelated grants of the same agent and of other agents intact on create and delete", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId, "Target agent");
    const peer = await seedAgent(companyId, "Peer agent");
    const target = await createBoundSecret(agent, "KEEP_TARGET");
    const peerTarget = await createBoundSecret(peer, "PEER_TARGET");
    const access = accessService(db);
    await access.setPrincipalPermission(companyId, "agent", agent.agentId, "tasks:assign", true, BOARD_USER_ID);
    await access.setPrincipalPermission(companyId, "agent", peer.agentId, "tasks:assign", true, BOARD_USER_ID);
    await access.setPrincipalPermission(
      companyId, "agent", peer.agentId, "secrets:rotate_bound", true, BOARD_USER_ID, peerTarget,
    );
    const peerBefore = await grantRows(peer.agentId);
    const app = boardApp([companyId]);

    expect((await request(app).put(GRANT_PATH(agent.agentId)).send(target)).status).toBe(201);
    let keys = (await grantRows(agent.agentId)).map((row) => row.permissionKey).sort();
    expect(keys).toEqual(["secrets:rotate_bound", "tasks:assign"]);
    expect(await grantRows(peer.agentId)).toEqual(peerBefore);

    const removed = await request(app).delete(GRANT_PATH(agent.agentId)).send(target);
    expect(removed.status).toBe(200);
    keys = (await grantRows(agent.agentId)).map((row) => row.permissionKey);
    expect(keys).toEqual(["tasks:assign"]);
    expect(await grantRows(peer.agentId)).toEqual(peerBefore);
  });

  it("deletes only an exact match, then reads null and denies rotation", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId, "Delete agent");
    const target = await createBoundSecret(agent, "DELETE_TARGET");
    const other = await createBoundSecret(agent, "DELETE_OTHER");
    const app = boardApp([companyId]);

    const none = await request(app).delete(GRANT_PATH(agent.agentId)).send(target);
    expect(none.status).toBe(404);

    const created = await request(app).put(GRANT_PATH(agent.agentId)).send(target);
    expect(created.status).toBe(201);
    const grantId = created.body.grant.id;

    const wrong = await request(app).delete(GRANT_PATH(agent.agentId)).send(other);
    expect(wrong.status).toBe(409);
    expect(wrong.body.details).toMatchObject({ grantId, secretId: target.secretId, bindingId: target.bindingId });
    expect((await rotateGrant(agent))?.id).toBe(grantId);

    const mixed = await request(app).delete(GRANT_PATH(agent.agentId))
      .send({ secretId: target.secretId, bindingId: other.bindingId });
    expect(mixed.status).toBe(409);
    expect((await rotateGrant(agent))?.id).toBe(grantId);

    const removed = await request(app).delete(GRANT_PATH(agent.agentId)).send(target);
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ removed: true, grantId });

    const read = await request(app).get(GRANT_PATH(agent.agentId));
    expect(read.body).toEqual({ grant: null });
    const denied = await decision(agent, target);
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe("deny_missing_grant");

    const activity = await db.select().from(activityLog).where(eq(activityLog.action, "agent.secret_rotation_grant_removed"));
    expect(activity).toHaveLength(1);
    expect(activity[0].details).toEqual({ agentId: agent.agentId, grantId, ...target });

    const again = await request(app).delete(GRANT_PATH(agent.agentId)).send(target);
    expect(again.status).toBe(404);
    expectNoValue(none.body, wrong.body, mixed.body, removed.body, read.body, again.body, activity);
  });

  it("rejects every agent actor, including the CEO and the agent itself, for GET, PUT and DELETE", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId, "Self");
    const ceo = await seedAgent(companyId, "Chief", "ceo");
    const target = await createBoundSecret(agent, "AGENT_ACTOR_TARGET");
    const ceoTarget = await createBoundSecret(ceo, "CEO_SELF_TARGET");

    const cases: Array<[AgentFixture, AgentFixture, { secretId: string; bindingId: string }]> = [
      [agent, agent, target],
      [ceo, agent, target],
      [ceo, ceo, ceoTarget],
    ];
    for (const [actor, subject, ids] of cases) {
      const app = agentApp(actor);
      const get = await request(app).get(GRANT_PATH(subject.agentId));
      const put = await request(app).put(GRANT_PATH(subject.agentId)).send(ids);
      const del = await request(app).delete(GRANT_PATH(subject.agentId)).send(ids);
      expect([get.status, put.status, del.status]).toEqual([403, 403, 403]);
      expectNoValue(get.body, put.body, del.body);
    }
    expect(await rotateGrant(agent)).toBeNull();
    expect(await rotateGrant(ceo)).toBeNull();

    // An agent cannot delete a board grant either.
    expect((await request(boardApp([companyId])).put(GRANT_PATH(agent.agentId)).send(target)).status).toBe(201);
    expect((await request(agentApp(ceo)).delete(GRANT_PATH(agent.agentId)).send(target)).status).toBe(403);
    expect(await rotateGrant(agent)).not.toBeNull();
  });

  it("rejects a board actor without a user id, without company access, or without agent-management permission", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const agent = await seedAgent(companyId, "Guarded");
    const target = await createBoundSecret(agent, "BOARD_GUARD_TARGET");

    const noUser = boardApp([companyId], { userId: undefined });
    expect((await request(noUser).get(GRANT_PATH(agent.agentId))).status).toBe(403);
    expect((await request(noUser).put(GRANT_PATH(agent.agentId)).send(target)).status).toBe(403);
    expect((await request(noUser).delete(GRANT_PATH(agent.agentId)).send(target)).status).toBe(403);

    const outsider = boardApp([otherCompanyId], { isInstanceAdmin: false });
    expect((await request(outsider).get(GRANT_PATH(agent.agentId))).status).toBe(404);
    expect((await request(outsider).put(GRANT_PATH(agent.agentId)).send(target)).status).toBe(404);
    expect((await request(outsider).delete(GRANT_PATH(agent.agentId)).send(target)).status).toBe(404);

    // A plain company member user lacks the agent-management permission.
    const memberUserId = "fixture-plain-member-user";
    await accessService(db).ensureMembership(companyId, "user", memberUserId, "member", "active");
    const member = boardApp([companyId], {
      userId: memberUserId,
      isInstanceAdmin: false,
      memberships: [{ companyId, membershipRole: "member", status: "active" }],
    });
    expect((await request(member).get(GRANT_PATH(agent.agentId))).status).toBe(403);
    expect((await request(member).put(GRANT_PATH(agent.agentId)).send(target)).status).toBe(403);
    expect(await rotateGrant(agent)).toBeNull();
  });

  it("rejects cross-company, mismatched, non-direct and unknown-key requests without writing", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const agent = await seedAgent(companyId, "Strict");
    const peer = await seedAgent(companyId, "Strict peer");
    const foreign = await seedAgent(otherCompanyId, "Foreign");
    const target = await createBoundSecret(agent, "STRICT_TARGET");
    const second = await createBoundSecret(agent, "STRICT_SECOND");
    const peerOwned = await createBoundSecret(peer, "STRICT_PEER");
    const foreignOwned = await createBoundSecret(foreign, "STRICT_FOREIGN");
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Strict project" });
    const projectBinding = await secretService(db).createBinding({
      companyId,
      secretId: target.secretId,
      targetType: "project",
      targetId: projectId,
      configPath: "env.STRICT_TARGET",
    });
    const peerBindingOfTarget = await secretService(db).createBinding({
      companyId,
      secretId: target.secretId,
      targetType: "agent",
      targetId: peer.agentId,
      configPath: "access.STRICT_TARGET_PEER",
    });

    const app = boardApp([companyId]);
    const attempts: Array<[string, unknown, number]> = [
      ["foreign secret and binding", foreignOwned, 422],
      ["foreign binding", { secretId: target.secretId, bindingId: foreignOwned.bindingId }, 422],
      ["binding of another agent", { secretId: peerOwned.secretId, bindingId: peerOwned.bindingId }, 422],
      ["same secret bound to another agent", { secretId: target.secretId, bindingId: peerBindingOfTarget.id }, 422],
      ["project binding", { secretId: target.secretId, bindingId: projectBinding.id }, 422],
      ["binding/secret mismatch", { secretId: second.secretId, bindingId: target.bindingId }, 422],
      ["unknown key", { ...target, projectId }, 422],
      ["missing binding", { secretId: target.secretId }, 422],
      ["non-uuid", { secretId: "not-a-uuid", bindingId: target.bindingId }, 422],
      ["array", [target], 422],
    ];
    for (const [name, body, status] of attempts) {
      const res = await request(app).put(GRANT_PATH(agent.agentId)).send(body as object);
      expect(res.status, name).toBe(status);
      expectNoValue(res.body);
    }

    // Cross-company agent: visible only to boards of its own company.
    const crossAgent = await request(app).put(GRANT_PATH(foreign.agentId)).send(foreignOwned);
    expect(crossAgent.status).toBe(404);

    // Unknown keys on DELETE are rejected too, and nothing is deleted.
    expect((await request(app).put(GRANT_PATH(agent.agentId)).send(target)).status).toBe(201);
    const delUnknown = await request(app).delete(GRANT_PATH(agent.agentId)).send({ ...target, extra: true });
    expect(delUnknown.status).toBe(422);
    expect(await rotateGrant(agent)).not.toBeNull();

    // Only the one valid grant was ever written.
    expect(await db.select().from(principalPermissionGrants).where(eq(principalPermissionGrants.permissionKey, "secrets:rotate_bound"))).toHaveLength(1);
  });

  it("refuses a terminated agent and an inactive secret", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId, "Inactive cases");
    const target = await createBoundSecret(agent, "INACTIVE_TARGET");
    const app = boardApp([companyId]);

    await db.update(companySecrets).set({ status: "archived" }).where(eq(companySecrets.id, target.secretId));
    expect((await request(app).put(GRANT_PATH(agent.agentId)).send(target)).status).toBe(422);
    await db.update(companySecrets).set({ status: "active" }).where(eq(companySecrets.id, target.secretId));

    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, agent.agentId));
    expect((await request(app).put(GRANT_PATH(agent.agentId)).send(target)).status).toBe(409);
    expect(await rotateGrant(agent)).toBeNull();
  });
  it("leaves the generic member routes rejecting an agent member: 403 before any grant row changes", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId, "Member-route agent");
    const target = await createBoundSecret(agent, "MEMBER_ROUTE_TARGET");
    const access = accessService(db);
    // The board user holds users:manage_permissions explicitly (session actor, not local implicit).
    await access.ensureMembership(companyId, "user", BOARD_USER_ID, "owner", "active");
    await access.setPrincipalPermission(
      companyId, "user", BOARD_USER_ID, "users:manage_permissions", true, BOARD_USER_ID,
    );
    expect(await access.canUser(companyId, BOARD_USER_ID, "users:manage_permissions")).toBe(true);
    expect((await request(boardApp([companyId])).put(GRANT_PATH(agent.agentId)).send(target)).status).toBe(201);
    await access.setPrincipalPermission(companyId, "agent", agent.agentId, "tasks:assign", true, BOARD_USER_ID);
    const before = await grantRows(agent.agentId);
    expect(before.map((row) => row.permissionKey).sort()).toEqual(["secrets:rotate_bound", "tasks:assign"]);
    const membership = await access.getMembership(companyId, "agent", agent.agentId);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: BOARD_USER_ID,
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        isInstanceAdmin: false,
        source: "session",
      } as Express.Request["actor"];
      next();
    });
    app.use("/api", accessRoutes(db, {
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }));
    app.use(errorHandler);

    const patched = await request(app)
      .patch(`/api/companies/${companyId}/members/${membership!.id}/permissions`)
      .send({ grants: [] });
    expect(patched.status).toBe(403);
    expect(patched.body.error).toBe("Only human company members can be removed.");
    expect(await grantRows(agent.agentId)).toEqual(before);

    const roleAndGrants = await request(app)
      .patch(`/api/companies/${companyId}/members/${membership!.id}/role-and-grants`)
      .send({ status: "active", grants: [] });
    expect(roleAndGrants.status).toBe(403);
    expect(await grantRows(agent.agentId)).toEqual(before);
    expect(await access.getMembership(companyId, "agent", agent.agentId)).toEqual(membership);
    expectNoValue(patched.body, roleAndGrants.body);
  });
});
