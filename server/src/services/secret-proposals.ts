import { updateAgentConfigurationInTransaction } from "./agent-configuration-transaction.js";
import { withAgentAppearance } from "@paperclipai/shared";
import { and, count, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companySecretBindings,
  companySecretProposals,
  companySecrets,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
  userSecretDeclarations,
  userSecretDefinitions,
} from "@paperclipai/db";
import type { SecretProvider } from "@paperclipai/shared";
import { badRequest, conflict, forbidden, HttpError, notFound, unprocessable } from "../errors.js";
import { getSecretProvider } from "../secrets/provider-registry.js";
import { agentService } from "./agents.js";
import { logActivity } from "./activity-log.js";
import { normalizeSecretKey, secretService } from "./secrets.js";

const CONFIG_PATH_RE = /^(?:env\.[A-Za-z_][A-Za-z0-9_]*|access\.[A-Za-z_][A-Za-z0-9_]*)$/;
const SECRET_NAME_RE = /^[^/\s]+(?:\/[^/\s]+)*$/;
const MAX_PENDING_PROPOSALS_PER_AGENT = 20;
const MAX_PROPOSALS_PER_MINUTE = 20;
const MAX_SECRET_VALUE_BYTES = 64 * 1024;
const PENDING_EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_PROPOSAL_LIST_LIMIT = 100;
const DEFAULT_EXPIRY_SWEEP_LIMIT = 100;

export type SecretProposalTerminalStatus = "approved" | "rejected" | "withdrawn" | "expired";

export type ProposalRunContext = {
  companyId: string;
  heartbeatRunId: string;
  registerForRedaction: (value: string) => void | Promise<void>;
};

type Proposal = typeof companySecretProposals.$inferSelect;

async function loadRunContext(db: Db, context: Pick<ProposalRunContext, "companyId" | "heartbeatRunId">) {
  const run = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, context.heartbeatRunId),
    eq(heartbeatRuns.companyId, context.companyId),
  )).then((rows) => rows[0] ?? null);
  if (!run) throw forbidden("Secret proposals require a verified run-bound agent token");
  const issue = await db.select({ id: issues.id }).from(issues).where(and(
    eq(issues.companyId, context.companyId),
    or(eq(issues.executionRunId, run.id), eq(issues.checkoutRunId, run.id)),
  )).then((rows) => rows[0] ?? null);
  return { run, originIssueId: issue?.id ?? null };
}

async function ancestorIds(db: Db, companyId: string, agentId: string, lockForUpdate = false) {
  const query = db.select({ id: agents.id, reportsTo: agents.reportsTo }).from(agents)
    .where(eq(agents.companyId, companyId));
  const rows = lockForUpdate ? await query.for("update") : await query;
  const byId = new Map(rows.map((row) => [row.id, row.reportsTo]));
  if (!byId.has(agentId)) throw notFound("Agent not found");
  const result: string[] = [];
  const seen = new Set<string>([agentId]);
  let current = byId.get(agentId) ?? null;
  while (current && !seen.has(current)) {
    result.push(current);
    seen.add(current);
    current = byId.get(current) ?? null;
  }
  return result;
}

