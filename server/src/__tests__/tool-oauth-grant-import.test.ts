import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  activityLog,
  agents,
  companies,
  companyMemberships,
  companySecretBindings,
  companySecrets,
  companySecretVersions,
  connectionGrants,
  createDb,
  secretAccessEvents,
  toolAccessAuditEvents,
  toolApplications,
  toolCallEvents,
  toolCatalogEntries,
  toolConnectionInstalls,
  toolConnections,
  toolInvocations,
  toolPolicies,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
  toolRuntimeSlots,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { secretService } from "../services/secrets.js";
import { writeConnectionCredential } from "../services/connection-credentials.js";
import { syncConnectionCredentialBindings } from "../services/connection-credential-bindings.js";
import { createOrganizationGrantStore } from "../services/tool-access/connections/organization-grant.js";
import { toolAccessService } from "../services/tool-access.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import {
  OAuthGrantImportError,
  importOAuthGrantConnection,
  isReadOnlyCatalogTool,
  parseOAuthGrantJson,
  scopeImportedConnectionToAgent,
} from "../services/tool-oauth-grant-import.js";
import { startOAuthRefreshFixture } from "../../../scripts/mcp-fixtures/servers/oauth-refresh-fixture.mjs";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const deps = { secretService, writeConnectionCredential, syncConnectionCredentialBindings, createOrganizationGrantStore };
const HTTP_FIXTURE = { allowHttpEndpoints: true };
// Buffer-shaped catalog: three reads plus the write tools the LinkedIn hold keeps off.
const BUFFER_LIKE_TOOLS = [
  { name: "get_account", description: "Read the account", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "list_channels", description: "List channels", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "list_posts", description: "List posts", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "create_post", description: "Create a post", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: false } },
  { name: "edit_post", description: "Edit a post", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: false } },
  { name: "delete_post", description: "Delete a post", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: false, destructiveHint: true } },
];

type Fixture = Awaited<ReturnType<typeof startOAuthRefreshFixture>>;

