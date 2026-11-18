import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies } from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";

/**
 * The company's review escalation delegate: one agent that receives review
 * stages whose agent reviewers exhausted `maxReviewRounds`, instead of a human.
 *
 * It is stored in the existing company-scoped `interaction_resolver_governance`
 * JSON settings under this key, so no schema migration is needed. Only the
 * dedicated board route writes it; the generic company PATCH preserves the
 * stored value (see `preserveReviewEscalationDelegate`).
 */
export const REVIEW_ESCALATION_DELEGATE_KEY = "reviewEscalationDelegateAgentId";

/** Agent statuses that cannot act as the delegate. Everything else is active. */
const INELIGIBLE_DELEGATE_AGENT_STATUSES = new Set(["terminated", "pending_approval", "paused"]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isEligibleReviewEscalationDelegateStatus(status: string | null | undefined): boolean {
  return typeof status === "string" && !INELIGIBLE_DELEGATE_AGENT_STATUSES.has(status);
}

/** The stored delegate agent id, or null when unset or malformed. */
export function readReviewEscalationDelegateAgentId(governance: unknown): string | null {
  if (!isRecord(governance)) return null;
  const value = governance[REVIEW_ESCALATION_DELEGATE_KEY];
  return typeof value === "string" && UUID_PATTERN.test(value) ? value : null;
}

/**
 * The generic company PATCH must not set, change or clear the delegate: the
 * incoming governance object's delegate key is dropped and the stored value
 * (if any) is carried over unchanged.
 */
export function withoutReviewEscalationDelegate(governance: unknown): unknown {
  if (!isRecord(governance) || !(REVIEW_ESCALATION_DELEGATE_KEY in governance)) return governance;
  const { [REVIEW_ESCALATION_DELEGATE_KEY]: _dropped, ...rest } = governance;
  return rest;
}

export function preserveReviewEscalationDelegate<T extends Record<string, unknown>>(
  incoming: T,
  stored: unknown,
): T {
  const base = withoutReviewEscalationDelegate(incoming) as T;
  const storedValue = isRecord(stored) ? stored[REVIEW_ESCALATION_DELEGATE_KEY] : undefined;
  return storedValue === undefined ? base : ({ ...base, [REVIEW_ESCALATION_DELEGATE_KEY]: storedValue } as T);
}

type DelegateDb = Pick<Db, "select">;

/**
 * The delegate an execution-policy transition should use for `companyId`: the
 * configured agent when it still exists in the same company with an eligible
 * status, otherwise null (the default escalation behaviour).
 */
export async function resolveReviewEscalationDelegateAgentId(
  db: DelegateDb,
  companyId: string,
): Promise<string | null> {
  const company = await db
    .select({ governance: companies.interactionResolverGovernance })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);
  const agentId = readReviewEscalationDelegateAgentId(company?.governance);
  if (!agentId) return null;
  const agent = await db
    .select({ id: agents.id, companyId: agents.companyId, status: agents.status })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!agent || agent.id !== agentId || agent.companyId !== companyId) return null;
  return isEligibleReviewEscalationDelegateStatus(agent.status) ? agent.id : null;
}

/**
 * Set (agent id) or clear (null) the company's delegate. The agent must be an
 * active agent of the same company. The caller authorises the actor.
 */
export async function setReviewEscalationDelegate(
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
        throw unprocessable("The review escalation delegate must be an agent of this company", {
          code: "review_escalation_delegate_invalid",
        });
      }
      if (!isEligibleReviewEscalationDelegateStatus(agent.status)) {
        throw unprocessable("The review escalation delegate must be an active agent", {
          code: "review_escalation_delegate_inactive",
        });
      }
    }
    const stored: Record<string, unknown> = isRecord(company.governance) ? { ...company.governance } : {};
    const previousAgentId = readReviewEscalationDelegateAgentId(stored);
    const { [REVIEW_ESCALATION_DELEGATE_KEY]: _previous, ...rest } = stored;
    const next = agentId === null ? rest : { ...rest, [REVIEW_ESCALATION_DELEGATE_KEY]: agentId };
    await tx
      .update(companies)
      .set({ interactionResolverGovernance: next as typeof companies.$inferInsert.interactionResolverGovernance, updatedAt: new Date() })
      .where(eq(companies.id, companyId));
    return { previousAgentId, agentId };
  });
}
