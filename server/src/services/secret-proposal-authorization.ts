import type { Db } from "@paperclipai/db";
import { forbidden, unprocessable } from "../errors.js";
import { accessService } from "./access.js";
import { authorizationDeniedDetails, type AuthorizationActor } from "./authorization.js";

type ResolvableSecretProposal = {
  kind: string;
  targetId: string | null;
};

export async function assertCanResolveProposal(input: {
  db: Db;
  actor: AuthorizationActor;
  companyId: string;
  proposal: ResolvableSecretProposal;
  assertSecretDefinitionAdmin?: () => void;
}) {
  if (input.proposal.kind === "secret") {
    if (!input.assertSecretDefinitionAdmin) {
      throw forbidden("Company admin access required");
    }
    input.assertSecretDefinitionAdmin();
    return;
  }
  if (input.proposal.kind !== "binding" || !input.proposal.targetId) {
    throw unprocessable("Binding proposal target is missing");
  }
  const decision = await accessService(input.db).decide({
    actor: input.actor,
    action: "agent_config:update",
    resource: {
      type: "agent",
      companyId: input.companyId,
      agentId: input.proposal.targetId,
    },
    scope: { requiresChangeGrant: true },
  });
  if (!decision.allowed) {
    throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
  }
}

/**
 * Mirrors the Secrets › Proposals admin check (owner/admin membership,
 * instance admin, or local implicit board) without throwing, so cards can
 * show the outcome before the human clicks.
 */
export function actorHasSecretDefinitionAdminAccess(
  actor: AuthorizationActor & { source?: string | null },
  companyId: string,
) {
  if (actor.type !== "board") return false;
  if (actor.source === "local_implicit" || actor.isInstanceAdmin) return true;
  if (!actor.companyIds?.includes(companyId)) return false;
  const membership = actor.memberships?.find((item) => item.companyId === companyId);
  return membership?.status === "active" && ["owner", "admin"].includes(String(membership.membershipRole));
}

/**
 * Returns a plain-language reason the actor cannot resolve this proposal, or
 * null when the same checks assertCanResolveProposal applies would pass.
 */
export async function proposalResolutionBlockReason(input: {
  db: Db;
  actor: AuthorizationActor & { source?: string | null };
  companyId: string;
  proposal: ResolvableSecretProposal & { proposedName?: string | null };
  targetAgentName?: string | null;
}): Promise<string | null> {
  if (input.actor.type !== "board") return "Only a board user can approve secret proposals";
  if (input.proposal.kind === "secret") {
    return actorHasSecretDefinitionAdminAccess(input.actor, input.companyId)
      ? null
      : `Company owner or admin access is required to approve the proposed secret ${input.proposal.proposedName ?? ""}`.trim();
  }
  if (input.proposal.kind !== "binding" || !input.proposal.targetId) return "Binding proposal target is missing";
  const decision = await accessService(input.db).decide({
    actor: input.actor,
    action: "agent_config:update",
    resource: { type: "agent", companyId: input.companyId, agentId: input.proposal.targetId },
    scope: { requiresChangeGrant: true },
  });
  if (decision.allowed) return null;
  const target = input.targetAgentName ?? "the target agent";
  return `You do not have permission to change ${target}'s configuration: ${decision.explanation}`;
}
