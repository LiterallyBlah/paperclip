import { and, eq, isNull, ne } from "drizzle-orm";
import { agents, companies, issues, type Db } from "@paperclipai/db";
import type {
  IssueRecoveryActionKind,
  IssueRecoveryActionOwnerType,
} from "@paperclipai/shared";

import { authorizationService } from "../authorization.js";

type DbOrTransaction = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Routine recovery routing.
 *
 * Routine, agent-resolvable recovery (lost processes, watchdog and native
 * finalization failures, legacy execution reconciliation, missing
 * dispositions and their bounded-retry exhaustion) is owned by the company's
 * recovery coordinator agent instead of the board. Anything touching spend,
 * credentials, sign-in, provider refusal, destructive work, publishing or an
 * explicit human approval stays with the board. Provider quota waits stay
 * system-owned. Kinds that are not on the allowlist keep their behaviour.
 *
 * Every creation and escalation site that would otherwise write a board owner
 * goes through {@link resolveRecoveryOwner}; do not add per-site routing.
 */

export const RECOVERY_OWNER_ROUTING_EVIDENCE_KEY = "recoveryOwnerRouting";
export const RECOVERY_COORDINATOR_WAKE_REASON = "recovery_action_owner_assigned";
/** Minimum gap before a finished coordinator wake is repeated for the same action. */
export const RECOVERY_COORDINATOR_REWAKE_MS = 60 * 60 * 1000;
/** Routing reason recorded when the coordinator cannot read the source issue. */
export const RECOVERY_COORDINATOR_NO_ACCESS_REASON = "coordinator_no_access";

/** Recovery action kinds whose board-owned actions route to the coordinator. */
export const COORDINATOR_ROUTED_RECOVERY_KINDS: ReadonlySet<IssueRecoveryActionKind> = new Set<IssueRecoveryActionKind>([
  "active_run_watchdog",
  "stranded_assigned_issue",
  "missing_disposition",
  // Bounded original-owner disposition repair and its exhaustion.
  "deliberate_wait_without_target",
]);

/**
 * Causes that are always reserved for the board (or system), whatever the
 * kind. Matched on whole underscore-delimited words of the cause.
 */
const RESERVED_CAUSE_WORDS = [
  "budget",
  "spend",
  "cost",
  "billing",
  "payment",
  "credential",
  "credentials",
  "secret",
  "secrets",
  "auth",
  "unauthorized",
  "oauth",
  "login",
  "signin",
  "reauthorization",
  "token",
  "refusal",
  "refused",
  "quota",
  "delete",
  "deletion",
  "destroy",
  "destructive",
  "publish",
  "publishing",
  "approval",
] as const;
const RESERVED_CAUSE_PHRASES = [
  "sign_in",
  "auth_required",
  "provider_refusal",
  "human_approval",
  // Missing secrets, an unavailable AI connection or an unready provider
  // plugin: the fix is a credential or sign-in step, so the board keeps it.
  "configuration_incomplete",
] as const;

export type RecoveryOwnerRouteClass = "routine" | "reserved" | "unlisted";

export function classifyRecoveryOwnerRoute(input: {
  kind: IssueRecoveryActionKind | string;
  cause: string;
}): RecoveryOwnerRouteClass {
  const cause = input.cause.toLowerCase();
  const words = new Set(cause.split(/[^a-z0-9]+/).filter(Boolean));
  if (
    RESERVED_CAUSE_WORDS.some((word) => words.has(word)) ||
    RESERVED_CAUSE_PHRASES.some((phrase) => cause.includes(phrase))
  ) {
    return "reserved";
  }
  return COORDINATOR_ROUTED_RECOVERY_KINDS.has(input.kind as IssueRecoveryActionKind) ? "routine" : "unlisted";
}

const AVAILABLE_COORDINATOR_STATUSES = new Set(["active", "idle", "running", "error"]);

export function isAvailableRecoveryCoordinatorStatus(status: string) {
  return AVAILABLE_COORDINATOR_STATUSES.has(status);
}

export type RecoveryCoordinatorResolution =
  | { status: "available"; agentId: string; source: "configured" | "root_ceo" }
  | { status: "unavailable"; reason: string };

