import { and, eq, inArray, isNull } from "drizzle-orm";
import { companies, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import {
  closeRecoveryActionsForTerminalSourceIssue,
  survivesTerminalSourceIssue,
} from "../issue-recovery-actions.js";
import {
  canRecoveryOwnerReadIssue,
  classifyRecoveryOwnerRoute,
  COORDINATOR_ROUTED_RECOVERY_KINDS,
  isCoordinatorRoutedRecoveryAction,
  readRecoveryOwnerRouting,
  RECOVERY_COORDINATOR_NO_ACCESS_REASON,
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
  /** Open actions (any owner) whose source issue is already done or cancelled. */
  terminalSourceActionIds: string[];
  /** Of those, the ones closed (outside a dry run). */
  closedActionIds: string[];
  /** Open coordinator-routed actions whose owner cannot read the source issue. */
  noAccessActionIds: string[];
  /** Of those, the ones re-routed to the readable assignee or the board. */
  reroutedActionIds: string[];
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
    sourceIssueId: row.sourceIssueId,
    sourceAgentId: row.returnOwnerAgentId ?? row.previousOwnerAgentId ?? null,
    now,
  });
}

function isOpen(row: RecoveryActionRow) {
  return row.status === "active" || row.status === "escalated";
}

async function sourceIssueStatus(db: DbOrTransaction, row: RecoveryActionRow) {
  return db
    .select({ status: issues.status })
    .from(issues)
    .where(and(eq(issues.id, row.sourceIssueId), eq(issues.companyId, row.companyId)))
    .then((rows) => rows[0]?.status ?? null);
}

function isTerminalStatus(status: string | null) {
  return status === "done" || status === "cancelled";
}

/** True when the row is coordinator-routed to an owner that cannot read its source issue. */
async function isUnreadableRoutedOwner(db: DbOrTransaction, row: RecoveryActionRow) {
  if (!isCoordinatorRoutedRecoveryAction(row) || !row.ownerAgentId) return false;
  return !(await canRecoveryOwnerReadIssue(db, {
    companyId: row.companyId,
    agentId: row.ownerAgentId,
    issueId: row.sourceIssueId,
  }));
}

/**
 * Move currently active, board-owned recovery actions of the routine
 * (allowlisted) kinds to the company's recovery coordinator agent.
 *
 * Before that, two repairs run on open actions: an action whose source issue
 * is already done or cancelled is closed (as the terminal transition now
 * does), and a coordinator-routed action whose owner cannot read its source
 * issue is re-routed through the resolver (readable assignee, otherwise the
 * board with `coordinator_no_access`). Board moves skip terminal sources.
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
      terminalSourceActionIds: [],
      closedActionIds: [],
      noAccessActionIds: [],
      reroutedActionIds: [],
    };
    results.push(result);

    // 1. Open actions on terminal source issues: close them, whoever owns them.
    // 2. Open coordinator-routed actions the owner cannot read: re-route them.
    const openRows = await db
      .select({ action: issueRecoveryActions, sourceStatus: issues.status })
      .from(issueRecoveryActions)
      .innerJoin(issues, and(
        eq(issues.id, issueRecoveryActions.sourceIssueId),
        eq(issues.companyId, issueRecoveryActions.companyId),
      ))
      .where(and(
        eq(issueRecoveryActions.companyId, company.id),
        inArray(issueRecoveryActions.status, ["active", "escalated"]),
      ));
    const terminalSourceIds = new Set<string>();
    for (const { action, sourceStatus } of openRows) {
      if (isTerminalStatus(sourceStatus)) {
        if (survivesTerminalSourceIssue(action)) continue;
        terminalSourceIds.add(action.id);
        result.terminalSourceActionIds.push(action.id);
      } else if (await isUnreadableRoutedOwner(db, action)) {
        result.noAccessActionIds.push(action.id);
      }
    }

    const routineIds: string[] = [];
    for (const row of activeBoardRows) {
      if (terminalSourceIds.has(row.id)) continue;
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

    for (const actionId of result.terminalSourceActionIds) {
      const closed = await db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(issueRecoveryActions)
          .where(and(eq(issueRecoveryActions.id, actionId), eq(issueRecoveryActions.companyId, company.id)))
          .for("update");
        if (!current || !isOpen(current)) return false;
        const status = await sourceIssueStatus(tx, current);
        if (!isTerminalStatus(status) || survivesTerminalSourceIssue(current)) return false;
        const rows = await closeRecoveryActionsForTerminalSourceIssue(tx, {
          companyId: current.companyId,
          sourceIssueId: current.sourceIssueId,
          sourceStatus: status!,
          actionId: current.id,
          now,
        });
        return rows.length > 0;
      });
      if (closed) result.closedActionIds.push(actionId);
    }

    for (const actionId of result.noAccessActionIds) {
      const rerouted = await db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(issueRecoveryActions)
          .where(and(eq(issueRecoveryActions.id, actionId), eq(issueRecoveryActions.companyId, company.id)))
          .for("update");
        if (!current || !isOpen(current) || !(await isUnreadableRoutedOwner(tx, current))) return false;
        if (isTerminalStatus(await sourceIssueStatus(tx, current))) return false;
        const resolved = await resolveForRow(tx, current, now);
        const toAgent = resolved.ownerType === "agent" && resolved.routing?.coordinator === "assigned";
        if (toAgent && resolved.ownerAgentId === current.ownerAgentId) return false;
        const routing: RecoveryOwnerRoutingEvidence = toAgent
          ? { ...resolved.routing!, backfilledAt: now.toISOString() } as RecoveryOwnerRoutingEvidence
          : {
            coordinator: "unavailable",
            reason: resolved.routing?.coordinator === "unavailable"
              ? resolved.routing.reason
              : RECOVERY_COORDINATOR_NO_ACCESS_REASON,
            routedAt: now.toISOString(),
            previousCoordinatorAgentId: current.ownerAgentId ?? undefined,
            ...(resolved.routing?.coordinator === "unavailable" && resolved.routing.coordinatorAgentId
              ? { coordinatorAgentId: resolved.routing.coordinatorAgentId }
              : {}),
          };
        const [updated] = await tx
          .update(issueRecoveryActions)
          .set({
            ownerType: toAgent ? "agent" : "board",
            ownerAgentId: toAgent ? resolved.ownerAgentId : null,
            ownerUserId: null,
            evidence: { ...(current.evidence ?? {}), [RECOVERY_OWNER_ROUTING_EVIDENCE_KEY]: routing },
            updatedAt: now,
          })
          .where(and(
            eq(issueRecoveryActions.id, current.id),
            eq(issueRecoveryActions.ownerType, "agent"),
            eq(issueRecoveryActions.ownerAgentId, current.ownerAgentId!),
          ))
          .returning({ id: issueRecoveryActions.id });
        return Boolean(updated);
      });
      if (rerouted) result.reroutedActionIds.push(actionId);
    }

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
