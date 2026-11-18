import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies } from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";

/**
 * The company's decision-triage delegate (BLA-1616): one agent that may take
 * the routing decisions of decision-triage gaps G1, G2, G3a, G4 and G7 instead
 * of the board. It is a separate setting from the BLA-501 review escalation
 * delegate and grants nothing on its own until a board actor sets it.
 *
 * It is stored in the existing company-scoped `interaction_resolver_governance`
 * JSON settings under this key, so no schema migration is needed. Only the
 * dedicated board route writes it; the generic company PATCH preserves the
 * stored value (see `preserveDecisionTriageDelegate`).
 */
export const DECISION_TRIAGE_DELEGATE_KEY = "decisionTriageDelegateAgentId";

/** Agent statuses that cannot act as the delegate. Everything else is active. */
const INELIGIBLE_DELEGATE_AGENT_STATUSES = new Set(["terminated", "pending_approval", "paused"]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isEligibleDecisionTriageDelegateStatus(status: string | null | undefined): boolean {
  return typeof status === "string" && !INELIGIBLE_DELEGATE_AGENT_STATUSES.has(status);
}

/** The stored delegate agent id, or null when unset or malformed. */
export function readDecisionTriageDelegateAgentId(governance: unknown): string | null {
  if (!isRecord(governance)) return null;
  const value = governance[DECISION_TRIAGE_DELEGATE_KEY];
  return typeof value === "string" && UUID_PATTERN.test(value) ? value : null;
}

/**
 * The generic company PATCH must not set, change or clear the delegate: the
 * incoming governance object's delegate key is dropped and the stored value
 * (if any) is carried over unchanged.
 */
export function withoutDecisionTriageDelegate(governance: unknown): unknown {
  if (!isRecord(governance) || !(DECISION_TRIAGE_DELEGATE_KEY in governance)) return governance;
  const { [DECISION_TRIAGE_DELEGATE_KEY]: _dropped, ...rest } = governance;
  return rest;
}

export function preserveDecisionTriageDelegate<T extends Record<string, unknown>>(
  incoming: T,
  stored: unknown,
): T {
  const base = withoutDecisionTriageDelegate(incoming) as T;
  const storedValue = isRecord(stored) ? stored[DECISION_TRIAGE_DELEGATE_KEY] : undefined;
  return storedValue === undefined ? base : ({ ...base, [DECISION_TRIAGE_DELEGATE_KEY]: storedValue } as T);
}

type DelegateDb = Pick<Db, "select">;

/**
 * The delegate an execution-policy transition should use for `companyId`: the
 * configured agent when it still exists in the same company with an eligible
 * status, otherwise null (the default escalation behaviour).
 */
export async function resolveDecisionTriageDelegateAgentId(
  db: DelegateDb,
  companyId: string,
): Promise<string | null> {
  const company = await db
    .select({ governance: companies.interactionResolverGovernance })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);
  const agentId = readDecisionTriageDelegateAgentId(company?.governance);
  if (!agentId) return null;
  const agent = await db
    .select({ id: agents.id, companyId: agents.companyId, status: agents.status })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!agent || agent.id !== agentId || agent.companyId !== companyId) return null;
  return isEligibleDecisionTriageDelegateStatus(agent.status) ? agent.id : null;
}

/**
 * Set (agent id) or clear (null) the company's delegate. The agent must be an
 * active agent of the same company. The caller authorises the actor.
 */
export async function setDecisionTriageDelegate(
  db: Db,
  companyId: string,
  agentId: string | null,
): Promise<{ previousAgentId: string | null; agentId: string | null }> {
  return db.transaction(async (tx) => {
    const company = await tx
      .select({ id: companies.id, governance: companies.interactionResolverGovernance })
      .from(companies)
      .where(eq(companies.id, companyId))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!company) throw notFound("Company not found");
    if (agentId !== null) {
      const agent = await tx
        .select({ id: agents.id, companyId: agents.companyId, status: agents.status })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!agent) {
        throw unprocessable("The decision-triage delegate must be an agent of this company", {
          code: "decision_triage_delegate_invalid",
        });
      }
      if (!isEligibleDecisionTriageDelegateStatus(agent.status)) {
        throw unprocessable("The decision-triage delegate must be an active agent", {
          code: "decision_triage_delegate_inactive",
        });
      }
    }
    const stored: Record<string, unknown> = isRecord(company.governance) ? { ...company.governance } : {};
    const previousAgentId = readDecisionTriageDelegateAgentId(stored);
    const { [DECISION_TRIAGE_DELEGATE_KEY]: _previous, ...rest } = stored;
    const next = agentId === null ? rest : { ...rest, [DECISION_TRIAGE_DELEGATE_KEY]: agentId };
    await tx
      .update(companies)
      .set({ interactionResolverGovernance: next as typeof companies.$inferInsert.interactionResolverGovernance, updatedAt: new Date() })
      .where(eq(companies.id, companyId));
    return { previousAgentId, agentId };
  });
}

/**
 * How `agentId` stands against the company's configured decision-triage
 * delegate: `"none"` when no delegate is set or it is another agent (the
 * caller keeps today's behaviour), `"active"` when it is the delegate and the
 * agent is an active agent of `companyId`, and `"inactive"` when it is the
 * configured delegate but paused, terminated, pending approval or no longer in
 * the company (the caller refuses the delegate path).
 */
export async function decisionTriageDelegateStanding(
  db: DelegateDb,
  companyId: string,
  agentId: string,
): Promise<"none" | "active" | "inactive"> {
  const company = await db
    .select({ governance: companies.interactionResolverGovernance })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);
  const configured = readDecisionTriageDelegateAgentId(company?.governance);
  if (!configured || configured !== agentId) return "none";
  const agent = await db
    .select({ id: agents.id, companyId: agents.companyId, status: agents.status })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!agent || agent.companyId !== companyId) return "inactive";
  return isEligibleDecisionTriageDelegateStatus(agent.status) ? "active" : "inactive";
}
