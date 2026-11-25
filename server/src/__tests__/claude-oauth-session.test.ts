// BLA-5403: Claude subscription runs receive only a short-lived access token.
// The refresh token stays in the server's secret store. Claude Code is replaced
// by a test double: an in-process refresher for the service tests, and a fake
// `claude` executable for the real spawn path.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { agents, companies, companyMemberships, companySecrets, connectionGrants, createDb, secretAccessEvents } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";

vi.mock("../services/subscription-refresh.js", () => ({ refreshSubscriptionConnection: vi.fn().mockResolvedValue(undefined) }));

import { aiConnectionService, setClaudeSessionRefresherForTests } from "../services/ai-connections.js";
import { AI_AUTH_ENV_KEYS, prepareManagedAiRuntime } from "../services/ai-connection-runtime.js";
import {
  CLAUDE_ISSUED_TOKEN_MAX_LIFETIME_MS, claudeSessionMinRemainingMs, parseClaudeOAuthSession,
  refreshClaudeOAuthSessionWithCli, type ClaudeOAuthSession,
} from "../services/claude-oauth-session.js";
import { readVerifiedLocalAiCredential } from "../services/local-ai-credentials.js";
import { secretService } from "../services/secrets.js";

const HOUR = 60 * 60 * 1000;
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;
const companyId = randomUUID();
const agentId = randomUUID();

function session(accessToken: string, refreshToken: string, expiresInMs: number): ClaudeOAuthSession {
  return { claudeAiOauth: { accessToken, refreshToken, expiresAt: Date.now() + expiresInMs, scopes: ["user:inference", "user:profile"], subscriptionType: "max" } };
}
async function member(prefix: string) {
  const userId = `${prefix}-${randomUUID()}`;
  await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
  return userId;
}
async function connect(userId: string, value: string, provider: "anthropic" | "openai" = "anthropic") {
  return aiConnectionService(db).save(companyId, userId, { provider, method: "subscription", ownership: "personal", name: `Claude ${userId}`, loginSessionId: "fixture", agentIds: [], allAgents: true }, value);
}
async function storedSecret(grantId: string) {
  const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, grantId));
  const ref = grant!.credentialSecretRefs.find(r => r.configPath === "ai.credential")!;
  const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.id, ref.secretId));
  return secret!;
}
async function selection(userId: string, grantId: string) {
  const row = await aiConnectionService(db).select({ companyId, userId, agentId, adapterType: "claude_local", binding: { provider: "anthropic", method: "subscription", mode: "responsible_user" } });
  expect(row.grant.id).toBe(grantId);
  return row;
}
const runtimeInput = (responsibleUserId: string, config: Record<string, unknown> = {}) => ({
  companyId, agentId, adapterType: "claude_local", responsibleUserId,
  binding: { provider: "anthropic", method: "subscription", mode: "responsible_user" } as const,
  config: { env: {}, ...config },
});
async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...await listFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

beforeAll(async () => {
  home = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-session-")));
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "claude-session-fixture");
  database = await startEmbeddedPostgresTestDatabase("paperclip-claude-session-db-");
  db = createDb(database.connectionString);
  await db.insert(companies).values({ id: companyId, name: "Claude session tests", issuePrefix: "CST" });
  await db.insert(agents).values({ id: agentId, companyId, name: "Nova", adapterType: "claude_local" });
}, 90_000);
afterEach(() => setClaudeSessionRefresherForTests());
afterAll(async () => { await database?.cleanup(); vi.unstubAllEnvs(); if (home) await rm(home, { recursive: true, force: true }); });