function bindingTargetAllowed(proposerAgentId: string, targetAgentId: string, targetAncestorIds: string[]) {
  return proposerAgentId === targetAgentId || targetAncestorIds.includes(proposerAgentId);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function createSecretProposalsService(db: Db) {
  async function getById(companyId: string, proposalId: string, dbClient: Db = db, lockForUpdate = false) {
    const query = dbClient.select().from(companySecretProposals).where(and(
      eq(companySecretProposals.id, proposalId),
      eq(companySecretProposals.companyId, companyId),
    ));
    if (lockForUpdate) return query.for("update").then((rows) => rows[0] ?? null);
    return query.then((rows) => rows[0] ?? null);
  }

  async function requirePending(companyId: string, proposalId: string, dbClient: Db = db, lockForUpdate = false) {
    const proposal = await getById(companyId, proposalId, dbClient, lockForUpdate);
    if (!proposal) throw notFound("Secret proposal not found");
    if (proposal.status !== "pending") throw conflict("Only pending proposals can be resolved");
    return proposal;
  }

  function assertNotExpired(proposal: Proposal) {
    if (proposal.expiresAt.getTime() <= Date.now()) {
      throw conflict("Expired proposals cannot be approved");
    }
  }

  type CreationQuotaInput = { companyId: string; agentId: string; runId: string; issueId: string | null };

  async function creationQuotaDenial(dbClient: Db, input: CreationQuotaInput) {
    const [pending, recent] = await Promise.all([
      dbClient.select({ value: count() }).from(companySecretProposals).where(and(
        eq(companySecretProposals.companyId, input.companyId),
        eq(companySecretProposals.proposedByAgentId, input.agentId),
        eq(companySecretProposals.status, "pending"),
      )).then((rows) => Number(rows[0]?.value ?? 0)),
      dbClient.select({ value: count() }).from(companySecretProposals).where(and(
        eq(companySecretProposals.companyId, input.companyId),
        eq(companySecretProposals.proposedByAgentId, input.agentId),
        gte(companySecretProposals.createdAt, new Date(Date.now() - 60_000)),
      )).then((rows) => Number(rows[0]?.value ?? 0)),
    ]);
    const denial = pending >= MAX_PENDING_PROPOSALS_PER_AGENT
      ? { code: "pending_cap", message: `Agents may have at most ${MAX_PENDING_PROPOSALS_PER_AGENT} pending secret proposals` }
      : recent >= MAX_PROPOSALS_PER_MINUTE
        ? { code: "rate_limit", message: `Agents may create at most ${MAX_PROPOSALS_PER_MINUTE} secret proposals per minute` }
        : null;
    return denial ? { ...denial, pending, recent } : null;
  }

  async function createWithinQuota<T>(input: CreationQuotaInput, create: (txDb: Db) => Promise<T>) {
    const result = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.companyId}), hashtext(${input.agentId}))`);
      const denial = await creationQuotaDenial(txDb, input);
      if (denial) {
        await logActivity(txDb, {
          companyId: input.companyId,
          actorType: "agent",
          actorId: input.agentId,
          action: "secret.proposal.denied",
          entityType: "agent",
          entityId: input.agentId,
          agentId: input.agentId,
          runId: input.runId,
          details: { code: denial.code, issueId: input.issueId, pending: denial.pending, recent: denial.recent },
        });
        return { denial, value: null };
      }
      return { denial: null, value: await create(txDb) };
    });
    if (result.denial) throw unprocessable(result.denial.message);
    return result.value as T;
  }

  async function recordCreated(proposal: Proposal, dbClient: Db = db) {
    await logActivity(dbClient, {
      companyId: proposal.companyId,
      actorType: "agent",
      actorId: proposal.proposedByAgentId,
      action: "secret.proposal.created",
      entityType: "company_secret_proposal",
      entityId: proposal.id,
      agentId: proposal.proposedByAgentId,
      runId: proposal.originRunId,
      details: {
        kind: proposal.kind,
        issueId: proposal.originIssueId,
        targetAgentId: proposal.targetId,
        configPath: proposal.configPath,
        valueFingerprintSha256: proposal.valueFingerprintSha256,
      },
    });
  }

  async function createBindingInteraction(
    txDb: Db,
    proposal: Proposal,
    sourceSecretLabel: string,
  ) {
    if (!proposal.originIssueId || !proposal.targetId || !proposal.configPath) return proposal;
    const target = await txDb
      .select({ name: agents.name })
      .from(agents)
      .where(and(eq(agents.id, proposal.targetId), eq(agents.companyId, proposal.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!target) throw notFound("Target agent not found");

    const [interaction] = await txDb
      .insert(issueThreadInteractions)
      .values({
        companyId: proposal.companyId,
        issueId: proposal.originIssueId,
        kind: "request_confirmation",
        status: "pending",
        continuationPolicy: "wake_assignee",
        requestedResolverPolicy: "human_only",
        effectiveResolverPolicy: "human_only",
        resolverPolicyProvenance: "explicit",
        effectiveResolverPolicySource: "governed_action",
        idempotencyKey: `secret-proposal:${proposal.id}`,
        sourceRunId: proposal.originRunId,
        title: "Confirm secret binding",
        summary: `Bind ${sourceSecretLabel} to ${target.name} as ${proposal.configPath}`,
        createdByAgentId: proposal.proposedByAgentId,
        addresseeAgentId: null,
        payload: {
          version: 1,
          prompt: `Bind secret ${sourceSecretLabel} to ${target.name} as ${proposal.configPath}?`,
          acceptLabel: "Create binding",
          rejectLabel: "Reject",
          rejectRequiresReason: true,
          rejectReasonLabel: "Why should this binding not be created?",
          allowDeclineReason: true,
          supersedeOnUserComment: false,
          secretProposal: {
            version: 1,
            proposalId: proposal.id,
            sourceSecretLabel,
            configPath: proposal.configPath,
            targetAgentId: proposal.targetId,
            targetAgentName: target.name,
            justification: proposal.justification,
            expiresAt: proposal.expiresAt.toISOString(),
          },
        },
      })
      .returning();

    const [linked] = await txDb
      .update(companySecretProposals)
      .set({ interactionId: interaction.id, updatedAt: new Date() })
      .where(eq(companySecretProposals.id, proposal.id))
      .returning();
    await txDb.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, proposal.originIssueId));
    await logActivity(txDb, {
      companyId: proposal.companyId,
      actorType: "agent",
      actorId: proposal.proposedByAgentId,
      action: "issue.thread_interaction_created",
      entityType: "issue",
      entityId: proposal.originIssueId,
      agentId: proposal.proposedByAgentId,
      runId: proposal.originRunId,
      details: {
        interactionId: interaction.id,
        interactionKind: "request_confirmation",
        interactionStatus: "pending",
        continuationPolicy: "wake_assignee",
        addresseeAgentId: null,
        requestedResolverPolicy: "board_only",
        effectiveResolverPolicy: "board_only",
        serverOwnedPayload: "secretProposal",
      },
    });
    return linked;
  }

  function bundleCardText(secretLabel: string, bindings: Array<{ configPath: string; targetAgentName: string }>) {
    const list = bindings.map((binding) => `${binding.targetAgentName} as ${binding.configPath}`).join("; ");
    const noun = bindings.length === 1 ? "binding" : `${bindings.length} bindings`;
    const clip = (value: string, max: number) => value.length > max ? `${value.slice(0, max - 1)}…` : value;
    return {
      summary: clip(`Create secret ${secretLabel} and its ${noun}: ${list}`, 1000),
      prompt: clip(`Approve the proposed secret ${secretLabel} and its ${noun} (${list})?`, 1000),
    };
  }

  /**
   * One card per pending secret proposal: the first binding that references a
   * pending secret proposal raises a card anchored to that secret proposal;
   * later bindings for the same proposal join the same card. Accepting the
   * card approves the secret and all its bindings in one decision.
   */
  async function createOrExtendSecretBundleInteraction(
    txDb: Db,
    binding: Proposal,
    dependency: Proposal,
  ) {
    if (!binding.originIssueId || !binding.targetId || !binding.configPath) return binding;
    const target = await txDb
      .select({ name: agents.name })
      .from(agents)
      .where(and(eq(agents.id, binding.targetId), eq(agents.companyId, binding.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!target) throw notFound("Target agent not found");
    const entry = {
      proposalId: binding.id,
      configPath: binding.configPath,
      targetAgentId: binding.targetId,
      targetAgentName: target.name,
    };
    const secretLabel = dependency.proposedName ?? "proposed secret";
    const now = new Date();

    if (dependency.interactionId) {
      const existing = await txDb
        .select()
        .from(issueThreadInteractions)
        .where(and(
          eq(issueThreadInteractions.id, dependency.interactionId),
          eq(issueThreadInteractions.companyId, dependency.companyId),
        ))
        .for("update")
        .then((rows) => rows[0] ?? null);
      const existingPayload = asRecord(existing?.payload);
      const linked = asRecord(existingPayload.secretProposal);
      if (!existing || existing.status !== "pending" || linked.proposalId !== dependency.id) {
        throw unprocessable(
          "The secret proposal's approval card is no longer pending; use secretId once the secret is approved",
        );
      }
      const bindings = [
        ...(Array.isArray(linked.bindings) ? linked.bindings as typeof entry[] : []),
        entry,
      ];
      const text = bundleCardText(secretLabel, bindings);
      await txDb
        .update(issueThreadInteractions)
        .set({
          summary: text.summary,
          payload: {
            ...existingPayload,
            prompt: text.prompt,
            secretProposal: { ...linked, bindings },
          } as typeof existing.payload,
          updatedAt: now,
        })
        .where(eq(issueThreadInteractions.id, existing.id));
      const [linkedBinding] = await txDb
        .update(companySecretProposals)
        .set({ interactionId: existing.id, updatedAt: now })
        .where(eq(companySecretProposals.id, binding.id))
        .returning();
      await txDb.update(issues).set({ updatedAt: now }).where(eq(issues.id, existing.issueId));
      return linkedBinding;
    }

    const text = bundleCardText(secretLabel, [entry]);
    const expiresAt = dependency.expiresAt.getTime() < binding.expiresAt.getTime()
      ? dependency.expiresAt
      : binding.expiresAt;
    const [interaction] = await txDb
      .insert(issueThreadInteractions)
      .values({
        companyId: binding.companyId,
        issueId: binding.originIssueId,
        kind: "request_confirmation",
        status: "pending",
        continuationPolicy: "wake_assignee",
        requestedResolverPolicy: "human_only",
        effectiveResolverPolicy: "human_only",
        resolverPolicyProvenance: "explicit",
        effectiveResolverPolicySource: "governed_action",
        idempotencyKey: `secret-proposal:${dependency.id}`,
        sourceRunId: binding.originRunId,
        title: "Confirm new secret and bindings",
        summary: text.summary,
        createdByAgentId: binding.proposedByAgentId,
        addresseeAgentId: null,
        payload: {
          version: 1,
          prompt: text.prompt,
          acceptLabel: "Approve secret & bindings",
          rejectLabel: "Reject",
          rejectRequiresReason: true,
          rejectReasonLabel: "Why should this secret and its bindings not be created?",
          allowDeclineReason: true,
          supersedeOnUserComment: false,
          secretProposal: {
            version: 1,
            kind: "secret_with_bindings",
            proposalId: dependency.id,
            sourceSecretLabel: secretLabel,
            configPath: entry.configPath,
            targetAgentId: entry.targetAgentId,
            targetAgentName: entry.targetAgentName,
            justification: dependency.justification,
            expiresAt: expiresAt.toISOString(),
            bindings: [entry],
          },
        },
      })
      .returning();
    await txDb
      .update(companySecretProposals)
      .set({ interactionId: interaction.id, updatedAt: now })
      .where(eq(companySecretProposals.id, dependency.id));
    const [linkedBinding] = await txDb
      .update(companySecretProposals)
      .set({ interactionId: interaction.id, updatedAt: now })
      .where(eq(companySecretProposals.id, binding.id))
      .returning();
    await txDb.update(issues).set({ updatedAt: now }).where(eq(issues.id, binding.originIssueId));
    await logActivity(txDb, {
      companyId: binding.companyId,
      actorType: "agent",
      actorId: binding.proposedByAgentId,
      action: "issue.thread_interaction_created",
      entityType: "issue",
      entityId: binding.originIssueId,
      agentId: binding.proposedByAgentId,
      runId: binding.originRunId,
      details: {
        interactionId: interaction.id,
        interactionKind: "request_confirmation",
        interactionStatus: "pending",
        continuationPolicy: "wake_assignee",
        addresseeAgentId: null,
        requestedResolverPolicy: "board_only",
        effectiveResolverPolicy: "board_only",
        serverOwnedPayload: "secretProposal",
        secretProposalId: dependency.id,
      },
    });
    return linkedBinding;
  }

  async function reflectProposalLifecycleOnInteraction(
    txDb: Db,
    proposal: Proposal,
    outcome: "approved" | "rejected" | "withdrawn" | "expired",
    input: { resolvedByUserId?: string | null; reason?: string | null } = {},
  ) {
    if (!proposal.interactionId) return;
    const current = await txDb
      .select()
      .from(issueThreadInteractions)
      .where(and(
        eq(issueThreadInteractions.id, proposal.interactionId),
        eq(issueThreadInteractions.companyId, proposal.companyId),
      ))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!current || (current.status !== "pending" && !(outcome === "approved" && current.status === "accepted"))) return;
    const payload = asRecord(current.payload);
    const linked = asRecord(payload.secretProposal);
    if (linked.kind === "secret_with_bindings") {
      // A bundle card resolves only when its secret is rejected/withdrawn/
      // expired, or once the secret and every bundled binding are approved
      // (for example when each was approved on Secrets › Proposals).
      const isAnchor = linked.proposalId === proposal.id;
      if (!isAnchor && (outcome !== "approved" || proposal.secretProposalId !== linked.proposalId)) return;
      if (outcome === "approved") {
        const anchor = isAnchor ? proposal : await getById(proposal.companyId, String(linked.proposalId), txDb);
        if (!anchor || (anchor.status !== "approved" && anchor.id !== proposal.id)) return;
        const stillPending = await txDb
          .select({ id: companySecretProposals.id })
          .from(companySecretProposals)
          .where(and(
            eq(companySecretProposals.companyId, proposal.companyId),
            eq(companySecretProposals.interactionId, current.id),
            eq(companySecretProposals.kind, "binding"),
            eq(companySecretProposals.status, "pending"),
          ));
        if (stillPending.length > 0) return;
      }
    } else if (linked.proposalId !== proposal.id) return;

    const now = new Date();
    const currentResult = asRecord(current.result);
    const status = outcome === "approved"
      ? "accepted"
      : outcome === "rejected"
        ? "rejected"
        : outcome === "withdrawn"
          ? "cancelled"
          : "expired";
    const resultOutcome = outcome === "approved"
      ? "accepted"
      : outcome === "rejected"
        ? "rejected"
        : "withdrawn";
    await txDb
      .update(issueThreadInteractions)
      .set({
        status,
        result: {
          ...currentResult,
          version: 1,
          outcome: resultOutcome,
          ...(input.reason ? { reason: input.reason } : {}),
          secretProposal: {
            version: 1,
            status: outcome === "approved" ? "executed" : outcome,
            updatedAt: now.toISOString(),
          },
        },
        resolvedByUserId: input.resolvedByUserId ?? current.resolvedByUserId ?? null,
        resolvedAt: current.resolvedAt ?? now,
        updatedAt: now,
      })
      .where(and(
        eq(issueThreadInteractions.id, current.id),
        inArray(issueThreadInteractions.status, outcome === "approved" ? ["pending", "accepted"] : ["pending"]),
      ));
  }

  async function createSecret(context: ProposalRunContext, input: {
    name: string;
    key?: string | null;
    description?: string | null;
    value: string;
    justification: string;
  }) {
    // Callers outside the strict route schema must not reach a TypeError (500).
    if (typeof input.name !== "string") throw unprocessable("Secret name is required");
    if (typeof input.justification !== "string") throw unprocessable("Justification is required");
    if (typeof input.value !== "string") throw unprocessable("Secret value is required");
    const name = input.name.trim();
    const justification = input.justification.trim();
    if (!SECRET_NAME_RE.test(name)) throw unprocessable("Secret name must be a slash-separated path without empty segments");
    if (!justification) throw unprocessable("Justification is required");
    if (!input.value) throw unprocessable("Secret value is required");
    if (Buffer.byteLength(input.value, "utf8") > MAX_SECRET_VALUE_BYTES) {
      throw unprocessable(`Secret value must be at most ${MAX_SECRET_VALUE_BYTES} bytes`);
    }
    const proposedKey = normalizeSecretKey(input.key?.trim() || name.split("/").at(-1) || "");
    if (!proposedKey) throw unprocessable("Secret key is required");
    const { run, originIssueId } = await loadRunContext(db, context);
    const prepared = await getSecretProvider("local_encrypted").createSecret({ value: input.value });
    await context.registerForRedaction(input.value);
    return createWithinQuota(
      { companyId: context.companyId, agentId: run.agentId, runId: run.id, issueId: originIssueId },
      async (txDb) => {
        const proposal = await txDb.insert(companySecretProposals).values({
          companyId: context.companyId,
          kind: "secret",
          proposedName: name,
          proposedKey,
          proposedDescription: input.description?.trim() || null,
          justification,
          valueCiphertext: prepared.material,
          valueFingerprintSha256: prepared.fingerprintSha256 ?? prepared.valueSha256,
          valueLength: Buffer.byteLength(input.value, "utf8"),
          proposedByAgentId: run.agentId,
          originIssueId,
          originRunId: run.id,
          expiresAt: new Date(Date.now() + PENDING_EXPIRY_MS),
        }).returning().then((rows) => rows[0]);
        await recordCreated(proposal, txDb);
        return proposal;
      },
    );
  }

  async function createBinding(context: Pick<ProposalRunContext, "companyId" | "heartbeatRunId">, input: {
    secretId?: string | null;
    sourceConfigPath?: string | null;
    secretProposalId?: string | null;
    targetAgentId?: string | null;
    configPath: string;
    justification: string;
    bindingTargetPolicy: "self_and_reports";
  }) {
    const referenceCount = [input.secretId, input.sourceConfigPath, input.secretProposalId]
      .filter((value) => Boolean(value)).length;
    if (referenceCount !== 1) {
      throw badRequest(
        "Binding proposals require exactly one of secretId, sourceConfigPath, or secretProposalId",
      );
    }
    if (typeof input.configPath !== "string" || !CONFIG_PATH_RE.test(input.configPath)) {
      throw unprocessable("configPath must use env.<KEY> or access.<ALIAS>");
    }
    if (input.sourceConfigPath && !CONFIG_PATH_RE.test(input.sourceConfigPath)) {
      throw unprocessable("sourceConfigPath must use env.<KEY> or access.<ALIAS>");
    }
    if (typeof input.justification !== "string" || !input.justification.trim()) {
      throw unprocessable("Justification is required");
    }
    if (input.justification.trim().length > 20_000) throw unprocessable("Justification must be at most 20000 characters");
    const { run, originIssueId } = await loadRunContext(db, context);
    const targetAgentId = input.targetAgentId ?? run.agentId;
    const [proposerAncestors, targetAncestors] = await Promise.all([
      ancestorIds(db, context.companyId, run.agentId),
      ancestorIds(db, context.companyId, targetAgentId),
    ]);
    if (!bindingTargetAllowed(run.agentId, targetAgentId, targetAncestors)) {
      throw forbidden("Binding proposals may target only the proposing agent or its reports");
    }
    let resolvedSecretId = input.secretId ?? null;
    let sourceSecretLabel: string | null = null;
    if (input.sourceConfigPath) {
      const sourceBinding = await db.select({ secretId: companySecretBindings.secretId })
        .from(companySecretBindings)
        .where(and(
          eq(companySecretBindings.companyId, context.companyId),
          eq(companySecretBindings.targetType, "agent"),
          eq(companySecretBindings.targetId, run.agentId),
          eq(companySecretBindings.configPath, input.sourceConfigPath),
        ))
        .then((rows) => rows[0] ?? null);
      if (sourceBinding) {
        resolvedSecretId = sourceBinding.secretId;
      } else if (run.responsibleUserId) {
        const sourceDeclaration = await db
          .select({ secretId: companySecrets.id })
          .from(userSecretDeclarations)
          .innerJoin(companySecrets, and(
            eq(companySecrets.companyId, context.companyId),
            eq(companySecrets.scope, "user"),
            eq(companySecrets.ownerUserId, run.responsibleUserId),
            eq(companySecrets.userSecretDefinitionId, userSecretDeclarations.userSecretDefinitionId),
            eq(companySecrets.status, "active"),
          ))
          .where(and(
            eq(userSecretDeclarations.companyId, context.companyId),
            eq(userSecretDeclarations.targetType, "agent"),
            eq(userSecretDeclarations.targetId, run.agentId),
            eq(userSecretDeclarations.configPath, input.sourceConfigPath),
          ))
          .then((rows) => rows[0] ?? null);
        resolvedSecretId = sourceDeclaration?.secretId ?? null;
      }
      if (!resolvedSecretId) throw notFound("Source secret binding not found");
    }
    if (resolvedSecretId) {
      const secret = await db.select().from(companySecrets).where(and(
        eq(companySecrets.id, resolvedSecretId),
        eq(companySecrets.companyId, context.companyId),
      )).then((rows) => rows[0] ?? null);
      const sourceBindingAllowsUserSecret = Boolean(input.sourceConfigPath) && secret?.scope === "user";
      if (
        !secret
        || secret.status === "deleted"
        || (secret.scope !== "company" && !sourceBindingAllowsUserSecret)
      ) {
        throw notFound("Secret not found");
      }
      sourceSecretLabel = secret.name;
    }
    return createWithinQuota(
      { companyId: context.companyId, agentId: run.agentId, runId: run.id, issueId: originIssueId },
      async (txDb) => {
        let pendingDependency: Proposal | null = null;
        if (input.secretProposalId) {
          const dependency = await txDb.select().from(companySecretProposals).where(and(
            eq(companySecretProposals.id, input.secretProposalId),
            eq(companySecretProposals.companyId, context.companyId),
          )).for("update").then((rows) => rows[0] ?? null);
          if (!dependency || dependency.kind !== "secret") throw notFound("Secret proposal not found");
          if (dependency.status !== "pending") {
            throw unprocessable(
              "Prerequisite secret proposal is no longer pending; use secretId to reference an approved secret",
            );
          }
          sourceSecretLabel = dependency.proposedName;
          pendingDependency = dependency;
        }
        const proposal = await txDb.insert(companySecretProposals).values({
          companyId: context.companyId,
          kind: "binding",
          justification: input.justification.trim(),
          secretId: resolvedSecretId,
          secretProposalId: input.secretProposalId ?? null,
          targetType: "agent",
          targetId: targetAgentId,
          configPath: input.configPath,
          bindingTargetPolicySnapshot: input.bindingTargetPolicy,
          proposerAncestorIdsSnapshot: proposerAncestors,
          targetAncestorIdsSnapshot: targetAncestors,
          proposedByAgentId: run.agentId,
          originIssueId,
          originRunId: run.id,
          expiresAt: new Date(Date.now() + PENDING_EXPIRY_MS),
        }).returning().then((rows) => rows[0]);
        await recordCreated(proposal, txDb);
        if (!sourceSecretLabel) throw conflict("Binding proposal source secret label is unavailable");
        if (pendingDependency) return createOrExtendSecretBundleInteraction(txDb, proposal, pendingDependency);
        return createBindingInteraction(txDb, proposal, sourceSecretLabel);
      },
    );
  }

  async function enrich(proposal: Proposal) {
    const [proposer, target, originIssue, secret, secretProposal] = await Promise.all([
      db.select({ id: agents.id, name: agents.name, icon: agents.icon, appearance: agents.appearance }).from(agents)
        .where(eq(agents.id, proposal.proposedByAgentId)).then((rows) => rows[0] ?? null),
      proposal.targetId
        ? db.select({ id: agents.id, name: agents.name, icon: agents.icon, appearance: agents.appearance }).from(agents)
            .where(eq(agents.id, proposal.targetId)).then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
      proposal.originIssueId
        ? db.select({ id: issues.id, key: issues.identifier, title: issues.title }).from(issues)
            .where(eq(issues.id, proposal.originIssueId)).then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
      proposal.secretId
        ? db.select({ name: companySecrets.name }).from(companySecrets)
            .where(eq(companySecrets.id, proposal.secretId)).then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
      proposal.secretProposalId
        ? db.select({ proposedName: companySecretProposals.proposedName }).from(companySecretProposals)
            .where(eq(companySecretProposals.id, proposal.secretProposalId)).then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
    ]);
    if (!proposer) throw notFound("Proposal agent not found");
    const {
      valueCiphertext: _ciphertext,
      bindingTargetPolicySnapshot: _policy,
      proposerAncestorIdsSnapshot: _proposerAncestors,
      targetAncestorIdsSnapshot: _targetAncestors,
      ...safe
    } = proposal;
    return {
      ...safe,
      secretName: secret?.name ?? null,
      secretProposalName: secretProposal?.proposedName ?? null,
      proposedBy: withAgentAppearance(proposer),
      target: target ? withAgentAppearance(target) : null,
      originIssue,
    };
  }

  async function listForAgent(
    companyId: string,
    agentId: string,
    options: { limit?: number; offset?: number } = {},
  ) {
    const rows = await db.select().from(companySecretProposals).where(and(
      eq(companySecretProposals.companyId, companyId),
      or(
        eq(companySecretProposals.proposedByAgentId, agentId),
        and(eq(companySecretProposals.kind, "binding"), eq(companySecretProposals.targetId, agentId)),
      ),
    )).orderBy(desc(companySecretProposals.createdAt))
      .limit(options.limit ?? DEFAULT_PROPOSAL_LIST_LIMIT)
      .offset(options.offset ?? 0);
    return Promise.all(rows.map(enrich));
  }

  async function listForBoard(
    companyId: string,
    status?: string | null,
    options: { limit?: number; offset?: number } = {},
  ) {
    const rows = await db.select().from(companySecretProposals).where(and(
      eq(companySecretProposals.companyId, companyId),
      status ? eq(companySecretProposals.status, status) : undefined,
    )).orderBy(desc(companySecretProposals.createdAt))
      .limit(options.limit ?? DEFAULT_PROPOSAL_LIST_LIMIT)
      .offset(options.offset ?? 0);
    return Promise.all(rows.map(enrich));
  }

  async function assertBindingSnapshotCurrent(proposal: Proposal, dbClient: Db = db, lockForUpdate = false) {
    if (proposal.kind !== "binding" || !proposal.targetId) return;
    const snapshotAllowed = proposal.bindingTargetPolicySnapshot === "self_and_reports"
      && bindingTargetAllowed(proposal.proposedByAgentId, proposal.targetId, proposal.targetAncestorIdsSnapshot ?? []);
    const currentTargetAncestors = await ancestorIds(
      dbClient,
      proposal.companyId,
      proposal.targetId,
      lockForUpdate,
    );
    const currentAllowed = bindingTargetAllowed(proposal.proposedByAgentId, proposal.targetId, currentTargetAncestors);
    if (!snapshotAllowed || !currentAllowed) {
      throw conflict("Binding proposal target is no longer allowed by its proposal-time and current chain-of-command policy");
    }
  }

  async function applySecretApproval(txDb: Db, proposal: Proposal, input: {
    resolvedByUserId: string;
    overrides?: { name?: string; description?: string | null; providerConfigId?: string | null };
  }) {
    if (!proposal.valueCiphertext) throw conflict("Proposed secret value is no longer available");
    const name = input.overrides?.name?.trim() || proposal.proposedName || "";
    if (!SECRET_NAME_RE.test(name)) throw unprocessable("Secret name must be a slash-separated path without empty segments");
    const value = await getSecretProvider("local_encrypted").resolveVersion({
      material: proposal.valueCiphertext,
      externalRef: null,
    });
    const secrets = secretService(txDb);
    const providerConfigId = input.overrides?.providerConfigId ?? null;
    const providerConfig = providerConfigId
      ? await secrets.getProviderConfigById(providerConfigId)
      : null;
    if (providerConfigId && (!providerConfig || providerConfig.companyId !== proposal.companyId)) {
      throw notFound("Provider vault not found");
    }
    const provider = (providerConfig?.provider ?? "local_encrypted") as SecretProvider;
    const created = await secrets.create(
      proposal.companyId,
      {
        name,
        key: proposal.proposedKey || normalizeSecretKey(name.split("/").at(-1) || ""),
        provider,
        providerConfigId,
        value,
        description: input.overrides?.description === undefined
          ? proposal.proposedDescription
          : input.overrides.description,
      },
      { userId: input.resolvedByUserId, agentId: proposal.proposedByAgentId },
    );
    await logActivity(txDb, {
      companyId: proposal.companyId,
      actorType: "user",
      actorId: input.resolvedByUserId,
      action: "secret.created",
      entityType: "secret",
      entityId: created.id,
      agentId: proposal.proposedByAgentId,
      runId: proposal.originRunId,
      details: { name: created.name, provider: created.provider, proposalId: proposal.id },
    });
    return created;
  }

  async function markApproved(txDb: Db, proposal: Proposal, input: {
    resolvedByUserId: string;
    createdSecretId?: string | null;
    appliedBindingConfigPath?: string | null;
  }) {
    const now = new Date();
    const updated = await txDb.update(companySecretProposals).set({
      status: "approved",
      resolvedByUserId: input.resolvedByUserId,
      resolvedAt: now,
      createdSecretId: input.createdSecretId ?? null,
      appliedBindingConfigPath: input.appliedBindingConfigPath ?? null,
      valueCiphertext: null,
      ciphertextScrubbedAt: now,
      updatedAt: now,
    }).where(and(
      eq(companySecretProposals.id, proposal.id),
      eq(companySecretProposals.status, "pending"),
    )).returning().then((rows) => rows[0] ?? null);
    if (!updated) throw conflict("Proposal is no longer pending");
    await logActivity(txDb, {
      companyId: proposal.companyId,
      actorType: "user",
      actorId: input.resolvedByUserId,
      action: "secret.proposal.approved",
      entityType: "company_secret_proposal",
      entityId: proposal.id,
      agentId: proposal.proposedByAgentId,
      runId: proposal.originRunId,
      details: {
        issueId: proposal.originIssueId,
        createdSecretId: input.createdSecretId ?? null,
        appliedBindingConfigPath: input.appliedBindingConfigPath ?? null,
        ciphertextScrubbed: true,
      },
    });
    await reflectProposalLifecycleOnInteraction(txDb, proposal, "approved", {
      resolvedByUserId: input.resolvedByUserId,
    });
    return updated;
  }

  async function applyBindingApproval(
    txDb: Db,
    proposal: Proposal,
    secret: typeof companySecrets.$inferSelect,
    resolvedByUserId: string,
  ) {
    if (!proposal.targetId || !proposal.configPath) throw conflict("Binding proposal is incomplete");
    const agentSvc = agentService(txDb);
    const target = await agentSvc.getById(proposal.targetId);
    if (!target || target.companyId !== proposal.companyId) throw notFound("Target agent not found");
    const adapterConfig = { ...asRecord(target.adapterConfig) };
    const [namespace, key] = proposal.configPath.split(".", 2);
    const userSecretDefinition = secret.scope === "user" && secret.userSecretDefinitionId
      ? await txDb.select({ key: userSecretDefinitions.key }).from(userSecretDefinitions).where(and(
          eq(userSecretDefinitions.id, secret.userSecretDefinitionId),
          eq(userSecretDefinitions.companyId, proposal.companyId),
          eq(userSecretDefinitions.status, "active"),
        )).then((rows) => rows[0] ?? null)
      : null;
    if (secret.scope === "user" && !userSecretDefinition) {
      throw conflict("Binding proposal user secret definition is not active");
    }
    const binding = userSecretDefinition
      ? {
          type: "user_secret_ref",
          key: userSecretDefinition.key,
          version: "latest",
          required: true,
          allowMissingOverride: false,
        }
      : { type: "secret_ref", secretId: secret.id, version: "latest" };
    if (namespace === "env") {
      const env = { ...asRecord(adapterConfig.env) };
      const existing = env[key];
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(binding)) {
        throw conflict(`Agent config path already exists: ${proposal.configPath}`);
      }
      adapterConfig.env = { ...env, [key]: binding };
    } else {
      const existing = adapterConfig[proposal.configPath];
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(binding)) {
        throw conflict(`Agent config path already exists: ${proposal.configPath}`);
      }
      adapterConfig[proposal.configPath] = binding;
    }
    const updated = await updateAgentConfigurationInTransaction(txDb, target.id, { adapterConfig }, {
      recordRevision: { createdByUserId: resolvedByUserId, source: "patch" },
    });
    if (!updated) throw notFound("Target agent not found");
    await logActivity(txDb, {
      companyId: proposal.companyId,
      actorType: "user",
      actorId: resolvedByUserId,
      action: "agent.updated",
      entityType: "agent",
      entityId: target.id,
      details: { adapterConfig: true, proposalId: proposal.id, configPath: proposal.configPath },
    });
  }

  async function approve(companyId: string, proposalId: string, input: {
    resolvedByUserId: string;
    cascade?: boolean;
    overrides?: { name?: string; description?: string | null; providerConfigId?: string | null };
    assertCanResolve?: (proposal: Proposal, txDb: Db) => Promise<void>;
  }) {
    const loadForApproval = async (txDb: Db) => {
      const proposal = await requirePending(companyId, proposalId, txDb, true);
      assertNotExpired(proposal);
      await input.assertCanResolve?.(proposal, txDb);
      await assertBindingSnapshotCurrent(proposal, txDb, true);
      return proposal;
    };
    const saved = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const proposal = await loadForApproval(txDb);
      if (proposal.kind === "secret") {
        const created = await applySecretApproval(txDb, proposal, input);
        return { kind: "secret" as const, proposal: await markApproved(txDb, proposal, {
          resolvedByUserId: input.resolvedByUserId,
          createdSecretId: created.id,
        }) };
      }

      let secretId = proposal.secretId;
      if (proposal.secretProposalId) {
        const dependency = await getById(companyId, proposal.secretProposalId, txDb, true);
        if (!dependency || dependency.kind !== "secret") throw notFound("Prerequisite secret proposal not found");
        if (dependency.status !== "pending") {
          if (dependency.status !== "approved" || !dependency.createdSecretId) {
            throw conflict(`Prerequisite secret proposal ${dependency.id} is not approvable`);
          }
          secretId = dependency.createdSecretId;
        } else {
          if (!input.cascade) {
            throw conflict(`Binding proposal requires pending secret proposal ${dependency.id}; retry with cascade=true`);
          }
          assertNotExpired(dependency);
          const created = await applySecretApproval(txDb, dependency, input);
          await markApproved(txDb, dependency, {
            resolvedByUserId: input.resolvedByUserId,
            createdSecretId: created.id,
          });
          secretId = created.id;
        }
      }
      if (!secretId) throw conflict("Binding proposal has no approved secret");
      return { kind: "binding" as const, secretId };
    });
    if (saved.kind === "secret") return saved.proposal;

    // Keep the approved secret if applying its reference fails.
    return db.transaction(async tx => {
      const txDb = tx as unknown as Db;
      const proposal = await loadForApproval(txDb);
      const liveSecret = await secretService(txDb).getById(saved.secretId);
      if (!liveSecret || liveSecret.companyId !== companyId || liveSecret.status !== "active") {
        throw conflict("Binding proposal secret is not active");
      }
      await applyBindingApproval(txDb, proposal, liveSecret, input.resolvedByUserId);
      return markApproved(txDb, proposal, {
        resolvedByUserId: input.resolvedByUserId,
        appliedBindingConfigPath: proposal.configPath,
      });
    });
  }

  type CardApprovalPlan = {
    anchor: Proposal | null;
    /** Pending secret proposal that accepting the card also approves. */
    secret: Proposal | null;
    /** Pending binding proposals that accepting the card approves. */
    bindings: Proposal[];
    /** Approved secret id the bindings use when no pending secret is involved. */
    approvedSecretId: string | null;
    targetAgentNames: Map<string, string>;
    blockReason: string | null;
  };

  /**
   * Works out what accepting a secret-proposal card would approve, and why it
   * cannot, from proposal state alone. Callers add viewer permission checks.
   */
  async function planCardApproval(
    companyId: string,
    interactionId: string,
    proposalId: string,
    dbClient: Db = db,
    lockForUpdate = false,
  ): Promise<CardApprovalPlan> {
    const plan: CardApprovalPlan = {
      anchor: null,
      secret: null,
      bindings: [],
      approvedSecretId: null,
      targetAgentNames: new Map(),
      blockReason: null,
    };
    const block = (reason: string) => ({ ...plan, blockReason: reason });
    const statusWord = (status: string) => status === "withdrawn" ? "withdrawn by the agent" : status;
    const proposerIsCompanyAgent = async (proposal: Proposal) => {
      const proposer = await dbClient.select({ id: agents.id }).from(agents).where(and(
        eq(agents.id, proposal.proposedByAgentId),
        eq(agents.companyId, companyId),
      )).then((rows) => rows[0] ?? null);
      return Boolean(proposer);
    };

    // Bundle cards anchor on the secret proposal; lock its bindings before the
    // secret so the order matches binding approval (binding -> secret).
    const peek = await getById(companyId, proposalId, dbClient);
    if (!peek) return block("This secret proposal does not belong to this company");
    if (peek.interactionId !== interactionId) return block("This card is no longer linked to its secret proposal");
    if (peek.kind === "secret") {
      const bindingQuery = dbClient.select().from(companySecretProposals).where(and(
        eq(companySecretProposals.companyId, companyId),
        eq(companySecretProposals.kind, "binding"),
        eq(companySecretProposals.secretProposalId, peek.id),
        eq(companySecretProposals.interactionId, interactionId),
        eq(companySecretProposals.status, "pending"),
      )).orderBy(companySecretProposals.id);
      plan.bindings = lockForUpdate ? await bindingQuery.for("update") : await bindingQuery;
    }
    const anchor = lockForUpdate ? await getById(companyId, proposalId, dbClient, true) : peek;
    if (!anchor) return block("This secret proposal does not belong to this company");
    plan.anchor = anchor;
    if (!(await proposerIsCompanyAgent(anchor))) {
      return block("This proposal was not made by an agent of this company, so it cannot be approved from this card");
    }

    if (anchor.kind === "secret") {
      if (anchor.status === "pending") {
        if (anchor.expiresAt.getTime() <= Date.now()) return block(`The secret proposal ${anchor.proposedName} has expired`);
        plan.secret = anchor;
      } else if (anchor.status === "approved" && anchor.createdSecretId) {
        plan.approvedSecretId = anchor.createdSecretId;
      } else {
        return block(`The secret proposal ${anchor.proposedName} was ${statusWord(anchor.status)}; nothing can be approved`);
      }
      if (!plan.secret && plan.bindings.length === 0) {
        return block("Nothing is left to approve: the secret and its bindings are already resolved");
      }
    } else {
      if (anchor.status !== "pending") return block(`The binding proposal was ${statusWord(anchor.status)}`);
      plan.bindings = [anchor];
      plan.approvedSecretId = anchor.secretId;
      if (anchor.secretProposalId) {
        const dependency = await getById(companyId, anchor.secretProposalId, dbClient, lockForUpdate);
        if (!dependency || dependency.kind !== "secret") return block("The secret proposal for this binding was not found");
        if (dependency.status === "pending") {
          if (dependency.expiresAt.getTime() <= Date.now()) {
            return block(`The secret proposal ${dependency.proposedName} has expired`);
          }
          if (!(await proposerIsCompanyAgent(dependency))) {
            return block("The secret for this binding was not proposed by an agent of this company");
          }
          plan.secret = dependency;
        } else if (dependency.status === "approved" && dependency.createdSecretId) {
          plan.approvedSecretId = dependency.createdSecretId;
        } else {
          return block(
            `The secret proposal ${dependency.proposedName} was ${statusWord(dependency.status)}; ask the agent to propose the secret again`,
          );
        }
      }
    }

    for (const binding of plan.bindings) {
      if (binding.expiresAt.getTime() <= Date.now()) return block(`The binding proposal for ${binding.configPath} has expired`);
      try {
        await assertBindingSnapshotCurrent(binding, dbClient, lockForUpdate);
      } catch (error) {
        if (error instanceof HttpError) return block(`${binding.configPath}: ${error.message}`);
        throw error;
      }
      if (binding.targetId && !plan.targetAgentNames.has(binding.targetId)) {
        const target = await dbClient.select({ name: agents.name }).from(agents)
          .where(and(eq(agents.id, binding.targetId), eq(agents.companyId, companyId)))
          .then((rows) => rows[0] ?? null);
        if (!target) return block(`The target agent for ${binding.configPath} was not found`);
        plan.targetAgentNames.set(binding.targetId, target.name);
      }
    }
    if (!plan.secret && plan.bindings.length > 0 && !plan.approvedSecretId) {
      return block("The binding proposal has no approved secret");
    }
    return plan;
  }

  /**
   * Accept path for a secret-proposal card: approves the pending secret (when
   * there is one) and every pending binding on the card in one transaction,
   * and records one decision entry that names all of them. Each proposal is
   * checked by assertCanResolve exactly as the Proposals-page approval does.
   */
  async function approveFromCard(companyId: string, input: {
    interactionId: string;
    proposalId: string;
    resolvedByUserId: string;
    assertCanResolve: (proposal: Proposal, txDb: Db) => Promise<void>;
  }) {
    return db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const plan = await planCardApproval(companyId, input.interactionId, input.proposalId, txDb, true);
      if (plan.blockReason || !plan.anchor) {
        throw unprocessable(plan.blockReason ?? "Secret proposal not found", { code: "secret_proposal_not_approvable" });
      }
      let createdSecretId: string | null = null;
      if (plan.secret) {
        await input.assertCanResolve(plan.secret, txDb);
        for (const binding of plan.bindings) await input.assertCanResolve(binding, txDb);
        const created = await applySecretApproval(txDb, plan.secret, { resolvedByUserId: input.resolvedByUserId });
        await markApproved(txDb, plan.secret, {
          resolvedByUserId: input.resolvedByUserId,
          createdSecretId: created.id,
        });
        createdSecretId = created.id;
      } else {
        for (const binding of plan.bindings) await input.assertCanResolve(binding, txDb);
      }
      const bindingSecretId = createdSecretId ?? plan.approvedSecretId;
      const approvedBindings: Proposal[] = [];
      for (const binding of plan.bindings) {
        const liveSecret = bindingSecretId ? await secretService(txDb).getById(bindingSecretId) : null;
        if (!liveSecret || liveSecret.companyId !== companyId || liveSecret.status !== "active") {
          throw conflict("Binding proposal secret is not active");
        }
        await applyBindingApproval(txDb, binding, liveSecret, input.resolvedByUserId);
        approvedBindings.push(await markApproved(txDb, binding, {
          resolvedByUserId: input.resolvedByUserId,
          appliedBindingConfigPath: binding.configPath,
        }));
      }
      await logActivity(txDb, {
        companyId,
        actorType: "user",
        actorId: input.resolvedByUserId,
        action: "secret.proposal.card_approved",
        entityType: "company_secret_proposal",
        entityId: plan.anchor.id,
        agentId: plan.anchor.proposedByAgentId,
        runId: plan.anchor.originRunId,
        details: {
          interactionId: input.interactionId,
          issueId: plan.anchor.originIssueId,
          cascade: Boolean(plan.secret),
          secretProposalId: plan.secret?.id ?? null,
          createdSecretId,
          bindingProposalIds: approvedBindings.map((binding) => binding.id),
          configPaths: approvedBindings.map((binding) => binding.configPath),
        },
      });
      return {
        anchor: plan.anchor,
        secretProposal: plan.secret,
        bindings: approvedBindings,
        createdSecretId,
      };
    });
  }

  async function transition(companyId: string, proposalId: string, status: Exclude<SecretProposalTerminalStatus, "approved">, input: {
    resolvedByUserId?: string | null;
    reason?: string | null;
    proposerAgentId?: string | null;
  } = {}) {
    const proposal = await requirePending(companyId, proposalId);
    if (status === "withdrawn" && proposal.proposedByAgentId !== input.proposerAgentId) {
      throw forbidden("Only the proposer can withdraw this proposal");
    }
    const now = new Date();
    return db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const updated = await tx.update(companySecretProposals).set({
        status,
        resolvedByUserId: input.resolvedByUserId ?? null,
        resolvedAt: now,
        resolutionReason: input.reason ?? null,
        valueCiphertext: null,
        ciphertextScrubbedAt: now,
        updatedAt: now,
      }).where(and(eq(companySecretProposals.id, proposalId), eq(companySecretProposals.status, "pending")))
        .returning().then((rows) => rows[0] ?? null);
      if (!updated) throw conflict("Proposal is no longer pending");
      const dependents = proposal.kind === "secret" && (status === "rejected" || status === "expired" || status === "withdrawn")
        ? await tx.update(companySecretProposals).set({
            status: "rejected",
            resolvedByUserId: input.resolvedByUserId ?? null,
            resolvedAt: now,
            resolutionReason: `Dependent secret proposal ${proposal.id} was ${status}`,
            valueCiphertext: null,
            ciphertextScrubbedAt: now,
            updatedAt: now,
          }).where(and(
            eq(companySecretProposals.companyId, companyId),
            eq(companySecretProposals.status, "pending"),
            eq(companySecretProposals.secretProposalId, proposal.id),
          )).returning()
        : [];
      const actorType = input.resolvedByUserId ? "user" as const : status === "withdrawn" ? "agent" as const : "system" as const;
      const actorId = input.resolvedByUserId ?? input.proposerAgentId ?? "system";
      await logActivity(txDb, {
        companyId,
        actorType,
        actorId,
        action: `secret.proposal.${status}`,
        entityType: "company_secret_proposal",
        entityId: proposal.id,
        agentId: proposal.proposedByAgentId,
        runId: proposal.originRunId,
        details: { ciphertextScrubbed: true, issueId: proposal.originIssueId, reason: input.reason ?? null },
      });
      for (const dependent of dependents) {
        await logActivity(txDb, {
          companyId,
          actorType,
          actorId,
          action: "secret.proposal.rejected",
          entityType: "company_secret_proposal",
          entityId: dependent.id,
          agentId: dependent.proposedByAgentId,
          runId: dependent.originRunId,
          details: {
            ciphertextScrubbed: true,
            issueId: dependent.originIssueId,
            reason: dependent.resolutionReason,
            cascadeFromProposalId: proposal.id,
          },
        });
        await reflectProposalLifecycleOnInteraction(txDb, dependent, "rejected", {
          resolvedByUserId: input.resolvedByUserId,
          reason: dependent.resolutionReason,
        });
      }
      // Use the row returned by the guarded update: a concurrent binding
      // proposal may have linked this secret to its card after the pre-read.
      await reflectProposalLifecycleOnInteraction(txDb, updated, status, {
        resolvedByUserId: input.resolvedByUserId,
        reason: input.reason ?? (status === "expired" ? "Pending proposal expired" : null),
      });
      return updated;
    });
  }

  async function sweepExpired(
    now = new Date(),
    limit = DEFAULT_EXPIRY_SWEEP_LIMIT,
    expireProposal: (companyId: string, proposalId: string) => Promise<unknown> =
      (companyId, proposalId) => transition(companyId, proposalId, "expired", { reason: "Pending proposal expired" }),
  ) {
    const expired = await db.select({ id: companySecretProposals.id, companyId: companySecretProposals.companyId })
      .from(companySecretProposals)
      .where(and(eq(companySecretProposals.status, "pending"), lte(companySecretProposals.expiresAt, now)))
      .orderBy(companySecretProposals.expiresAt)
      .limit(limit);
    let expiredCount = 0;
    for (const proposal of expired) {
      try {
        await expireProposal(proposal.companyId, proposal.id);
        expiredCount += 1;
      } catch (error) {
        if (error instanceof HttpError && error.status === 409) continue;
        throw error;
      }
    }
    return expiredCount;
  }

  return {
    getById,
    view: enrich,
    createSecret,
    createBinding,
    listForAgent,
    listForBoard,
    assertBindingSnapshotCurrent,
    approve,
    planCardApproval,
    approveFromCard,
    transition,
    sweepExpired,
  };
}
