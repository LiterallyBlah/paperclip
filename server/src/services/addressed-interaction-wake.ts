import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issueThreadInteractions, issues } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { parseObject } from "../adapters/utils.js";
import { issueThreadInteractionAttentionAgentAllowed } from "./issue-thread-interaction-resolution.js";

/**
 * Context key set under the claim lock: this run was admitted as a non-owner to
 * answer that card. Preparation and the final dispatch gate read it, so the run
 * can never become an ordinary assignment.
 */
export const ADDRESSED_QUESTION_CONTEXT_KEY = "addressedQuestionInteractionId";

// The card kinds an addressee can answer. Admission and the prompt share this.
const ANSWER_ROUTES: Readonly<Record<string, readonly string[]>> = {
  ask_user_questions: ["respond"],
  request_confirmation: ["accept", "reject"],
  request_checkbox_confirmation: ["accept", "reject"],
  request_item_verdicts: ["verdicts"],
  suggest_tasks: ["accept", "reject"],
};
const MAX_RETRY_HOPS = 10;

function readId(value: unknown): string | null {
  return typeof value === "string" && isUuidLike(value) ? value : null;
}

/** A retry rewrites `wakeReason`, so walk the stored run chain back to the addressed wake. */
async function retryDescendsFromAddressedWake(
  db: Db,
  input: { companyId: string; agentId: string; interactionId: string; retryOfRunId: unknown },
): Promise<boolean> {
  let runId = readId(input.retryOfRunId);
  for (let hop = 0; runId && hop < MAX_RETRY_HOPS; hop += 1) {
    const origin = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot, retryOfRunId: heartbeatRuns.retryOfRunId })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.id, runId),
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!origin) return false;
    const context = parseObject(origin.contextSnapshot);
    if (context.interactionId !== input.interactionId) return false;
    if (context.wakeReason === "interaction_pending") return true;
    runId = readId(origin.retryOfRunId);
  }
  return false;
}

/**
 * The stored interaction that this wake asks `agentId` to answer, or null.
 *
 * A wake snapshot only names an interaction, so authority always comes from the
 * current row: pending, not dismissed, on this company and issue, addressed to
 * this agent, of an answerable kind, and with a resolver policy that admits it.
 */
export async function readAddressedInteractionForWake(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    agentId: string;
    contextSnapshot: Record<string, unknown>;
  },
): Promise<{ id: string; kind: string; issueAssigneeAgentId: string | null } | null> {
  const context = input.contextSnapshot;
  const interactionId = readId(context.interactionId);
  if (!interactionId) return null;
  const isAddressedWake =
    context.wakeReason === "interaction_pending" ||
    (context.source === "issue.interaction.created" &&
      (await retryDescendsFromAddressedWake(db, {
        companyId: input.companyId,
        agentId: input.agentId,
        interactionId,
        retryOfRunId: context.retryOfRunId,
      })));
  if (!isAddressedWake) return null;
  const row = await db
    .select({
      id: issueThreadInteractions.id,
      kind: issueThreadInteractions.kind,
      payload: issueThreadInteractions.payload,
      createdByAgentId: issueThreadInteractions.createdByAgentId,
      createdByUserId: issueThreadInteractions.createdByUserId,
      sourceRunId: issueThreadInteractions.sourceRunId,
      addresseeAgentId: issueThreadInteractions.addresseeAgentId,
      addresseeUserId: issueThreadInteractions.addresseeUserId,
      effectiveResolverPolicy: issueThreadInteractions.effectiveResolverPolicy,
      resolverPolicyProvenance: issueThreadInteractions.resolverPolicyProvenance,
      issueAssigneeAgentId: issues.assigneeAgentId,
    })
    .from(issueThreadInteractions)
    .innerJoin(issues, eq(issues.id, issueThreadInteractions.issueId))
    .where(
      and(
        eq(issueThreadInteractions.id, interactionId),
        eq(issueThreadInteractions.companyId, input.companyId),
        eq(issueThreadInteractions.issueId, input.issueId),
        eq(issueThreadInteractions.status, "pending"),
        isNull(issueThreadInteractions.dismissedAt),
        eq(issueThreadInteractions.addresseeAgentId, input.agentId),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row || !ANSWER_ROUTES[row.kind]) return null;
  const payload = parseObject(row.payload);
  const eligible = issueThreadInteractionAttentionAgentAllowed({
    agentId: input.agentId,
    interaction: row,
    governedAction:
      row.kind === "request_confirmation" &&
      (payload.toolAction !== undefined || payload.secretProposal !== undefined),
  });
  return eligible ? { id: row.id, kind: row.kind, issueAssigneeAgentId: row.issueAssigneeAgentId } : null;
}

/**
 * Wake-payload block for a run admitted to answer a card. It reads only the
 * admitted card's kind: authority is rechecked at the final dispatch gate, so a
 * card resolved during preparation stops the run rather than changing its prompt.
 */
export async function buildAddressedInteractionWake(
  db: Db,
  input: { companyId: string; issueId: string; contextSnapshot: Record<string, unknown> },
) {
  const interactionId = readId(input.contextSnapshot[ADDRESSED_QUESTION_CONTEXT_KEY]);
  if (!interactionId) return null;
  const interaction = await db
    .select({ kind: issueThreadInteractions.kind })
    .from(issueThreadInteractions)
    .where(and(
      eq(issueThreadInteractions.id, interactionId),
      eq(issueThreadInteractions.companyId, input.companyId),
      eq(issueThreadInteractions.issueId, input.issueId),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const routes = interaction ? ANSWER_ROUTES[interaction.kind] : undefined;
  if (!interaction || !routes) return null;
  const readPath = `/api/issues/${input.issueId}/interactions`;
  return {
    id: interactionId,
    kind: interaction.kind,
    readPath,
    answerPaths: routes.map((route) => `${readPath}/${interactionId}/${route}`),
  };
}