export async function resolveRecoveryCoordinator(
  db: DbOrTransaction,
  companyId: string,
): Promise<RecoveryCoordinatorResolution> {
  const company = await db
    .select({ recoveryCoordinatorAgentId: companies.recoveryCoordinatorAgentId })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);
  if (!company) return { status: "unavailable", reason: "company_not_found" };

  const configuredId = company.recoveryCoordinatorAgentId;
  if (configuredId) {
    const agent = await db
      .select({ id: agents.id, status: agents.status })
      .from(agents)
      .where(and(eq(agents.id, configuredId), eq(agents.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!agent) return { status: "unavailable", reason: "configured_coordinator_not_found" };
    if (!AVAILABLE_COORDINATOR_STATUSES.has(agent.status)) {
      return { status: "unavailable", reason: `configured_coordinator_${agent.status}` };
    }
    return { status: "available", agentId: agent.id, source: "configured" };
  }

  const roots = await db
    .select({ id: agents.id, status: agents.status })
    .from(agents)
    .where(and(
      eq(agents.companyId, companyId),
      eq(agents.role, "ceo"),
      isNull(agents.reportsTo),
      ne(agents.status, "terminated"),
    ));
  if (roots.length === 0) return { status: "unavailable", reason: "coordinator_not_configured" };
  if (roots.length > 1) return { status: "unavailable", reason: "root_ceo_ambiguous" };
  const [root] = roots;
  if (!AVAILABLE_COORDINATOR_STATUSES.has(root!.status)) {
    return { status: "unavailable", reason: `root_ceo_${root!.status}` };
  }
  return { status: "available", agentId: root!.id, source: "root_ceo" };
}

export type RecoveryOwnerRoutingEvidence =
  | {
    coordinator: "assigned";
    agentId: string;
    /**
     * `source_assignee`: the coordinator cannot read the source issue, so the
     * source issue's own assignee (who can) owns the recovery instead.
     */
    source: "configured" | "root_ceo" | "source_assignee";
    routedAt: string;
    /** Set with `source_assignee`: why the coordinator was passed over. */
    reason?: typeof RECOVERY_COORDINATOR_NO_ACCESS_REASON;
    /** Set with `source_assignee`: the coordinator that cannot read the issue. */
    coordinatorAgentId?: string;
    backfilledAt?: string;
    wakeQueuedAt?: string;
    wakeRunId?: string | null;
  }
  | {
    coordinator: "unavailable";
    reason: string;
    routedAt: string;
    /** Set when an already routed action went back to the board. */
    previousCoordinatorAgentId?: string;
    /** Set with `coordinator_no_access`: the coordinator that cannot read the issue. */
    coordinatorAgentId?: string;
  };

/**
 * Keep the coordinator wake history when the same action is re-routed to the
 * same coordinator (an ordinary refresh or escalation). Without this the
 * hourly re-wake throttle would be reset by every refresh.
 */
export function carryRecoveryCoordinatorDelivery(
  previousEvidence: Record<string, unknown> | null | undefined,
  routing: RecoveryOwnerRoutingEvidence,
): RecoveryOwnerRoutingEvidence {
  if (routing.coordinator !== "assigned") return routing;
  const previous = readRecoveryOwnerRouting(previousEvidence);
  if (
    previous?.coordinator !== "assigned" ||
    previous.agentId !== routing.agentId ||
    previous.source !== routing.source
  ) return routing;
  return {
    ...routing,
    routedAt: previous.routedAt ?? routing.routedAt,
    ...(previous.backfilledAt ? { backfilledAt: previous.backfilledAt } : {}),
    ...(previous.wakeQueuedAt ? { wakeQueuedAt: previous.wakeQueuedAt } : {}),
    ...(previous.wakeRunId !== undefined ? { wakeRunId: previous.wakeRunId } : {}),
  };
}

export type ResolvedRecoveryOwner = {
  ownerType: IssueRecoveryActionOwnerType;
  ownerAgentId: string | null;
  ownerUserId: string | null;
  /** Present only when coordinator routing applied (assigned or unavailable). */
  routing: RecoveryOwnerRoutingEvidence | null;
};

/**
 * Decide who owns a recovery action whose site would otherwise write the
 * `requestedOwnerType`. Only a board owner for an allowlisted, non-reserved
 * kind is changed. Everything else is returned as requested.
 */
export async function resolveRecoveryOwner(
  db: DbOrTransaction,
  input: {
    companyId: string;
    kind: IssueRecoveryActionKind | string;
    cause: string;
    requestedOwnerType: IssueRecoveryActionOwnerType;
    requestedOwnerAgentId?: string | null;
    requestedOwnerUserId?: string | null;
    /**
     * The action's source issue. A coordinator (or assignee fallback) that
     * cannot read it is never made the owner. Every caller passes it; `null`
     * only for synthetic classification checks.
     */
    sourceIssueId: string | null;
    /**
     * The source work's own agent. When a person paused that agent, the
     * pause is a human decision and the board keeps the action.
     */
    sourceAgentId?: string | null;
    now?: Date;
  },
): Promise<ResolvedRecoveryOwner> {
  const unchanged: ResolvedRecoveryOwner = {
    ownerType: input.requestedOwnerType,
    ownerAgentId: input.requestedOwnerAgentId ?? null,
    ownerUserId: input.requestedOwnerUserId ?? null,
    routing: null,
  };
  if (input.requestedOwnerType !== "board") return unchanged;
  if (classifyRecoveryOwnerRoute(input) !== "routine") return unchanged;
  if (input.sourceAgentId && (await isPausedAgent(db, input.companyId, input.sourceAgentId))) {
    return unchanged;
  }
  const routedAt = (input.now ?? new Date()).toISOString();
  const coordinator = await resolveRecoveryCoordinator(db, input.companyId);
  if (coordinator.status === "unavailable") {
    return {
      ownerType: "board",
      ownerAgentId: null,
      ownerUserId: null,
      routing: { coordinator: "unavailable", reason: coordinator.reason, routedAt },
    };
  }
  if (
    input.sourceIssueId &&
    !(await canRecoveryOwnerReadIssue(db, {
      companyId: input.companyId,
      agentId: coordinator.agentId,
      issueId: input.sourceIssueId,
    }))
  ) {
    const assigneeAgentId = await readableInvokableSourceAssignee(db, input.companyId, input.sourceIssueId);
    if (assigneeAgentId) {
      return {
        ownerType: "agent",
        ownerAgentId: assigneeAgentId,
        ownerUserId: null,
        routing: {
          coordinator: "assigned",
          agentId: assigneeAgentId,
          source: "source_assignee",
          reason: RECOVERY_COORDINATOR_NO_ACCESS_REASON,
          coordinatorAgentId: coordinator.agentId,
          routedAt,
        },
      };
    }
    return {
      ownerType: "board",
      ownerAgentId: null,
      ownerUserId: null,
      routing: {
        coordinator: "unavailable",
        reason: RECOVERY_COORDINATOR_NO_ACCESS_REASON,
        coordinatorAgentId: coordinator.agentId,
        routedAt,
      },
    };
  }
  return {
    ownerType: "agent",
    ownerAgentId: coordinator.agentId,
    ownerUserId: null,
    routing: { coordinator: "assigned", agentId: coordinator.agentId, source: coordinator.source, routedAt },
  };
}

/**
 * The existing `issue:read` access decision for an agent acting on the
 * source issue, the same decision the woken run meets when it reads the
 * task. The actor is built the way a run builds it: on behalf of the
 * issue's responsible user. A missing issue is unreadable.
 */
export async function canRecoveryOwnerReadIssue(
  db: DbOrTransaction,
  input: { companyId: string; agentId: string; issueId: string },
): Promise<boolean> {
  const issue = await db
    .select({ id: issues.id, responsibleUserId: issues.responsibleUserId })
    .from(issues)
    .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
    .then((rows) => rows[0] ?? null);
  if (!issue) return false;
  const responsibleUserId = issue.responsibleUserId && issue.responsibleUserId !== "local-board"
    ? issue.responsibleUserId
    : null;
  const decision = await authorizationService(db).decide({
    actor: {
      type: "agent",
      agentId: input.agentId,
      companyId: input.companyId,
      source: "agent_jwt",
      onBehalfOfUserId: responsibleUserId,
    },
    action: "issue:read",
    resource: { type: "issue", companyId: input.companyId, issueId: issue.id },
  });
  return decision.allowed;
}

/**
 * The source issue's assignee agent when it can take the recovery: same
 * company, invokable (not paused, terminated or pending) and able to read
 * the issue. Otherwise null.
 */
async function readableInvokableSourceAssignee(
  db: DbOrTransaction,
  companyId: string,
  sourceIssueId: string,
): Promise<string | null> {
  const row = await db
    .select({ agentId: agents.id, status: agents.status })
    .from(issues)
    .innerJoin(agents, and(eq(agents.id, issues.assigneeAgentId), eq(agents.companyId, issues.companyId)))
    .where(and(eq(issues.id, sourceIssueId), eq(issues.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!row || !AVAILABLE_COORDINATOR_STATUSES.has(row.status)) return null;
  return (await canRecoveryOwnerReadIssue(db, { companyId, agentId: row.agentId, issueId: sourceIssueId }))
    ? row.agentId
    : null;
}

async function isPausedAgent(db: DbOrTransaction, companyId: string, agentId: string) {
  const agent = await db
    .select({ status: agents.status })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  return agent?.status === "paused";
}

export function readRecoveryOwnerRouting(
  evidence: Record<string, unknown> | null | undefined,
): RecoveryOwnerRoutingEvidence | null {
  const value = evidence?.[RECOVERY_OWNER_ROUTING_EVIDENCE_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const routing = value as Record<string, unknown>;
  if (routing.coordinator === "assigned" && typeof routing.agentId === "string") {
    return routing as RecoveryOwnerRoutingEvidence;
  }
  if (routing.coordinator === "unavailable" && typeof routing.reason === "string") {
    return routing as RecoveryOwnerRoutingEvidence;
  }
  return null;
}

/** True when the action is owned by the coordinator through this routing. */
export function isCoordinatorRoutedRecoveryAction(action: {
  ownerType: string;
  ownerAgentId: string | null;
  evidence: Record<string, unknown> | null | undefined;
}) {
  const routing = readRecoveryOwnerRouting(action.evidence);
  return (
    action.ownerType === "agent" &&
    routing?.coordinator === "assigned" &&
    routing.agentId === action.ownerAgentId
  );
}

/**
 * True when the action was routed to a coordinator that has since been
 * deleted: `owner_agent_id` is `ON DELETE SET NULL`, so the row keeps
 * `ownerType: "agent"` and its assigned routing evidence but has no owner
 * agent. Reconciliation must return it to the board.
 */
export function isOrphanedCoordinatorRoutedRecoveryAction(action: {
  ownerType: string;
  ownerAgentId: string | null;
  evidence: Record<string, unknown> | null | undefined;
}) {
  const routing = readRecoveryOwnerRouting(action.evidence);
  return action.ownerType === "agent" && action.ownerAgentId === null && routing?.coordinator === "assigned";
}

/**
 * True for an action held for an operator decision: board-owned, or owned by
 * the recovery coordinator through routing. Automatic repair flows that act
 * only on operator-held actions use this instead of `ownerType === "board"`,
 * so routing changes the owner and nothing else.
 */
export function isOperatorHeldRecoveryAction(action: {
  ownerType: string;
  ownerAgentId: string | null;
  evidence: Record<string, unknown> | null | undefined;
}) {
  return action.ownerType === "board" || isCoordinatorRoutedRecoveryAction(action);
}

/** SQL twin of {@link isOperatorHeldRecoveryAction} for raw-SQL predicates. */
export function operatorHeldRecoveryActionSql(alias: string) {
  return `((${alias}.owner_type = 'board' AND ${alias}.owner_agent_id IS NULL)
    OR (${alias}.owner_type = 'agent'
      AND ${alias}.evidence->'${RECOVERY_OWNER_ROUTING_EVIDENCE_KEY}'->>'coordinator' = 'assigned'
      AND ${alias}.evidence->'${RECOVERY_OWNER_ROUTING_EVIDENCE_KEY}'->>'agentId' = ${alias}.owner_agent_id::text))`;
}