describe("Claude OAuth session connections", () => {
  it("(a, b) gives a run only a short-lived access token and keeps the refresh token out of its env and home", async () => {
    const userId = await member("fresh");
    const refreshToken = `sk-ant-ort01-${randomUUID()}`;
    const account = await connect(userId, JSON.stringify(session("access-fresh", refreshToken, 8 * HOUR)));
    const refresher = vi.fn();
    setClaudeSessionRefresherForTests(refresher);
    const list = await aiConnectionService(db).list(companyId, userId);
    expect(list.find(c => c.grantId === account.grantId)?.credentialKind).toBe("oauth_session");
    const runtime = await prepareManagedAiRuntime(db, runtimeInput(userId));
    try {
      const env = runtime.config.env as Record<string, string>;
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("access-fresh");
      const stored = parseClaudeOAuthSession(await readSecretValue(account.grantId))!;
      expect(stored.claudeAiOauth.expiresAt - Date.now()).toBeLessThanOrEqual(CLAUDE_ISSUED_TOKEN_MAX_LIFETIME_MS);
      expect(JSON.stringify(runtime.config)).not.toContain(refreshToken);
      for (const file of await listFiles(env.HOME)) expect(await readFile(file, "utf8")).not.toContain(refreshToken);
      // The issued token is a run secret, so run logs redact it.
      expect(AI_AUTH_ENV_KEYS).toContain("CLAUDE_CODE_OAUTH_TOKEN");
      expect(refresher).not.toHaveBeenCalled();
    } finally { await runtime.cleanup(); }
  });

  it("(a) refuses to issue an access token with more than 12 hours of life", async () => {
    const userId = await member("long");
    const account = await connect(userId, JSON.stringify(session("access-long", "refresh-long", 13 * HOUR)));
    await expect(aiConnectionService(db).runtimeCredential(await selection(userId, account.grantId)))
      .rejects.toMatchObject({ message: "Reconnect this AI account", details: { code: "ai_connection_credential_not_short_lived" } });
  });

  it("(c, f) refreshes a near-expiry session once, saves a new secret version and records each secret read", async () => {
    const userId = await member("near");
    const account = await connect(userId, JSON.stringify(session("access-old", "refresh-old", 20 * 60 * 1000)));
    const before = await storedSecret(account.grantId);
    const refresher = vi.fn(async (current: ClaudeOAuthSession) => {
      expect(current.claudeAiOauth.refreshToken).toBe("refresh-old");
      return session("access-new", "refresh-new", 8 * HOUR);
    });
    setClaudeSessionRefresherForTests(refresher);
    const events = async () => (await db.select().from(secretAccessEvents).where(and(eq(secretAccessEvents.companyId, companyId), eq(secretAccessEvents.secretId, before.id)))).length;
    const eventsBefore = await events();
    const runtime = await prepareManagedAiRuntime(db, runtimeInput(userId, { timeoutSec: 1800 }));
    try {
      expect((runtime.config.env as Record<string, string>).CLAUDE_CODE_OAUTH_TOKEN).toBe("access-new");
    } finally { await runtime.cleanup(); }
    expect(refresher).toHaveBeenCalledTimes(1);
    const after = await storedSecret(account.grantId);
    expect(after.latestVersion).toBe(before.latestVersion + 1);
    const stored = parseClaudeOAuthSession(await readSecretValue(account.grantId))!;
    expect(stored.claudeAiOauth).toMatchObject({ accessToken: "access-new", refreshToken: "refresh-new" });
    expect(await events()).toBeGreaterThan(eventsBefore);
    // Each later resolution, without a refresh, still writes an access event.
    const countBefore = await events();
    await aiConnectionService(db).runtimeCredential(await selection(userId, account.grantId));
    expect(await events()).toBe(countBefore + 1);
    expect(refresher).toHaveBeenCalledTimes(1);
  });

  it("(d) runs one refresh for concurrent resolutions and gives both the same token", async () => {
    const userId = await member("concurrent");
    const account = await connect(userId, JSON.stringify(session("access-stale", "refresh-stale", 5 * 60 * 1000)));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const refresher = vi.fn(async () => { await gate; return session("access-shared", "refresh-shared", 8 * HOUR); });
    setClaudeSessionRefresherForTests(refresher);
    const row = await selection(userId, account.grantId);
    const service = aiConnectionService(db);
    const pending = Promise.all([service.runtimeCredential(row), service.credential(row), aiConnectionService(db).runtimeCredential(row)]);
    await vi.waitFor(() => expect(refresher).toHaveBeenCalledTimes(1));
    release();
    expect(await pending).toEqual(["access-shared", "access-shared", "access-shared"]);
    expect(refresher).toHaveBeenCalledTimes(1);
    expect((await storedSecret(account.grantId)).latestVersion).toBe(2);
  });

  it("(e) surfaces a failed refresh as the reconnect error with no fallback token", async () => {
    const userId = await member("failed");
    const refreshToken = `sk-ant-ort01-${randomUUID()}`;
    const account = await connect(userId, JSON.stringify(session("access-expiring", refreshToken, 60 * 1000)));
    setClaudeSessionRefresherForTests(async () => { throw new Error(`provider said no to ${refreshToken}`); });
    const failure = await prepareManagedAiRuntime(db, runtimeInput(userId)).then(() => null, (error: unknown) => error as Error & { details?: unknown });
    expect(failure).toMatchObject({ message: "Reconnect this AI account", details: { code: "ai_connection_session_refresh_failed" } });
    expect(JSON.stringify({ message: failure?.message, details: failure?.details })).not.toContain(refreshToken);
    // The saved session is unchanged, so a later sign-in replaces it cleanly.
    expect((await storedSecret(account.grantId)).latestVersion).toBe(1);
  });

  it("(g) leaves setup-token and OpenAI subscription connections unchanged", async () => {
    const refresher = vi.fn();
    setClaudeSessionRefresherForTests(refresher);
    const claudeUser = await member("setup-token");
    const claude = await connect(claudeUser, "sk-ant-oat01-setup-token-fixture");
    expect((await aiConnectionService(db).list(companyId, claudeUser)).find(c => c.grantId === claude.grantId)?.credentialKind).toBe("setup_token");
    const runtime = await prepareManagedAiRuntime(db, runtimeInput(claudeUser));
    try {
      expect((runtime.config.env as Record<string, string>).CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-setup-token-fixture");
    } finally { await runtime.cleanup(); }
    const openaiUser = await member("openai");
    const value = JSON.stringify({ tokens: { access_token: "oa-access", refresh_token: "oa-refresh", id_token: "oa-id", account_id: "acct" } });
    const openai = await connect(openaiUser, value, "openai");
    const row = await aiConnectionService(db).select({ companyId, userId: openaiUser, agentId, adapterType: "codex_local", binding: { provider: "openai", method: "subscription", mode: "responsible_user" } });
    expect(row.grant.id).toBe(openai.grantId);
    expect(await aiConnectionService(db).credential(row)).toBe(value);
    expect((await aiConnectionService(db).list(companyId, openaiUser)).find(c => c.grantId === openai.grantId)?.credentialKind).toBeUndefined();
    expect(refresher).not.toHaveBeenCalled();
  });
});

/** Reads the saved connection secret the way the server does (writes an access event). */
async function readSecretValue(grantId: string) {
  const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, grantId));
  const ref = grant!.credentialSecretRefs.find(r => r.configPath === "ai.credential")!;
  const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.id, ref.secretId));
  const context = { consumerType: "tool_connection" as const, consumerId: grant!.connectionId, configPath: ref.configPath, responsibleUserId: secret!.ownerUserId, actorType: "system" as const, actorId: "test" };
  const result = await secretService(db).resolveUserSecretValue(companyId,
    { definitionId: secret!.userSecretDefinitionId!, responsibleUserId: secret!.ownerUserId!, required: true, version: "latest" }, context);
  return result!.value;
}

