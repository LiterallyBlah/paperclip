import { randomUUID } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companySecretBindings,
  companySecrets,
  connectionGrants,
  secretAccessEvents,
  toolApplications,
  toolCatalogEntries,
  toolConnectionInstalls,
  toolConnections,
  toolProfileBindings,
  toolProfiles,
} from "@paperclipai/db";
import type { McpConnectionCredentialRef, ToolCredentialSecretRef } from "@paperclipai/shared";
import type { secretService as SecretServiceFactory } from "./secrets.js";
import type { writeConnectionCredential as WriteConnectionCredential } from "./connection-credentials.js";
import type { syncConnectionCredentialBindings as SyncConnectionCredentialBindings } from "./connection-credential-bindings.js";
import type { createOrganizationGrantStore as CreateOrganizationGrantStore } from "./tool-access/connections/organization-grant.js";
import type { toolAccessService as ToolAccessServiceFactory } from "./tool-access.js";

/**
 * One-shot operator import of an already-approved OAuth grant (a JSON company
 * secret holding an access/refresh pair) into a Paperclip-managed shared
 * `mcp_remote` connection.
 *
 * The import never calls a token endpoint or the provider. It only moves the
 * saved pair into the same connection-owned secrets, refs, bindings and default
 * organization grant that a browser OAuth callback writes, so the deployed
 * refresher owns every later rotation. A rotating refresh token is single-use,
 * so a second import of the same source must be impossible: the import refuses
 * when any earlier import of the source is recorded, and records its own source
 * read inside the same transaction that creates the connection.
 *
 * Callers inject the server modules, so an operator can run this file against
 * a deployed release's own `dist` modules instead of a separate build.
 */

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export const OAUTH_GRANT_IMPORT_CONFIG_PATH = "oauth_grant_import.source";

export type OAuthGrantImportDependencies = {
  secretService: typeof SecretServiceFactory;
  writeConnectionCredential: typeof WriteConnectionCredential;
  syncConnectionCredentialBindings: typeof SyncConnectionCredentialBindings;
  createOrganizationGrantStore: typeof CreateOrganizationGrantStore;
};

export type OAuthGrantImportInput = {
  companyId: string;
  sourceSecretId: string;
  sourceSecretVersion: number;
  provider: string;
  applicationKey: string;
  applicationName: string;
  connectionName: string;
  /** When set, the grant's `resource` must equal this MCP URL exactly. */
  expectedResource?: string | null;
  /** Free-text provenance stored with the import marker, e.g. a task key. */
  provenance?: string | null;
  now?: () => Date;
};

/** Everything the import wrote, without any credential value. */
export type OAuthGrantImportResult = {
  applicationId: string;
  connectionId: string;
  organizationGrantId: string;
  accessTokenSecretId: string;
  refreshTokenSecretId: string;
  config: Record<string, unknown>;
  credentialSecretRefs: ToolCredentialSecretRef[];
  credentialRefs: McpConnectionCredentialRef[];
  bindingConfigPaths: string[];
};

export class OAuthGrantImportError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "OAuthGrantImportError";
  }
}

type ParsedGrant = {
  accessToken: string;
  refreshToken: string;
  clientId: string;
  tokenUrl: string;
  resource: string;
  scope: string;
  scopes: string[];
  expiresAt: string;
  tokenType: string | null;
  issuer: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function httpsUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Parse the saved grant JSON. Errors name only the missing logical fields and
 * the key names present, never a value: JSON.parse messages can quote input.
 */
export function parseOAuthGrantJson(raw: string, options: { allowHttpEndpoints?: boolean } = {}): ParsedGrant {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OAuthGrantImportError("The source secret is not valid JSON", "grant_json_invalid");
  }
  const record = asRecord(parsed);
  if (!record) throw new OAuthGrantImportError("The source secret JSON is not an object", "grant_json_invalid");
  const endpoint = (value: string | null) => {
    if (!options.allowHttpEndpoints) return httpsUrl(value);
    if (!value) return null;
    try {
      const url = new URL(value);
      return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
    } catch {
      return null;
    }
  };
  const scopeValue = record.scope ?? record.scopes;
  const scopes = Array.isArray(scopeValue)
    ? scopeValue.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim())
    : typeof scopeValue === "string"
      ? scopeValue.split(/\s+/).filter(Boolean)
      : [];
  const expiresAtRaw = firstString(record, ["expires_at", "expiresAt", "expiry", "access_token_expires_at", "accessTokenExpiresAt"]);
  const expiresAtMs = expiresAtRaw ? Date.parse(expiresAtRaw) : Number.NaN;
  const grant = {
    accessToken: firstString(record, ["access_token", "accessToken"]),
    refreshToken: firstString(record, ["refresh_token", "refreshToken"]),
    clientId: firstString(record, ["client_id", "clientId"]),
    tokenUrl: endpoint(firstString(record, ["token_endpoint", "tokenEndpoint", "token_url", "tokenUrl"])),
    resource: endpoint(firstString(record, ["resource", "mcp_url", "mcpUrl"])),
    expiresAt: Number.isFinite(expiresAtMs) ? new Date(expiresAtMs).toISOString() : null,
  };
  const missing = Object.entries(grant).filter(([, value]) => !value).map(([key]) => key);
  if (scopes.length === 0) missing.push("scope");
  if (missing.length > 0) {
    throw new OAuthGrantImportError(
      `The source grant is missing or has invalid fields: ${missing.join(", ")} (present keys: ${Object.keys(record).sort().join(", ")})`,
      "grant_fields_missing",
    );
  }
  return {
    accessToken: grant.accessToken!,
    refreshToken: grant.refreshToken!,
    clientId: grant.clientId!,
    tokenUrl: grant.tokenUrl!,
    resource: grant.resource!,
    scopes,
    scope: scopes.join(" "),
    expiresAt: grant.expiresAt!,
    tokenType: firstString(record, ["token_type", "tokenType"]),
    issuer: endpoint(firstString(record, ["issuer"])),
  };
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "connection";
}

