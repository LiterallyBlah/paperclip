import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { readLocalAiCredentialFile } from "./local-ai-credential-file.js";

/**
 * A Claude subscription signed in with `claude auth login` (BLA-5403).
 *
 * The saved connection secret holds Claude Code's own `.credentials.json`
 * shape: a short-lived access token, its expiry and the long-lived refresh
 * token. Only the Paperclip server reads it. A run receives the access token
 * alone, as CLAUDE_CODE_OAUTH_TOKEN. The refresh token never enters a run's
 * environment, home, argv, prompt or log.
 *
 * Paperclip does not talk to Anthropic's OAuth endpoint itself. A refresh runs
 * the installed Claude Code binary against a private, server-owned
 * CLAUDE_CONFIG_DIR and reads back the credentials it rotates.
 */
export type ClaudeCredentialKind = "setup_token" | "oauth_session";

export interface ClaudeOAuthSession {
  claudeAiOauth: {
    accessToken: string;
    refreshToken: string;
    /** Milliseconds since the epoch, as Claude Code writes it. */
    expiresAt: number;
    [key: string]: unknown;
  };
}

/** A run may only ever receive an access token with at most this much life left. */
export const CLAUDE_ISSUED_TOKEN_MAX_LIFETIME_MS = 12 * 60 * 60 * 1000;
/** Remaining life to require when the agent has no run timeout. */
export const CLAUDE_SESSION_DEFAULT_MIN_REMAINING_MS = 2 * 60 * 60 * 1000;
/** Added to a configured run timeout before deciding a refresh is needed. */
export const CLAUDE_SESSION_REFRESH_MARGIN_MS = 10 * 60 * 1000;
/** Longest wait for one Claude Code refresh. */
export const CLAUDE_SESSION_REFRESH_TIMEOUT_MS = 60_000;

/** The connection config key that records which Claude credential a connection holds. */
export const CLAUDE_CREDENTIAL_KIND_CONFIG_KEY = "aiClaudeCredentialKind";

export function parseClaudeOAuthSession(value: string): ClaudeOAuthSession | null {
  if (!value.startsWith("{")) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return null; }
  const oauth = (parsed as { claudeAiOauth?: unknown } | null)?.claudeAiOauth as Record<string, unknown> | undefined;
  if (!oauth || typeof oauth !== "object") return null;
  const { accessToken, refreshToken, expiresAt } = oauth;
  if (typeof accessToken !== "string" || !accessToken.trim()) return null;
  if (typeof refreshToken !== "string" || !refreshToken.trim()) return null;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return null;
  return { claudeAiOauth: { ...oauth, accessToken, refreshToken, expiresAt } };
}

export function serializeClaudeOAuthSession(session: ClaudeOAuthSession): string {
  return JSON.stringify({ claudeAiOauth: session.claudeAiOauth });
}

/** The kind of Claude subscription credential a connection holds. */
export function claudeCredentialKind(config: Record<string, unknown> | undefined): ClaudeCredentialKind {
  return config?.[CLAUDE_CREDENTIAL_KIND_CONFIG_KEY] === "oauth_session" ? "oauth_session" : "setup_token";
}

/** Remaining access-token life a run needs, from its configured timeout. */
export function claudeSessionMinRemainingMs(timeoutSec: unknown): number {
  const seconds = typeof timeoutSec === "number" ? timeoutSec : typeof timeoutSec === "string" ? Number(timeoutSec) : 0;
  if (!Number.isFinite(seconds) || seconds <= 0) return CLAUDE_SESSION_DEFAULT_MIN_REMAINING_MS;
  // A token can never outlive the issued maximum, so never ask for more.
  return Math.min(seconds * 1000 + CLAUDE_SESSION_REFRESH_MARGIN_MS, CLAUDE_ISSUED_TOKEN_MAX_LIFETIME_MS);
}

/** Environment passed to the refresh. Server secrets and provider overrides stay out. */
const REFRESH_ENV_KEYS = [
  "PATH", "LANG", "LC_ALL", "TZ", "TMPDIR",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
];

function refreshRoot() {
  return path.join(resolvePaperclipInstanceRoot(), "ai-oauth-refresh");
}

/**
 * Refreshes one session with Claude Code and returns the rotated credentials.
 * Throws a fixed, secret-free error when Claude Code did not rotate them.
 */
export async function refreshClaudeOAuthSessionWithCli(
  session: ClaudeOAuthSession,
  options: { command?: string; timeoutMs?: number; now?: () => number } = {},
): Promise<ClaudeOAuthSession> {
  const now = options.now ?? Date.now;
  const root = refreshRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  // Credential reads refuse symlinks anywhere in the path; use the canonical root.
  const directory = path.join(await realpath(root), randomUUID());
  await mkdir(directory, { mode: 0o700 });
  try {
    const file = await open(path.join(directory, ".credentials.json"),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      // Mark the access token expired so Claude Code refreshes it now rather
      // than at its own five-minute threshold.
      await file.writeFile(JSON.stringify({ claudeAiOauth: { ...session.claudeAiOauth, expiresAt: 0 } }));
    } finally {
      await file.close();
    }
    const env: NodeJS.ProcessEnv = {};
    for (const key of REFRESH_ENV_KEYS) if (process.env[key]) env[key] = process.env[key];
    Object.assign(env, { HOME: directory, CLAUDE_CONFIG_DIR: directory, DISABLE_AUTOUPDATER: "1", NO_COLOR: "1" });
    const exitCode = await new Promise<number | null>((resolve) => {
      // Claude Code output can contain account details. Discard it unread.
      const child = spawn(options.command ?? "claude", ["auth", "status", "--json"], {
        cwd: directory, env, stdio: ["ignore", "ignore", "ignore"],
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? CLAUDE_SESSION_REFRESH_TIMEOUT_MS);
      timer.unref();
      child.once("error", () => { clearTimeout(timer); resolve(null); });
      child.once("close", (code) => { clearTimeout(timer); resolve(code); });
    });
    // `auth status` reports signed in even when its refresh failed, so the
    // rotated file is the only proof of success.
    const raw = await readLocalAiCredentialFile(path.join(directory, ".credentials.json")).catch(() => "");
    const rotated = parseClaudeOAuthSession(raw);
    if (exitCode === null || !rotated
      || rotated.claudeAiOauth.accessToken === session.claudeAiOauth.accessToken
      || rotated.claudeAiOauth.expiresAt <= now() + 60_000)
      throw new Error("Claude Code did not refresh the session");
    return rotated;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