/** Mint a real rotating grant from the loopback fixture, outside Paperclip, like the approved member grant. */
async function mintGrant(fixture: Fixture, expiresAt?: string) {
  const issuer = fixture.issuer;
  const redirectUri = "http://127.0.0.1:9/callback";
  const registration = await fetch(`${issuer}/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], token_endpoint_auth_method: "none" }),
  }).then((response) => response.json() as Promise<{ client_id: string }>);
  const verifier = randomBytes(32).toString("base64url");
  const authorize = new URLSearchParams({
    client_id: registration.client_id, redirect_uri: redirectUri, response_type: "code", state: "s",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
    resource: fixture.mcpUrl, scope: "mcp:read offline_access", prompt: "consent", decision: "allow",
  });
  const consent = await fetch(`${issuer}/authorize`, { method: "POST", body: authorize, redirect: "manual" });
  const code = new URL(consent.headers.get("location")!).searchParams.get("code")!;
  const token = await fetch(`${issuer}/token`, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: registration.client_id, redirect_uri: redirectUri, resource: fixture.mcpUrl }),
  }).then((response) => response.json() as Promise<Record<string, unknown>>);
  expect(typeof token.refresh_token).toBe("string");
  return {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    client_id: registration.client_id,
    token_endpoint: `${issuer}/token`,
    resource: fixture.mcpUrl,
    scope: token.scope,
    token_type: token.token_type,
    expires_at: expiresAt ?? new Date(Date.now() + Number(token.expires_in) * 1000).toISOString(),
  };
}

const tokenEvents = (fixture: Fixture, grantType: string) =>
  fixture.events.filter((event: { kind: string; grantType?: string }) => event.kind === "token" && event.grantType === grantType).length;

describeEmbeddedPostgres("one-shot OAuth grant import into a shared MCP connection", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let fixture: Fixture | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tool-oauth-grant-import-");
    db = createDb(tempDb.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterEach(async () => {
    await fixture?.close();
    fixture = null;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await db.delete(toolCallEvents);
    await db.delete(toolInvocations);
    await db.delete(toolAccessAuditEvents);
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(toolPolicies);
    await db.delete(toolProfileBindings);
    await db.delete(toolProfileEntries);
    await db.delete(toolProfiles);
    await db.delete(toolRuntimeSlots);
    await db.delete(toolCatalogEntries);
    await db.delete(toolConnectionInstalls);
    await db.delete(connectionGrants);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function setup(options: { expired?: boolean } = {}) {
    fixture = await startOAuthRefreshFixture({ extraTools: BUFFER_LIKE_TOOLS });
    const [company] = await db.insert(companies).values({
      name: `Grant import ${randomUUID()}`, issuePrefix: `GI${randomUUID().slice(0, 6).toUpperCase()}`,
    }).returning();
    const [cmo, other] = await db.insert(agents).values([
      { companyId: company!.id, name: "CMO", role: "cmo", status: "active", adapterType: "process", adapterConfig: {}, runtimeConfig: {} },
      { companyId: company!.id, name: "Other", role: "engineer", status: "active", adapterType: "process", adapterConfig: {}, runtimeConfig: {} },
    ]).returning();
    const grant = await mintGrant(fixture, options.expired ? new Date(Date.now() - 60_000).toISOString() : undefined);
    if (options.expired) fixture.advanceTime(3_601_000); // The provider now rejects the saved access token.
    const source = await secretService(db).create(company!.id, {
      name: "BUFFER_AGENT_OAUTH", provider: "local_encrypted", value: JSON.stringify(grant),
    });
    const input = {
      companyId: company!.id, sourceSecretId: source.id, sourceSecretVersion: 1, provider: "buffer",
      applicationKey: "buffer-mcp", applicationName: "Buffer", connectionName: "Buffer (CMO only, read-only)",
      provenance: "test",
    };
    return { company: company!, cmo: cmo!, other: other!, grant, source, input };
  }

  it("parses the grant without ever echoing a value", () => {
    expect(() => parseOAuthGrantJson("{\"access_token\": \"super-secret-value")).toThrow(OAuthGrantImportError);
    try { parseOAuthGrantJson("{\"access_token\": \"super-secret-value"); } catch (error) {
      expect(String((error as Error).message)).not.toContain("super-secret-value");
    }
    try { parseOAuthGrantJson(JSON.stringify({ access_token: "super-secret-value" })); } catch (error) {
      expect((error as Error).message).toContain("refreshToken");
      expect((error as Error).message).toContain("access_token");
      expect((error as Error).message).not.toContain("super-secret-value");
    }
    expect(() => parseOAuthGrantJson(JSON.stringify({
      access_token: "a", refresh_token: "r", client_id: "c", token_endpoint: "http://auth.example/token",
      resource: "https://mcp.example/mcp", scope: "x", expires_at: "2026-11-24T09:38:27.770Z",
    }))).toThrow(/tokenUrl/);
  });

  it("classifies only read tools as enabled", () => {
    const tool = (toolName: string, overrides: Partial<{ riskLevel: string; isReadOnly: boolean; isWrite: boolean; isDestructive: boolean }> = {}) =>
      isReadOnlyCatalogTool({ toolName, riskLevel: "read", isReadOnly: true, isWrite: false, isDestructive: false, ...overrides });
    expect(["get_account", "list_channels", "list_posts", "get_post", "read_status"].every((name) => tool(name))).toBe(true);
    expect(["create_post", "edit_post", "delete_post", "schedule_post", "list_and_delete_posts", "get_or_create_idea", "publish_now"].some((name) => tool(name))).toBe(false);
    expect(tool("get_account", { riskLevel: "write", isWrite: true })).toBe(false);
  });

  it("imports into connection-owned secrets, refs, bindings and the default organization grant without any provider call", async () => {
    const { company, grant, source, input } = await setup();
    const tokensBefore = fixture!.events.filter((event: { kind: string }) => event.kind === "token").length;
    const result = await importOAuthGrantConnection(db, input, deps, HTTP_FIXTURE);

    expect(fixture!.events.filter((event: { kind: string }) => event.kind === "token")).toHaveLength(tokensBefore);
    expect(fixture!.events.some((event: { kind: string }) => event.kind.startsWith("mcp"))).toBe(false);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(String(grant.access_token));
    expect(serialized).not.toContain(String(grant.refresh_token));

    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, result.connectionId));
    expect(connection).toMatchObject({
      transport: "mcp_remote", authKind: "oauth", credentialPolicy: "shared", credentialSource: "paperclip_vault",
      status: "draft", enabled: false,
    });
    expect(connection!.config).toMatchObject({
      url: fixture!.mcpUrl,
      oauth: {
        provider: "buffer", tokenUrl: grant.token_endpoint, clientId: grant.client_id, clientRegistrationSource: "dcr",
        clientTokenEndpointAuthMethod: "none", resource: fixture!.mcpUrl, scope: grant.scope, expiresAt: grant.expires_at,
      },
      oauthImport: { sourceSecretId: source.id, sourceSecretVersion: 1 },
    });
    expect(JSON.stringify(connection)).not.toMatch(/fixture-(access|refresh)-/);
    expect(connection!.credentialSecretRefs.map((ref) => ref.configPath).sort()).toEqual(["oauth.access_token", "oauth.refresh_token"]);
    expect(connection!.credentialRefs).toEqual([expect.objectContaining({
      name: "oauth.access_token", placement: "header", key: "Authorization", prefix: "Bearer ", secretId: result.accessTokenSecretId,
    })]);

    const grants = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, result.connectionId));
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ id: result.organizationGrantId, kind: "organization", isDefault: true, status: "active" });
    expect(grants[0]!.credentialSecretRefs).toEqual(connection!.credentialSecretRefs);
    expect(result.bindingConfigPaths).toEqual(expect.arrayContaining(["oauth.access_token", "oauth.refresh_token"]));

    const secrets = secretService(db);
    for (const [id, expected] of [[result.accessTokenSecretId, grant.access_token], [result.refreshTokenSecretId, grant.refresh_token]] as const) {
      const [row] = await db.select().from(companySecrets).where(eq(companySecrets.id, id));
      expect(row).toMatchObject({ companyId: company.id, scope: "company", status: "active", managedMode: "paperclip_managed", latestVersion: 1 });
      await expect(secrets.resolveSecretValue(company.id, id, "latest")).resolves.toBe(expected);
    }
    // The archived original is left exactly as it was.
    const [original] = await db.select().from(companySecrets).where(eq(companySecrets.id, source.id));
    expect(original).toMatchObject({ latestVersion: 1, status: "active" });
    await expect(secrets.resolveSecretValue(company.id, source.id, 1)).resolves.toBe(JSON.stringify(grant));
  });

  it("refuses a second import, including after the connection is removed and when two imports race", async () => {
    const { input } = await setup();
    const [first, second] = await Promise.allSettled([
      importOAuthGrantConnection(db, input, deps, HTTP_FIXTURE),
      importOAuthGrantConnection(db, input, deps, HTTP_FIXTURE),
    ]);
    const outcomes = [first, second].map((outcome) => outcome.status);
    expect(outcomes.sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = [first, second].find((outcome) => outcome.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: expect.stringMatching(/grant_already_imported|connection_exists/) });
    expect(await db.select().from(toolConnections)).toHaveLength(1);

    await expect(importOAuthGrantConnection(db, { ...input, applicationKey: "buffer-other" }, deps, HTTP_FIXTURE))
      .rejects.toMatchObject({ code: "grant_already_imported" });
    // Even with the connection, its grant and application deleted, the source read marker remains.
    await db.delete(connectionGrants);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await expect(importOAuthGrantConnection(db, input, deps, HTTP_FIXTURE))
      .rejects.toMatchObject({ code: "grant_already_imported" });
  });

  it("refreshes an expired import exactly once through the deployed org-grant path, persisting the rotated refresh token first", async () => {
    const { company, input } = await setup({ expired: true });
    const result = await importOAuthGrantConnection(db, input, deps, HTTP_FIXTURE);
    const refreshVersion = async () => (await db.select({ v: companySecrets.latestVersion }).from(companySecrets)
      .where(eq(companySecrets.id, result.refreshTokenSecretId)))[0]!.v;
    const accessVersion = async () => (await db.select({ v: companySecrets.latestVersion }).from(companySecrets)
      .where(eq(companySecrets.id, result.accessTokenSecretId)))[0]!.v;

    // Capture the stored refresh-token version at the moment the new access token is first used.
    let refreshVersionWhenAccessUsed: Promise<number> | null = null;
    const push = fixture!.events.push.bind(fixture!.events);
    fixture!.events.push = (...items: Array<{ kind: string }>) => {
      if (!refreshVersionWhenAccessUsed && items.some((item) => item.kind === "mcp")) refreshVersionWhenAccessUsed = refreshVersion();
      return push(...items);
    };

    // Two independent service instances model two server processes: only the DB lease can dedupe them.
    const first = toolAccessService(db);
    const second = toolAccessService(db);
    const [a, b] = await Promise.all([first.refreshCatalog(result.connectionId), second.refreshCatalog(result.connectionId)]);
    expect(a.catalog.map((entry) => entry.toolName)).toContain("read_status");
    expect(b.catalog.map((entry) => entry.toolName)).toContain("read_status");
    expect(tokenEvents(fixture!, "refresh_token")).toBe(1);
    expect(await refreshVersionWhenAccessUsed).toBe(2);
    expect(await refreshVersion()).toBe(2);
    expect(await accessVersion()).toBe(2);

    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, result.organizationGrantId));
    expect(grant!.status).toBe("active");
    const grantExpiry = Date.parse(String(grant!.providerTenant?.oauth?.accessTokenExpiresAt));
    expect(grantExpiry).toBeGreaterThan(Date.now() + 30 * 60_000);
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, result.connectionId));
    // The grant's expiry governs refresh. Catalog publication writes back its
    // pre-refresh config snapshot, so the connection-level copy can lag.
    expect(connection!.credentialSecretRefs.map((ref) => ref.secretId).sort())
      .toEqual([result.accessTokenSecretId, result.refreshTokenSecretId].sort());
    expect(JSON.stringify([grant, connection])).not.toMatch(/fixture-(access|refresh)-/);

    // The next resolve uses the stored pair with no second refresh.
    await expect(toolAccessService(db).refreshCatalog(result.connectionId)).resolves.toBeTruthy();
    expect(tokenEvents(fixture!, "refresh_token")).toBe(1);

    // A later expiry spends the stored rotated refresh token; the fixture rejects reuse of any spent one.
    fixture!.advanceTime(3_601_000);
    const expiredAt = new Date(Date.now() - 1000).toISOString();
    await db.update(connectionGrants).set({
      providerTenant: { ...grant!.providerTenant, oauth: { ...grant!.providerTenant?.oauth, accessTokenExpiresAt: expiredAt } },
    }).where(eq(connectionGrants.id, grant!.id));
    await expect(toolAccessService(db).refreshCatalog(result.connectionId)).resolves.toBeTruthy();
    expect(tokenEvents(fixture!, "refresh_token")).toBe(2);
    expect(await refreshVersion()).toBe(3);
    const [afterSecond] = await db.select().from(connectionGrants).where(and(eq(connectionGrants.id, grant!.id), eq(connectionGrants.companyId, company.id)));
    expect(afterSecond!.status).toBe("active");
  });

  it("scopes the imported connection to one agent with read tools only, and the agent call path works after refresh", async () => {
    const { company, cmo, other, input } = await setup({ expired: true });
    const result = await importOAuthGrantConnection(db, input, deps, HTTP_FIXTURE);
    const instructions = "Use only Buffer organisation 6b04696357cb462b766c6739. Never read 6b054b0ca84a726db4f0a7a6.";
    const scoped = await scopeImportedConnectionToAgent(db, {
      companyId: company.id, connectionId: result.connectionId, agentId: cmo.id, agentInstructions: instructions,
    }, { toolAccess: toolAccessService(db) });

    expect(tokenEvents(fixture!, "refresh_token")).toBe(1);
    expect(scoped).toMatchObject({ status: "active", enabled: true });
    expect(scoped.installs).toEqual([{ targetType: "agent", targetId: cmo.id }]);
    expect(scoped.profileBindings).toEqual([{ targetType: "agent", targetId: cmo.id }]);
    expect(scoped.enabledTools).toEqual(["get_account", "list_channels", "list_posts", "read_status"]);
    expect(scoped.disabledTools).toEqual(["create_post", "delete_post", "edit_post"]);
    expect(scoped.secretLatestVersions).toEqual({ "oauth.access_token": 2, "oauth.refresh_token": 2 });
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, result.connectionId));
    expect(connection!.agentInstructions).toEqual({ enabled: true, text: instructions });
    const companyBindings = await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.targetType, "company"));
    expect(companyBindings).toHaveLength(0);

    const gateway = createToolGatewayService(db);
    const call = (agentId: string, toolName: string) => gateway.executeTestCall({
      companyId: company.id, connectionId: result.connectionId, agentId, userId: "board-user", toolName, parameters: {},
    });
    await expect(call(cmo.id, "read_status")).resolves.toMatchObject({ decision: "allowed" });
    await expect(call(cmo.id, "create_post").then((r) => r.decision, () => "rejected")).resolves.not.toBe("allowed");
    await expect(call(other.id, "read_status").then((r) => r.decision, () => "rejected")).resolves.not.toBe("allowed");
    expect(tokenEvents(fixture!, "refresh_token")).toBe(1);
  });
});