async function assertNotImported(tx: DbTransaction, input: OAuthGrantImportInput) {
  // Durable across connection removal: the source read is recorded on the
  // source secret, which this import never changes or deletes.
  const [priorRead] = await tx
    .select({ id: secretAccessEvents.id })
    .from(secretAccessEvents)
    .where(and(
      eq(secretAccessEvents.companyId, input.companyId),
      eq(secretAccessEvents.secretId, input.sourceSecretId),
      eq(secretAccessEvents.configPath, OAUTH_GRANT_IMPORT_CONFIG_PATH),
      eq(secretAccessEvents.outcome, "success"),
    ))
    .limit(1);
  if (priorRead) {
    throw new OAuthGrantImportError("This grant was already imported; a second import could replay its single-use refresh token", "grant_already_imported");
  }
  const [marked] = await tx
    .select({ id: toolConnections.id })
    .from(toolConnections)
    .where(and(
      eq(toolConnections.companyId, input.companyId),
      sql`${toolConnections.config} -> 'oauthImport' ->> 'sourceSecretId' = ${input.sourceSecretId}`,
    ))
    .limit(1);
  if (marked) {
    throw new OAuthGrantImportError(`This grant was already imported into connection ${marked.id}`, "grant_already_imported");
  }
  const [application] = await tx
    .select({ id: toolApplications.id })
    .from(toolApplications)
    .where(and(eq(toolApplications.companyId, input.companyId), eq(toolApplications.applicationKey, input.applicationKey)))
    .limit(1);
  if (application) {
    throw new OAuthGrantImportError(`Application ${input.applicationKey} already exists (${application.id})`, "connection_exists");
  }
}

async function assertNoConnectionForUrl(tx: DbTransaction, input: OAuthGrantImportInput, resource: string) {
  {
    const [sameUrl] = await tx
      .select({ id: toolConnections.id })
      .from(toolConnections)
      .where(and(
        eq(toolConnections.companyId, input.companyId),
        ne(toolConnections.status, "archived"),
        sql`${toolConnections.config} ->> 'url' = ${resource}`,
      ))
      .limit(1);
    if (sameUrl) {
      throw new OAuthGrantImportError(`A connection to this MCP URL already exists (${sameUrl.id})`, "connection_exists");
    }
  }
}

