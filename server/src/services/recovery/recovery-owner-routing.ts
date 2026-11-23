import { and, eq, isNull, ne } from "drizzle-orm";
import { agents, companies, type Db } from "@paperclipai/db";
import type {
  IssueRecoveryActionKind,
  IssueRecoveryActionOwnerType,
} from "@paperclipai/shared";

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
const RESERVED_CAUSE_PHRASES = ["sign_in", "auth_required", "provider_refusal", "human_approval"] as const;

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
  | { coordinator: "assigned"; agentId: string; source: "configured" | "root_ceo"; routedAt: string }
  | { coordinator: "unavailable"; reason: string; routedAt: string };

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
  return {
    ownerType: "agent",
    ownerAgentId: coordinator.agentId,
    ownerUserId: null,
    routing: { coordinator: "assigned", agentId: coordinator.agentId, source: coordinator.source, routedAt },
  };
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
