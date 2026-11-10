import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueThreadInteractions, issues } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";

const ANSWER_ROUTES: Readonly<Record<string, readonly string[]>> = {
  ask_user_questions: ["respond"],
  request_confirmation: ["accept", "reject"],
  request_checkbox_confirmation: ["accept", "reject"],
  request_item_verdicts: ["verdicts"],
  suggest_tasks: ["accept", "reject"],
};

function readId(value: unknown): string | null {
  return typeof value === "string" && isUuidLike(value) ? value : null;
}

/**
 * The stored interaction that this wake asks `agentId` to answer, or null.
 *
 * A wake snapshot only names an interaction, so authority always comes from the
 * current row: pending, not dismissed, on this company and issue, addressed to
 * this agent. A retry rewrites `wakeReason` but keeps the creating route's
 * `source`.
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
  const isAddressedWake =
    context.wakeReason === "interaction_pending" ||
    (Boolean(context.retryOfRunId) && context.source === "issue.interaction.created");
  const interactionId = isAddressedWake ? readId(context.interactionId) : null;
  if (!interactionId) return null;
  return db
    .select({
      id: issueThreadInteractions.id,
      kind: issueThreadInteractions.kind,
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
}

/** Wake-payload block telling a non-owner addressee how to answer the card. */
export async function buildAddressedInteractionWake(
  db: Db,
  input: Parameters<typeof readAddressedInteractionForWake>[1],
) {
  const interaction = await readAddressedInteractionForWake(db, input);
  if (!interaction || interaction.issueAssigneeAgentId === input.agentId) return null;
  const routes = ANSWER_ROUTES[interaction.kind];
  if (!routes) return null;
  const readPath = `/api/issues/${input.issueId}/interactions`;
  return {
    id: interaction.id,
    kind: interaction.kind,
    readPath,
    answerPaths: routes.map((route) => `${readPath}/${interaction.id}/${route}`),
  };
}