export async function importOAuthGrantConnection(
  db: Db,
  input: OAuthGrantImportInput,
  deps: OAuthGrantImportDependencies,
  options: { allowHttpEndpoints?: boolean } = {},
): Promise<OAuthGrantImportResult> {
  const now = input.now ?? (() => new Date());
  return db.transaction(async (tx) => {
    // Serialize imports of the same source across processes.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`tool-oauth-grant-import:${input.sourceSecretId}`}))`);
    await assertNotImported(tx, input);

    const [source] = await tx
      .select({ id: companySecrets.id, companyId: companySecrets.companyId, scope: companySecrets.scope, status: companySecrets.status, latestVersion: companySecrets.latestVersion })
      .from(companySecrets)
      .where(and(eq(companySecrets.id, input.sourceSecretId), eq(companySecrets.companyId, input.companyId)))
      .limit(1);
    if (!source) throw new OAuthGrantImportError("The source secret was not found in this company", "source_missing");
    if (source.scope !== "company" || source.status !== "active") {
      throw new OAuthGrantImportError("The source secret must be an active company secret", "source_invalid");
    }

    const connectionId = randomUUID();
    const txSecrets = deps.secretService(tx);
    const raw = await txSecrets.resolveSecretValue(input.companyId, input.sourceSecretId, input.sourceSecretVersion, {
      accessContext: {
        consumerType: "tool_connection",
        consumerId: connectionId,
        configPath: OAUTH_GRANT_IMPORT_CONFIG_PATH,
        actorType: "system",
        actorId: null,
      },
    });
    // The secret service records this read; make sure the durable one-shot
    // marker exists even if that recording changes, in this same transaction.
    const [recorded] = await tx
      .select({ id: secretAccessEvents.id })
      .from(secretAccessEvents)
      .where(and(
        eq(secretAccessEvents.secretId, input.sourceSecretId),
        eq(secretAccessEvents.configPath, OAUTH_GRANT_IMPORT_CONFIG_PATH),
        eq(secretAccessEvents.consumerId, connectionId),
        eq(secretAccessEvents.outcome, "success"),
      ))
      .limit(1);
    if (!recorded) {
      await tx.insert(secretAccessEvents).values({
        companyId: input.companyId,
        secretId: input.sourceSecretId,
        version: input.sourceSecretVersion,
        provider: "local_encrypted",
        actorType: "system",
        consumerType: "tool_connection",
        consumerId: connectionId,
        configPath: OAUTH_GRANT_IMPORT_CONFIG_PATH,
        outcome: "success",
      });
    }
    const grant = parseOAuthGrantJson(raw, options);
    if (input.expectedResource && grant.resource !== new URL(input.expectedResource).toString()) {
      throw new OAuthGrantImportError("The grant resource does not match the expected MCP URL", "resource_mismatch");
    }
    await assertNoConnectionForUrl(tx, input, grant.resource);

    const importedAt = now().toISOString();
    const [application] = await tx
      .insert(toolApplications)
      .values({
        companyId: input.companyId,
        applicationKey: input.applicationKey,
        name: input.applicationName,
        type: "mcp_http",
        status: "active",
        metadata: { source: "tool_oauth_grant_import" },
      })
      .returning();

    const oauth = {
      provider: input.provider,
      tokenUrl: grant.tokenUrl,
      clientId: grant.clientId,
      clientRegistrationSource: "dcr",
      clientTokenEndpointAuthMethod: "none",
      grantType: "authorization_code",
      issuer: grant.issuer,
      resource: grant.resource,
      scopes: grant.scopes,
      scope: grant.scope,
      tokenType: grant.tokenType,
      expiresAt: grant.expiresAt,
      connectedAt: importedAt,
    };
    const config: Record<string, unknown> = {
      url: grant.resource,
      oauth,
      providerMetadata: {
        oauth: {
          expiresAt: grant.expiresAt,
          scope: grant.scope,
          scopeSource: "provider",
          unrequestedScopes: [],
          tokenType: grant.tokenType,
        },
      },
      oauthImport: {
        sourceSecretId: input.sourceSecretId,
        sourceSecretVersion: input.sourceSecretVersion,
        importedAt,
        provenance: input.provenance ?? null,
      },
    };
    const [inserted] = await tx
      .insert(toolConnections)
      .values({
        id: connectionId,
        companyId: input.companyId,
        applicationId: application!.id,
        name: input.connectionName,
        uid: `${input.applicationKey}/${slug(input.connectionName)}-${connectionId.slice(0, 8)}`,
        connectionKind: "managed",
        connectionPurpose: "tool",
        ownership: "customer",
        transport: "mcp_remote",
        authKind: "oauth",
        credentialSource: "paperclip_vault",
        credentialPolicy: "shared",
        // Draft until the agent-scoped finish step: an active connection's first
        // catalog refresh would otherwise create a company-wide access profile.
        status: "draft",
        enabled: false,
        config,
        transportConfig: config,
        credentialRefs: [],
        credentialSecretRefs: [],
      })
      .returning();

    // The same connection-credential writer the deployed callback and refresher use.
    const writeRef = async (configPath: "oauth.access_token" | "oauth.refresh_token", label: string, value: string) => {
      const { secret } = await deps.writeConnectionCredential(tx, {
        companyId: input.companyId,
        connectionName: inserted!.name,
        configPath,
        label,
        value,
      });
      return {
        secretId: secret.id,
        versionSelector: "latest" as const,
        configPath,
        required: configPath === "oauth.access_token",
        label,
      } satisfies ToolCredentialSecretRef;
    };
    // Refresh token first, matching the refresher's write order.
    const refreshRef = await writeRef("oauth.refresh_token", "OAuth refresh token", grant.refreshToken);
    const accessRef = await writeRef("oauth.access_token", "OAuth access token", grant.accessToken);
    const credentialSecretRefs = [accessRef, refreshRef];
    const credentialRefs: McpConnectionCredentialRef[] = [{
      name: "oauth.access_token",
      secretId: accessRef.secretId,
      version: "latest",
      placement: "header",
      key: "Authorization",
      prefix: "Bearer ",
    }];
    const [connection] = await tx
      .update(toolConnections)
      .set({ credentialSecretRefs, credentialRefs, updatedAt: now() })
      .where(eq(toolConnections.id, connectionId))
      .returning();

    const ensureDefaultOrganizationGrant = deps.createOrganizationGrantStore(db);
    await ensureDefaultOrganizationGrant(connection!, tx, undefined, {
      scopes: grant.scopes,
      scopeSource: "provider",
      unrequestedScopes: [],
      requestedScopes: grant.scopes,
    });
    await deps.syncConnectionCredentialBindings(tx, connection!, [], tx);

    const [organizationGrant] = await tx
      .select()
      .from(connectionGrants)
      .where(and(
        eq(connectionGrants.companyId, input.companyId),
        eq(connectionGrants.connectionId, connectionId),
        eq(connectionGrants.kind, "organization"),
        eq(connectionGrants.isDefault, true),
      ))
      .limit(1);
    if (!organizationGrant || organizationGrant.status !== "active"
      || organizationGrant.credentialSecretRefs.length !== 2) {
      throw new OAuthGrantImportError("The default organization grant was not created with both credentials", "grant_projection_failed");
    }
    const bindingConfigPaths = (await tx
      .select({ configPath: companySecretBindings.configPath })
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, input.companyId),
        eq(companySecretBindings.targetType, "tool_connection"),
        eq(companySecretBindings.targetId, connectionId),
      )))
      .map((row) => row.configPath)
      .sort();

    return {
      applicationId: application!.id,
      connectionId,
      organizationGrantId: organizationGrant.id,
      accessTokenSecretId: accessRef.secretId,
      refreshTokenSecretId: refreshRef.secretId,
      config,
      credentialSecretRefs,
      credentialRefs,
      bindingConfigPaths,
    };
  });
}