describe("Claude Code refresh and login (fake claude executable)", () => {
  async function fakeClaude(behaviour: "rotate" | "unchanged") {
    const dir = await mkdtemp(path.join(home, "fake-claude-"));
    const record = path.join(dir, "record.json");
    const script = path.join(dir, "claude");
    await writeFile(script, `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const file = path.join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json");
const current = JSON.parse(fs.readFileSync(file, "utf8"));
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env, sawExpiresAt: current.claudeAiOauth.expiresAt }));
if (${JSON.stringify(behaviour)} === "rotate") {
  fs.rmSync(file);
  fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { ...current.claudeAiOauth, accessToken: "cli-access-new", refreshToken: "cli-refresh-new", expiresAt: Date.now() + 8 * 3600 * 1000 } }), { mode: 0o600 });
}
process.stdout.write(JSON.stringify({ loggedIn: true }));
`);
    await chmod(script, 0o755);
    return { script, record };
  }

  it("refreshes through Claude Code in a private config directory, then removes it", async () => {
    const { script, record } = await fakeClaude("rotate");
    const refreshToken = `sk-ant-ort01-${randomUUID()}`;
    const rotated = await refreshClaudeOAuthSessionWithCli(session("cli-access-old", refreshToken, 10 * 60 * 1000), { command: script });
    expect(rotated.claudeAiOauth).toMatchObject({ accessToken: "cli-access-new", refreshToken: "cli-refresh-new", subscriptionType: "max" });
    const seen = JSON.parse(await readFile(record, "utf8"));
    expect(seen.argv).toEqual(["auth", "status", "--json"]);
    // Claude Code is told the token expired so it refreshes now.
    expect(seen.sawExpiresAt).toBe(0);
    expect(JSON.stringify(seen.argv)).not.toContain(refreshToken);
    expect(JSON.stringify(seen.env)).not.toContain(refreshToken);
    for (const key of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "PAPERCLIP_HOME"]) expect(seen.env[key]).toBeUndefined();
    expect(seen.env.CLAUDE_CONFIG_DIR).toBe(seen.env.HOME);
    expect(seen.env.CLAUDE_CONFIG_DIR.startsWith(path.join(home, "instances"))).toBe(true);
    await expect(stat(seen.env.CLAUDE_CONFIG_DIR)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats an unchanged credentials file as a failed refresh", async () => {
    const { script } = await fakeClaude("unchanged");
    await expect(refreshClaudeOAuthSessionWithCli(session("cli-same", "refresh-same", 60 * 1000), { command: script }))
      .rejects.toThrow("Claude Code did not refresh the session");
  });

  it("saves the whole session from a `claude auth login` config directory and still reads setup tokens", async () => {
    const loginHome = await mkdtemp(path.join(home, "login-"));
    await writeFile(path.join(loginHome, ".credentials.json"), JSON.stringify(session("login-access", "login-refresh", 8 * HOUR)), { mode: 0o600 });
    const saved = parseClaudeOAuthSession(await readVerifiedLocalAiCredential("anthropic", loginHome));
    expect(saved?.claudeAiOauth).toMatchObject({ accessToken: "login-access", refreshToken: "login-refresh" });
    const setupHome = await mkdtemp(path.join(home, "setup-"));
    await writeFile(path.join(setupHome, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-legacy" } }), { mode: 0o600 });
    expect(await readVerifiedLocalAiCredential("anthropic", setupHome)).toBe("sk-ant-oat01-legacy");
  });

  it("asks for the run timeout plus a margin, capped at the issued maximum", () => {
    expect(claudeSessionMinRemainingMs(undefined)).toBe(2 * HOUR);
    expect(claudeSessionMinRemainingMs(3600)).toBe(HOUR + 10 * 60 * 1000);
    expect(claudeSessionMinRemainingMs(48 * 3600)).toBe(CLAUDE_ISSUED_TOKEN_MAX_LIFETIME_MS);
  });
});

