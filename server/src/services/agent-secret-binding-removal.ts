import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { agents, companySecretBindings, type Db } from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";
import { isPlainRecord } from "../lib/agent-records.js";
import { updateAgentConfigurationInTransaction } from "./agent-configuration-transaction.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";

export const AGENT_SECRET_BINDING_REMOVAL_SOURCE = "secret_binding_removal";

const ENV_CONFIG_PATH_RE = /^env\.[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Body of `POST /api/agents/:id/secret-bindings/remove`. Strict: an unknown
 * field fails the parse, and the route answers 422.
 */
export const removeAgentSecretBindingSchema = z.object({
  configPath: z.string().regex(ENV_CONFIG_PATH_RE, "configPath must be env.<KEY>"),
  secretId: z.string().guid(),
  bindingId: z.string().guid(),
  version: z.union([z.literal("latest"), z.number().int().positive()]),
}).strict();

export type RemoveAgentSecretBindingInput = z.infer<typeof removeAgentSecretBindingSchema>;

export type RemoveAgentSecretBindingActor = {
  actorType: "user" | "agent";
  actorId: string;
  agentId: string | null;
  userId: string | null;
  runId: string | null;
  agentApiKeyId: string | null;
};

const MISMATCH = "Secret binding does not match the agent's current configuration";

/**
 * Conditional removal of exactly one agent env secret binding.
 *
 * In one transaction, under the agent row lock:
 * 1. `adapterConfig.env[KEY]` must be a `secret_ref` with this `secretId` and
 *    `version` (an absent `version` reads as `"latest"`, the same default the
 *    binding sync uses).
 * 2. The `company_secret_bindings` row `bindingId` must belong to the agent's
 *    company, target this agent and carry this `configPath` and `secretId`.
 * 3. Any mismatch raises 409 and writes nothing.
 * 4. The next `adapterConfig` is the locked current config minus that one env
 *    leaf. It goes through the ordinary configuration update with
 *    `expectedConfiguration` set to the locked row, so the existing binding sync
 *    deletes exactly that binding row and the existing conflict check applies.
 *
 * A repeat call finds no matching leaf and raises 409.
 */
export async function removeAgentEnvSecretBinding(
  db: Db,
  agentId: string,
  input: RemoveAgentSecretBindingInput,
  actor: RemoveAgentSecretBindingActor,
) {
  const key = input.configPath.slice("env.".length);
  const publications: ActivityPublication[] = [];
  const updated = await db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const [current] = await txDb.select().from(agents).where(eq(agents.id, agentId)).for("no key update");
    if (!current) throw notFound("Agent not found");

    const adapterConfig = isPlainRecord(current.adapterConfig) ? current.adapterConfig : null;
    const env = adapterConfig && isPlainRecord(adapterConfig.env) ? adapterConfig.env : null;
    const leaf = env && Object.prototype.hasOwnProperty.call(env, key) ? env[key] : undefined;
    if (
      !adapterConfig || !env || !isPlainRecord(leaf)
      || leaf.type !== "secret_ref"
      || leaf.secretId !== input.secretId
      || (leaf.version ?? "latest") !== input.version
    ) {
      throw conflict(MISMATCH);
    }

    const [binding] = await txDb.select().from(companySecretBindings)
      .where(eq(companySecretBindings.id, input.bindingId)).for("update");
    if (
      !binding
      || binding.companyId !== current.companyId
      || binding.targetType !== "agent"
      || binding.targetId !== current.id
      || binding.configPath !== input.configPath
      || binding.secretId !== input.secretId
    ) {
      throw conflict(MISMATCH);
    }

    const { [key]: _removed, ...nextEnv } = env;
    const nextAdapterConfig = { ...adapterConfig, env: nextEnv };
    const result = await updateAgentConfigurationInTransaction(txDb, current.id, { adapterConfig: nextAdapterConfig }, {
      expectedConfiguration: {
        adapterType: current.adapterType,
        adapterConfig: current.adapterConfig,
        runtimeConfig: current.runtimeConfig,
        defaultEnvironmentId: current.defaultEnvironmentId,
      },
      recordRevision: {
        createdByAgentId: actor.agentId,
        createdByUserId: actor.userId,
        source: AGENT_SECRET_BINDING_REMOVAL_SOURCE,
      },
    });
    if (!result) throw notFound("Agent not found");

    // The binding sync must have deleted exactly this row. If it did not, roll
    // the whole change back rather than report a removal that did not happen.
    const [remaining] = await txDb.select({ id: companySecretBindings.id }).from(companySecretBindings)
      .where(and(eq(companySecretBindings.id, input.bindingId), eq(companySecretBindings.targetId, current.id)));
    if (remaining) throw conflict(MISMATCH);

    await logActivity(txDb, {
      companyId: current.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "agent.secret_binding_removed",
      entityType: "agent",
      entityId: current.id,
      details: { secretId: input.secretId, bindingId: input.bindingId, configPath: input.configPath },
    }, publications);
    return result;
  });
  for (const publication of publications) publishActivity(publication);
  return {
    agent: updated,
    removed: { secretId: input.secretId, bindingId: input.bindingId, configPath: input.configPath },
  };
}