/** Tool names that read only. Anything that might create, change or send stays off. */
const READ_TOOL_NAME = /^(get|list|read|search|fetch|find|view|describe)[_-]/i;
const WRITE_TOOL_WORD = /(create|update|edit|delete|remove|schedule|publish|post_now|send|add|share|draft|approve|reorder|move|set|write|upload)/i;

export function isReadOnlyCatalogTool(entry: {
  toolName: string;
  riskLevel: string;
  isReadOnly: boolean;
  isWrite: boolean;
  isDestructive: boolean;
}) {
  return entry.riskLevel === "read" && entry.isReadOnly && !entry.isWrite && !entry.isDestructive
    && READ_TOOL_NAME.test(entry.toolName) && !WRITE_TOOL_WORD.test(entry.toolName.replace(READ_TOOL_NAME, ""));
}

export type ImportedConnectionAgentScopeInput = {
  companyId: string;
  connectionId: string;
  agentId: string;
  agentInstructions: string;
};

export type ImportedConnectionAgentScopeResult = {
  connectionId: string;
  status: string;
  enabled: boolean;
  installs: Array<{ targetType: string; targetId: string }>;
  profileBindings: Array<{ targetType: string; targetId: string }>;
  enabledTools: string[];
  disabledTools: string[];
  organizationGrant: { id: string; status: string; accessTokenExpiresAt: string | null; refreshedAt: string | null };
  connectionExpiresAt: string | null;
  secretLatestVersions: Record<string, number>;
};

/**
 * Publish the imported connection to exactly one agent, read tools only.
 * The catalog refresh runs the deployed credential path, so an expired
 * imported access token gets its first refresh there, under the DB lease.
 */
