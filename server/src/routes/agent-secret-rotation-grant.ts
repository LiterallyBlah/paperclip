// Fork feature (BLA-4364): board-only administration of one agent's exact
// `secrets:rotate_bound` grant. The generic member-permissions routes replace
// every grant of a principal at once, and `PATCH /agents/:id/permissions`
// only manages `tasks:assign`, so neither can set or remove this one grant
// exactly. These routes read, insert and delete only the single
// `secrets:rotate_bound` row of one agent, and never any other permission key
// or principal. They never read or return secret values.
import { Router, type Request } from "express";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import {
  agents,
  companySecretBindings,
  companySecrets,
  principalPermissionGrants,
  type Db,
} from "@paperclipai/db";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { accessService } from "../services/access.js";
import { authorizationDeniedDetails, parseBoundSecretRotationScope } from "../services/authorization.js";
import { logActivity } from "../services/index.js";
import { assertBoard, assertCompanyAccess, hasCompanyAccess } from "./authz.js";

const PERMISSION_KEY = "secrets:rotate_bound" as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const secretRotationGrantBodySchema = z
  .object({
    secretId: z.string().regex(UUID_PATTERN),
    bindingId: z.string().regex(UUID_PATTERN),
  })
  .strict();

type GrantRow = typeof principalPermissionGrants.$inferSelect;

