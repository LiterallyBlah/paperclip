import { and, eq, inArray, isNull } from "drizzle-orm";
import { companies, issueRecoveryActions, type Db } from "@paperclipai/db";
import {
  classifyRecoveryOwnerRoute,
  COORDINATOR_ROUTED_RECOVERY_KINDS,
  RECOVERY_OWNER_ROUTING_EVIDENCE_KEY,
  resolveRecoveryCoordinator,
  type RecoveryOwnerRoutingEvidence,
} from "./recovery-owner-routing.js";

export type RecoveryOwnerBackfillCompanyResult = {
  companyId: string;
  coordinator: { status: "available"; agentId: string } | { status: "unavailable"; reason: string };
  /** Active board-owned actions of allowlisted kinds with a routine cause. */
  candidateActionIds: string[];
  /** Allowlisted-kind board actions kept on the board because the cause is reserved. */
  reservedActionIds: string[];
  movedActionIds: string[];
};

export type RecoveryOwnerBackfillResult = {
  dryRun: boolean;
  companies: RecoveryOwnerBackfillCompanyResult[];
};

/**
 * Move currently active, board-owned recovery actions of the routine
 * (allowlisted) kinds to the company's recovery coordinator agent.
 *
 * Idempotent: only rows still owned by the board with no agent or user owner
 * are touched, and each update re-checks that under the same predicate. Only
 * the owner and routing evidence change; status, counters, return/previous
 * owners, wake and monitor policies are left as they are. With `dryRun` it
 * reports what it would move and writes nothing. A company with no available
 * coordinator is reported and left unchanged.
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
      .select({
        id: issueRecoveryActions.id,
        kind: issueRecoveryActions.kind,
        cause: issueRecoveryActions.cause,
      })
      .from(issueRecoveryActions)
      .where(and(
        eq(issueRecoveryActions.companyId, company.id),
        inArray(issueRecoveryActions.status, ["active", "escalated"]),
        eq(issueRecoveryActions.ownerType, "board"),
        isNull(issueRecoveryActions.ownerAgentId),
        isNull(issueRecoveryActions.ownerUserId),
        inArray(issueRecoveryActions.kind, [...COORDINATOR_ROUTED_RECOVERY_KINDS]),
      ));
    const candidateActionIds: string[] = [];
    const reservedActionIds: string[] = [];
    for (const row of activeBoardRows) {
      if (classifyRecoveryOwnerRoute(row) === "routine") candidateActionIds.push(row.id);
      else reservedActionIds.push(row.id);
    }
    const coordinator = await resolveRecoveryCoordinator(db, company.id);
    const result: RecoveryOwnerBackfillCompanyResult = {
      companyId: company.id,
      coordinator: coordinator.status === "available"
        ? { status: "available", agentId: coordinator.agentId }
        : { status: "unavailable", reason: coordinator.reason },
      candidateActionIds,
      reservedActionIds,
      movedActionIds: [],
    };
    results.push(result);
    if (input.dryRun || coordinator.status !== "available") continue;

    for (const actionId of candidateActionIds) {
      const moved = await db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(issueRecoveryActions)
          .where(and(eq(issueRecoveryActions.id, actionId), eq(issueRecoveryActions.companyId, company.id)))
          .for("update");
        if (
          !current ||
          !["active", "escalated"].includes(current.status) ||
          current.ownerType !== "board" ||
          current.ownerAgentId ||
          current.ownerUserId
        ) {
          return false;
        }
        const routing: RecoveryOwnerRoutingEvidence = {
          coordinator: "assigned",
          agentId: coordinator.agentId,
          source: coordinator.source,
          routedAt: now.toISOString(),
          backfilledAt: now.toISOString(),
        };
        const [updated] = await tx
          .update(issueRecoveryActions)
          .set({
            ownerType: "agent",
            ownerAgentId: coordinator.agentId,
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
        return Boolean(updated);
      });
      if (moved) result.movedActionIds.push(actionId);
    }
  }
  return { dryRun: input.dryRun, companies: results };
}
