import { and, eq, inArray, isNull } from "drizzle-orm";
import { companies, issueRecoveryActions, type Db } from "@paperclipai/db";
import {
  classifyRecoveryOwnerRoute,
  COORDINATOR_ROUTED_RECOVERY_KINDS,
  readRecoveryOwnerRouting,
  RECOVERY_OWNER_ROUTING_EVIDENCE_KEY,
  resolveRecoveryCoordinator,
  resolveRecoveryOwner,
  type RecoveryOwnerRoutingEvidence,
} from "./recovery-owner-routing.js";

type RecoveryActionRow = typeof issueRecoveryActions.$inferSelect;
type DbOrTransaction = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export type RecoveryOwnerBackfillCompanyResult = {
  companyId: string;
  coordinator: { status: "available"; agentId: string } | { status: "unavailable"; reason: string };
  /** Active board-owned actions the shared resolver would give to the coordinator. */
  candidateActionIds: string[];
  /** Allowlisted-kind board actions kept on the board because the cause is reserved. */
  reservedActionIds: string[];
  /** Routine board actions kept on the board because a person paused the source agent. */
  heldActionIds: string[];
  movedActionIds: string[];
};

export type RecoveryOwnerBackfillResult = {
  dryRun: boolean;
  companies: RecoveryOwnerBackfillCompanyResult[];
};

function isActiveBoardOwned(row: RecoveryActionRow) {
  return (
    ["active", "escalated"].includes(row.status) &&
    row.ownerType === "board" &&
    !row.ownerAgentId &&
    !row.ownerUserId
  );
}

/** The same resolver call every creation and escalation site makes. */
function resolveForRow(db: DbOrTransaction, row: RecoveryActionRow, now: Date) {
  return resolveRecoveryOwner(db, {
    companyId: row.companyId,
    kind: row.kind,
    cause: row.cause,
    requestedOwnerType: "board",
    sourceAgentId: row.returnOwnerAgentId ?? row.previousOwnerAgentId ?? null,
    now,
  });
}

/**
 * Move currently active, board-owned recovery actions of the routine
 * (allowlisted) kinds to the company's recovery coordinator agent.
 *
 * Every row goes through the shared {@link resolveRecoveryOwner}, with its own
 * source owner, kind and cause, both when listing candidates and again on the
 * locked row before it is changed. Reserved causes and paused source agents
 * keep the board. Idempotent: only rows still owned by the board with no
 * agent or user owner are touched. Only the owner and routing evidence
 * change; status, counters, return/previous owners, wake and monitor
 * policies are left as they are. With `dryRun` it reports and writes
 * nothing. When no coordinator is available, routine rows stay with the
 * board and (outside a dry run) record `coordinator: "unavailable"`.
 */
export async function backfillRecoveryCoordinatorOwners(
  db: Db,
  input: { companyId?: string | null; dryRun: boolean; now?: Date },
): Promise<RecoveryOwnerBackfillResult> {
  const now = input.now ?? new Date();
  const companyRows = input.companyId
    ? await db.select({ id: companies.id }).from(companies).where(eq(companies.id, input.companyId))
    : await db.select({ id: companies.id }).from(companies);
  const results: RecoveryOwnerBackfillCompanyResult[] = [];
  for (const company of companyRows) {
    const activeBoardRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(and(
        eq(issueRecoveryActions.companyId, company.id),
        inArray(issueRecoveryActions.status, ["active", "escalated"]),
        eq(issueRecoveryActions.ownerType, "board"),
        isNull(issueRecoveryActions.ownerAgentId),
        isNull(issueRecoveryActions.ownerUserId),
        inArray(issueRecoveryActions.kind, [...COORDINATOR_ROUTED_RECOVERY_KINDS]),
      ));
    const coordinator = await resolveRecoveryCoordinator(db, company.id);
    const result: RecoveryOwnerBackfillCompanyResult = {
      companyId: company.id,
      coordinator: coordinator.status === "available"
        ? { status: "available", agentId: coordinator.agentId }
        : { status: "unavailable", reason: coordinator.reason },
      candidateActionIds: [],
      reservedActionIds: [],
      heldActionIds: [],
      movedActionIds: [],
    };
    results.push(result);
    const routineIds: string[] = [];
    for (const row of activeBoardRows) {
      if (classifyRecoveryOwnerRoute(row) !== "routine") {
        result.reservedActionIds.push(row.id);
        continue;
      }
      const resolved = await resolveForRow(db, row, now);
      if (!resolved.routing) {
        // The resolver kept the board without routing: the source agent is paused.
        result.heldActionIds.push(row.id);
        continue;
      }
      routineIds.push(row.id);
      if (resolved.ownerType === "agent") result.candidateActionIds.push(row.id);
    }
    if (input.dryRun) continue;

    for (const actionId of routineIds) {
      const moved = await db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(issueRecoveryActions)
          .where(and(eq(issueRecoveryActions.id, actionId), eq(issueRecoveryActions.companyId, company.id)))
          .for("update");
        if (!current || !isActiveBoardOwned(current)) return false;
        // Re-evaluate the locked row: its cause or source agent may have
        // changed since it was listed.
        const resolved = await resolveForRow(tx, current, now);
        if (!resolved.routing) return false;
        let routing: RecoveryOwnerRoutingEvidence = resolved.routing;
        if (routing.coordinator === "assigned") {
          routing = { ...routing, backfilledAt: now.toISOString() };
        } else {
          const existing = readRecoveryOwnerRouting(current.evidence);
          if (existing?.coordinator === "unavailable" && existing.reason === routing.reason) return false;
        }
        const assigned = resolved.ownerType === "agent";
        const [updated] = await tx
          .update(issueRecoveryActions)
          .set({
            ownerType: resolved.ownerType,
            ownerAgentId: resolved.ownerAgentId,
            ownerUserId: resolved.ownerUserId,
            evidence: { ...(current.evidence ?? {}), [RECOVERY_OWNER_ROUTING_EVIDENCE_KEY]: routing },
            updatedAt: now,
          })
          .where(and(
            eq(issueRecoveryActions.id, current.id),
            eq(issueRecoveryActions.ownerType, "board"),
            isNull(issueRecoveryActions.ownerAgentId),
            isNull(issueRecoveryActions.ownerUserId),
          ))
          .returning({ id: issueRecoveryActions.id });
        return Boolean(updated) && assigned;
      });
      if (moved) result.movedActionIds.push(actionId);
    }
  }
  return { dryRun: input.dryRun, companies: results };
}