export async function scopeImportedConnectionToAgent(
  db: Db,
  input: ImportedConnectionAgentScopeInput,
  deps: { toolAccess: ReturnType<typeof ToolAccessServiceFactory> },
): Promise<ImportedConnectionAgentScopeResult> {
  const [connection] = await db
    .select()
    .from(toolConnections)
    .where(and(eq(toolConnections.id, input.connectionId), eq(toolConnections.companyId, input.companyId)))
    .limit(1);
  if (!connection) throw new OAuthGrantImportError("Connection not found", "connection_missing");
  if (!asRecord(connection.config.oauthImport)) {
    throw new OAuthGrantImportError("Only an imported OAuth connection can be scoped by this helper", "connection_not_imported");
  }
  const priorInstalls = await db.select().from(toolConnectionInstalls)
    .where(and(eq(toolConnectionInstalls.companyId, input.companyId), eq(toolConnectionInstalls.connectionId, connection.id)));
  if (priorInstalls.some((install) => install.targetType !== "agent" || install.targetId !== input.agentId)) {
    throw new OAuthGrantImportError("The connection is already installed for another target", "unexpected_install");
  }

  const refreshed = await deps.toolAccess.refreshCatalog(connection.id);
  const entries = await db.select().from(toolCatalogEntries)
    .where(and(eq(toolCatalogEntries.companyId, input.companyId), eq(toolCatalogEntries.connectionId, connection.id)));
  const live = entries.filter((entry) => entry.status !== "disabled" && entry.status !== "removed");
  const enabled = live.filter(isReadOnlyCatalogTool);
  const quarantined = live.filter((entry) => entry.status === "quarantined");
  void refreshed;

  await deps.toolAccess.finishGalleryAppConnection(input.companyId, connection.id, {
    enabledCatalogEntryIds: enabled.map((entry) => entry.id),
    askFirstCatalogEntryIds: [],
    ...(quarantined.length > 0 ? { reviewedCatalogEntryIds: quarantined.map((entry) => entry.id) } : {}),
    access: { agentIds: [input.agentId] },
    agentInstructions: { enabled: true, text: input.agentInstructions },
  });
  await db.insert(toolConnectionInstalls).values({
    companyId: input.companyId,
    connectionId: connection.id,
    targetType: "agent",
    targetId: input.agentId,
  }).onConflictDoNothing();

  const [after] = await db.select().from(toolConnections).where(eq(toolConnections.id, connection.id)).limit(1);
  const installs = await db.select({ targetType: toolConnectionInstalls.targetType, targetId: toolConnectionInstalls.targetId })
    .from(toolConnectionInstalls)
    .where(and(eq(toolConnectionInstalls.companyId, input.companyId), eq(toolConnectionInstalls.connectionId, connection.id)));
  const [profile] = await db.select({ id: toolProfiles.id }).from(toolProfiles)
    .where(and(eq(toolProfiles.companyId, input.companyId), eq(toolProfiles.profileKey, `app:${connection.id}`))).limit(1);
  const profileBindings = profile
    ? await db.select({ targetType: toolProfileBindings.targetType, targetId: toolProfileBindings.targetId })
      .from(toolProfileBindings).where(eq(toolProfileBindings.profileId, profile.id))
    : [];
  const [grant] = await db.select().from(connectionGrants).where(and(
    eq(connectionGrants.companyId, input.companyId), eq(connectionGrants.connectionId, connection.id),
    eq(connectionGrants.kind, "organization"), eq(connectionGrants.isDefault, true),
  )).limit(1);
  const grantOauth = asRecord(asRecord(grant?.providerTenant)?.oauth) ?? {};
  const secretLatestVersions: Record<string, number> = {};
  for (const ref of grant?.credentialSecretRefs ?? []) {
    const [secret] = await db.select({ latestVersion: companySecrets.latestVersion }).from(companySecrets)
      .where(eq(companySecrets.id, ref.secretId)).limit(1);
    if (secret) secretLatestVersions[ref.configPath] = secret.latestVersion;
  }
  const enabledIds = new Set(enabled.map((entry) => entry.id));
  return {
    connectionId: connection.id,
    status: after!.status,
    enabled: after!.enabled,
    installs,
    profileBindings,
    enabledTools: enabled.map((entry) => entry.toolName).sort(),
    disabledTools: live.filter((entry) => !enabledIds.has(entry.id)).map((entry) => entry.toolName).sort(),
    organizationGrant: {
      id: grant!.id,
      status: grant!.status,
      accessTokenExpiresAt: typeof grantOauth.accessTokenExpiresAt === "string" ? grantOauth.accessTokenExpiresAt : null,
      refreshedAt: typeof grantOauth.refreshedAt === "string" ? grantOauth.refreshedAt : null,
    },
    connectionExpiresAt: typeof asRecord(after!.config.oauth)?.expiresAt === "string" ? asRecord(after!.config.oauth)!.expiresAt as string : null,
    secretLatestVersions,
  };
}