function grantView(row: GrantRow) {
  const parsed = parseBoundSecretRotationScope(row.scope);
  return {
    id: row.id,
    permissionKey: row.permissionKey,
    scope: parsed ?? row.scope ?? null,
    scopeValid: parsed !== null,
    grantedByUserId: row.grantedByUserId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function sameIds(a: { secretId: string; bindingId: string }, b: { secretId: string; bindingId: string }) {
  // Exact match, as `decideBoundSecretRotation` compares. Request ids are
  // normalised to lower case, which is how Postgres returns UUIDs.
  return a.secretId === b.secretId && a.bindingId === b.bindingId;
}

export function agentSecretRotationGrantRoutes(db: Db) {
  const router = Router();
  const access = accessService(db);

  // Board user only: every agent actor (CEO included) and any board actor
  // without a user id are rejected before any lookup.
  function requireBoardUser(req: Request): string {
    assertBoard(req);
    const userId = req.actor.type === "board" ? req.actor.userId?.trim() : undefined;
    if (!userId) throw forbidden("Board user required");
    return userId;
  }

  function parseBody(body: unknown) {
    const parsed = secretRotationGrantBodySchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw unprocessable("Body must contain only secretId and bindingId as UUIDs");
    }
    return { secretId: parsed.data.secretId.toLowerCase(), bindingId: parsed.data.bindingId.toLowerCase() };
  }

  // Same company access and permission level as the board agent-management
  // routes (`assertBoardCanManageAgentsForCompany` in agents.ts).
  async function loadManagedAgent(req: Request) {
    const agentId = String(req.params.id ?? "");
    if (!UUID_PATTERN.test(agentId)) throw notFound("Agent not found");
    const agent = await db
      .select({ id: agents.id, companyId: agents.companyId, status: agents.status })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    if (!agent || !hasCompanyAccess(req, agent.companyId)) throw notFound("Agent not found");
    assertCompanyAccess(req, agent.companyId);
    const decision = await access.decide({
      actor: req.actor,
      action: "agents:create",
      resource: { type: "company", companyId: agent.companyId },
    });
    if (!decision.allowed) throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
    return agent;
  }

  async function findRotateGrant(companyId: string, agentId: string) {
    return db
      .select()
      .from(principalPermissionGrants)
      .where(and(
        eq(principalPermissionGrants.companyId, companyId),
        eq(principalPermissionGrants.principalType, "agent"),
        eq(principalPermissionGrants.principalId, agentId),
        eq(principalPermissionGrants.permissionKey, PERMISSION_KEY),
      ))
      .then((rows) => rows[0] ?? null);
  }

  router.get("/agents/:id/secret-rotation-grant", async (req, res) => {
    res.set("Cache-Control", "no-store");
    requireBoardUser(req);
    const agent = await loadManagedAgent(req);
    const grant = await findRotateGrant(agent.companyId, agent.id);
    res.json({ grant: grant ? grantView(grant) : null });
  });

  router.put("/agents/:id/secret-rotation-grant", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const userId = requireBoardUser(req);
    const agent = await loadManagedAgent(req);
    const ids = parseBody(req.body);
    if (agent.status === "terminated") throw conflict("Agent is terminated");

    // The secret must be an active, company-scoped record of the agent's
    // company: the same predicate the agent access list uses.
    const secret = await db
      .select({ id: companySecrets.id })
      .from(companySecrets)
      .where(and(
        eq(companySecrets.id, ids.secretId),
        eq(companySecrets.companyId, agent.companyId),
        eq(companySecrets.scope, "company"),
        eq(companySecrets.status, "active"),
        isNull(companySecrets.deletedAt),
      ))
      .then((rows) => rows[0] ?? null);
    if (!secret) throw unprocessable("Secret is not an active company secret of this agent's company");

    // Direct agent binding only: the same predicate as the rotate route.
    const binding = await db
      .select({ id: companySecretBindings.id })
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.id, ids.bindingId),
        eq(companySecretBindings.companyId, agent.companyId),
        eq(companySecretBindings.secretId, ids.secretId),
        eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, agent.id),
      ))
      .then((rows) => rows[0] ?? null);
    if (!binding) throw unprocessable("Binding is not a direct binding of this secret to this agent");

    // Membership: create an active member row when none exists, leave an
    // active one (and its role) untouched, and never reactivate a pending or
    // suspended membership.
    const membership = await access.getMembership(agent.companyId, "agent", agent.id);
    if (!membership) {
      await access.ensureMembership(agent.companyId, "agent", agent.id, "member", "active");
    } else if (membership.status !== "active") {
      throw conflict("Agent membership is not active");
    }

    // Insert only. The unique index allows one rotate grant per agent, so a
    // concurrent or earlier row is never overwritten.
    const inserted = await db
      .insert(principalPermissionGrants)
      .values({
        companyId: agent.companyId,
        principalType: "agent",
        principalId: agent.id,
        permissionKey: PERMISSION_KEY,
        scope: { secretId: ids.secretId, bindingId: ids.bindingId },
        grantedByUserId: userId,
      })
      .onConflictDoNothing()
      .returning()
      .then((rows) => rows[0] ?? null);

    if (inserted) {
      await logActivity(db, {
        companyId: agent.companyId,
        actorType: "user",
        actorId: userId,
        action: "agent.secret_rotation_grant_created",
        entityType: "agent",
        entityId: agent.id,
        details: { agentId: agent.id, grantId: inserted.id, secretId: ids.secretId, bindingId: ids.bindingId },
      });
      res.status(201).json({ created: true, grant: grantView(inserted) });
      return;
    }

    const existing = await findRotateGrant(agent.companyId, agent.id);
    if (!existing) throw conflict("Grant changed concurrently; retry");
    const existingScope = parseBoundSecretRotationScope(existing.scope);
    if (existingScope && existing.grantedByUserId && sameIds(existingScope, ids)) {
      res.json({ created: false, grant: grantView(existing) });
      return;
    }
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: userId,
      action: "agent.secret_rotation_grant_conflict",
      entityType: "agent",
      entityId: agent.id,
      details: {
        agentId: agent.id,
        grantId: existing.id,
        secretId: ids.secretId,
        bindingId: ids.bindingId,
        existingSecretId: existingScope?.secretId ?? null,
        existingBindingId: existingScope?.bindingId ?? null,
      },
    });
    throw conflict("Agent already has a different secrets:rotate_bound grant", {
      grantId: existing.id,
      scopeValid: existingScope !== null,
      secretId: existingScope?.secretId ?? null,
      bindingId: existingScope?.bindingId ?? null,
      boardGranted: Boolean(existing.grantedByUserId),
    });
  });

  router.delete("/agents/:id/secret-rotation-grant", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const userId = requireBoardUser(req);
    const agent = await loadManagedAgent(req);
    const ids = parseBody(req.body);
    const existing = await findRotateGrant(agent.companyId, agent.id);
    if (!existing) throw notFound("No secrets:rotate_bound grant for this agent");
    const existingScope = parseBoundSecretRotationScope(existing.scope);
    if (!existingScope || !sameIds(existingScope, ids)) {
      throw conflict("Grant scope does not match the request", {
        grantId: existing.id,
        scopeValid: existingScope !== null,
        secretId: existingScope?.secretId ?? null,
        bindingId: existingScope?.bindingId ?? null,
      });
    }
    const removed = await db
      .delete(principalPermissionGrants)
      .where(and(
        eq(principalPermissionGrants.id, existing.id),
        eq(principalPermissionGrants.companyId, agent.companyId),
        eq(principalPermissionGrants.principalType, "agent"),
        eq(principalPermissionGrants.principalId, agent.id),
        eq(principalPermissionGrants.permissionKey, PERMISSION_KEY),
      ))
      .returning({ id: principalPermissionGrants.id })
      .then((rows) => rows[0] ?? null);
    if (!removed) throw notFound("No secrets:rotate_bound grant for this agent");
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: userId,
      action: "agent.secret_rotation_grant_removed",
      entityType: "agent",
      entityId: agent.id,
      details: { agentId: agent.id, grantId: removed.id, secretId: ids.secretId, bindingId: ids.bindingId },
    });
    res.json({ removed: true, grantId: removed.id });
  });

  return router;
}
