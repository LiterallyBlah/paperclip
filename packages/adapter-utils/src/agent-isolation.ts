// BLA-433 RR1: per-agent OS identity launch planning (server side).
//
// When /etc/paperclip/agent-launch.json is present, root-owned and has
// `enabled: true`:
//  - every launch that carries a PAPERCLIP_AGENT_ID must be a mapped agent
//    running a pinned CLI; it goes through the root helper via one exact sudo
//    rule. An unmapped agent id is refused whatever the command (B1);
//  - a known agent CLI launched without an identity is refused (B1);
//  - every other launch WITHOUT an agent identity is refused by default
//    (P2-B1). Only an explicit `serverCommandRules` entry in this root-owned
//    file can allow one, and only for a root-owned ELF binary that is not a
//    shell, interpreter or exec wrapper, run with a cwd outside the instance,
//    run-dir and workspace roots and a minimal env;
//  - per-run dirs, prompt bundles and workspaces handed to the agent uid are
//    derived only from server-assigned values (runId argument, the agent's
//    own instance paths, server-owned binding markers, the heartbeat's
//    workspace registration), never from argv or adapter-config env (B2/B3);
//  - git's ownership check stays on: private agents get no safe.directory,
//    shared agents only their exact workspace paths (M1).
// Anything that cannot be launched isolated fails closed: there is no same-uid
// fallback.
//
// The root helper (/usr/local/libexec/paperclip-agent-launch), the server-only
// git shim, sudoers rule and the config file itself are host artefacts
// installed by root; they are not part of this repository.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const AGENT_ISOLATION_CONFIG_PATH = "/etc/paperclip/agent-launch.json";
export const AGENT_LAUNCH_HELPER_PATH = "/usr/local/libexec/paperclip-agent-launch";
export const SUDO_PATH = "/usr/bin/sudo";
// Server-only git shim dir (BLA-433 git route); never on an agent's PATH.
export const SERVER_GIT_SHIM_DIR = "/usr/local/lib/paperclip-isolation/bin";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Server-process env that must never reach any agent, isolated or not.
export const SERVER_SECRET_ENV_KEYS: readonly string[] = [
  "BETTER_AUTH_SECRET",
  "PAPERCLIP_AGENT_JWT_SECRET",
  "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET",
  "DATABASE_URL",
  "PAPERCLIP_EMBEDDED_POSTGRES_PASSWORD_FILE",
];
// Only these keys are inherited from the server process for isolated runs;
// everything else must come from the adapter's per-run env.
const ISOLATED_BASE_ENV_KEYS = [
  "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "MUSE_NO_AUTO_UPDATE",
  "PAPERCLIP_RUNTIME_API_URL", "PAPERCLIP_LISTEN_HOST", "PAPERCLIP_LISTEN_PORT",
];
// Env keys that may NAME the managed AI home. They are hints only: a home is
// handed over only when its server-written binding marker names this agent.
const AI_HOME_HINT_ENV_KEYS = ["HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"];
// Server-written, server-owned markers that bind a per-run dir to its agent/run.
export const RUN_SCRATCH_MARKER = ".paperclip-run-scratch.json";
export const AI_HOME_BINDING_MARKER = ".paperclip-agent-binding.json";
// Agent CLIs/engines that must never run as the server uid while isolation is
// on (B1): a launch of one of these that is not a pinned, mapped launch fails.
export const KNOWN_AGENT_CLI_NAMES: ReadonlySet<string> = new Set([
  "claude", "codex", "gemini", "cursor-agent", "cursor", "opencode", "pi", "grok", "kimi",
  "acpx", "claude-agent-acp", "codex-acp", "gemini-cli", "muse", "copilot", "goose", "aider",
]);
// P2-B1: never allowed by a serverCommandRules entry: shells, interpreters and
// programs that execute other programs or scripts given argv/env/config.
// Defence in depth only: the rule itself must be authored by root, and the
// binary must be a root-owned ELF file (so no `#!` script is ever allowed).
export const NO_IDENTITY_FORBIDDEN_NAMES: ReadonlySet<string> = new Set([
  "sh", "bash", "dash", "ash", "zsh", "ksh", "mksh", "pdksh", "csh", "tcsh", "fish", "rbash", "busybox", "toybox",
  "env", "python", "python2", "python3", "pypy", "pypy3", "perl", "ruby", "irb", "node", "nodejs", "deno", "bun",
  "php", "lua", "luajit", "tclsh", "wish", "expect", "guile", "racket", "rscript", "r", "julia", "osascript",
  "awk", "gawk", "mawk", "nawk", "sed", "find", "xargs", "parallel", "make", "gmake", "cmake", "ninja",
  "nice", "nohup", "timeout", "setsid", "stdbuf", "chroot", "unshare", "nsenter", "flock", "watch", "time",
  "ionice", "chrt", "taskset", "prlimit", "systemd-run", "runuser", "su", "sudo", "doas", "pkexec", "setpriv",
  "capsh", "strace", "ltrace", "gdb", "lldb", "valgrind", "script", "screen", "tmux", "vi", "vim", "nvim", "ex",
  "view", "rvim", "emacs", "nano", "ed", "less", "more", "man", "git", "ssh", "scp", "sftp", "rsync", "tar",
  "zip", "unzip", "cpio", "dpkg", "apt", "apt-get", "docker", "podman", "npm", "npx", "pnpm", "yarn", "corepack",
  "pip", "pip3", "uv", "uvx", "cargo", "go", "java", "jshell", "dotnet", "mono", "ld.so", "ld-linux-x86-64.so.2",
  "bwrap", "firejail", "socat", "nc", "ncat", "openssl", "curl", "wget", "sqlite3", "psql", "jq", "yq",
]);
// Versioned interpreter names (python3.11, perl5.36, ruby3.1, lua5.4, php8.2, tclsh8.6, node20, ...).
const NO_IDENTITY_FORBIDDEN_RE = /^(python|pypy|perl|ruby|lua|luajit|php|tclsh|wish|node|nodejs|guile|pwsh|powershell)[0-9._-]*$/;
// Env keys a serverCommandRules entry may never pass: loader/runtime injection.
const NO_IDENTITY_FORBIDDEN_ENV_RE = /^(LD_|DYLD_|GCONV_|NODE_|PYTHON|PERL|RUBY|BASH_|ENV$|SHELLOPTS$|PS4$|IFS$|GIT_|PATH$|HOME$|TMPDIR$|LOCALDOMAIN$|HOSTALIASES$|RES_OPTIONS$|MALLOC_|GLIBC_)/;

// Never treated as repository-discovery ancestors for isolated agents (M1).
export const ISOLATED_GIT_CEILING_DIRS: readonly string[] = ["/tmp", "/var/tmp", "/dev/shm"];

export interface AgentIsolationAgentEntry {
  user: string;
  shared: boolean;
}

export interface AgentIsolationGitWorkspaceRoot {
  path: string;
  depth: number;
}

export interface AgentIsolationServerCommandRule {
  command: string;
  args: string[] | null;
  envKeys: string[];
}

export interface AgentIsolationConfig {
  serverUid: number;
  spoolDir: string;
  instanceRoot: string;
  runDirRoot: string;
  allowedCommands: string[];
  allowedCommandRealpaths: Set<string>;
  agents: Map<string, AgentIsolationAgentEntry>;
  gitWorkspaceRoots: AgentIsolationGitWorkspaceRoot[];
  workspaceRoots: string[];
  serverCommandRules: AgentIsolationServerCommandRule[];
  helperPath: string;
  sudoPath: string;
}

export type AgentIsolationEnv = Record<string, string | undefined>;

export interface PlanAgentIsolatedLaunchInput {
  command: string;
  resolvedCommand?: string | null;
  args?: string[];
  cwd?: string;
  /** The adapter's per-run env (never the merged server env). */
  env?: AgentIsolationEnv;
  /** The server process env; only an allowlist is inherited. */
  baseEnv?: AgentIsolationEnv;
  localProcessSandbox?: unknown;
  remote?: boolean;
  /** Server-assigned run id (runChildProcess's first argument), never env/config. */
  runId?: string | null;
  loadConfig?: () => AgentIsolationConfig | null;
}

export interface AgentIsolatedLaunchPlan {
  command: string;
  args: string[];
  env: Record<string, string>;
  replaceEnv: true;
  cleanup: () => Promise<void>;
  agentId?: string;
  runDirs?: string[];
  readDirs?: string[];
  workspaces?: string[];
  serverRule?: string;
}

export function isForbiddenServerCommandName(p: string | null | undefined): boolean {
  const n = commandBaseName(p);
  return !n || NO_IDENTITY_FORBIDDEN_NAMES.has(n) || NO_IDENTITY_FORBIDDEN_RE.test(n) || KNOWN_AGENT_CLI_NAMES.has(n);
}

let configPathOverride: string | null = null;
/** Test-only: point the loader at a fixture config and relax the root-owner check. */
export function __setAgentIsolationConfigPathForTests(p: string | null): void {
  configPathOverride = p;
}

export class AgentIsolationError extends Error {
  readonly code = "AGENT_ISOLATION_REFUSED";
  constructor(message: string) {
    super(`Agent process isolation: ${message}`);
    this.name = "AgentIsolationError";
  }
}

function errCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && typeof (err as { code?: unknown }).code === "string") {
    return (err as { code: string }).code;
  }
  return String(err);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function absNorm(p: unknown, label: string): string {
  if (typeof p !== "string" || !path.isAbsolute(p) || p.includes("\0")) {
    throw new AgentIsolationError(`config ${label} must be an absolute path`);
  }
  const n = path.normalize(p).replace(/\/+$/, "");
  if (!n || n === "/") throw new AgentIsolationError(`config ${label} must not be '/'`);
  return n;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Returns null when isolation is not configured (file absent) or disabled.
 * Throws AgentIsolationError when the file exists but is unsafe or invalid,
 * so callers fail closed for protected launches.
 */
export function loadAgentIsolationConfig(): AgentIsolationConfig | null {
  const configPath = configPathOverride ?? AGENT_ISOLATION_CONFIG_PATH;
  let st: fs.Stats;
  try {
    st = fs.lstatSync(configPath);
  } catch (err) {
    if (errCode(err) === "ENOENT") return null;
    throw new AgentIsolationError(`cannot stat ${configPath}: ${errCode(err)}`);
  }
  if (!st.isFile()) throw new AgentIsolationError(`${configPath} is not a regular file`);
  const expectedOwner = configPathOverride ? process.getuid?.() : 0;
  if (st.uid !== expectedOwner || (st.mode & 0o022) !== 0) {
    throw new AgentIsolationError(`${configPath} must be root-owned and not group/other writable`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    throw new AgentIsolationError(`${configPath} is not valid JSON`);
  }
  // Mirrors the dist overlay's untyped access; every field is validated below.
  const raw = (isRecord(parsed) ? parsed : null) as Record<string, any> | null;
  if (!raw || raw.version !== 1) throw new AgentIsolationError("config version must be 1");
  if (raw.enabled !== true) return null;
  if (!Number.isInteger(raw.serverUid) || raw.serverUid <= 0) throw new AgentIsolationError("config serverUid invalid");
  if (!raw.agents || typeof raw.agents !== "object") throw new AgentIsolationError("config agents map missing");
  const agents = new Map<string, AgentIsolationAgentEntry>();
  for (const [agentId, entry] of Object.entries(raw.agents as Record<string, any>)) {
    if (!UUID_RE.test(agentId) || !entry || typeof entry.user !== "string") {
      throw new AgentIsolationError("config agents map is invalid");
    }
    agents.set(agentId, { user: entry.user, shared: entry.shared === true });
  }
  if (raw.allowedCommands !== undefined && raw.allowedCommands !== null && !Array.isArray(raw.allowedCommands)) {
    throw new AgentIsolationError("config allowedCommands must be an array");
  }
  const allowedCommands = ((raw.allowedCommands ?? []) as unknown[]).map((p, i) => absNorm(p, `allowedCommands[${i}]`));
  if (allowedCommands.length === 0) throw new AgentIsolationError("config allowedCommands is empty");
  // P2-B1: the only way a launch without an agent identity may run while
  // isolation is on. An unsafe rule fails the whole config closed.
  if (raw.serverCommandRules !== undefined && !Array.isArray(raw.serverCommandRules)) {
    throw new AgentIsolationError("config serverCommandRules must be an array");
  }
  const serverCommandRules = ((raw.serverCommandRules ?? []) as unknown[]).map((rule, i): AgentIsolationServerCommandRule => {
    if (!rule || typeof rule !== "object") throw new AgentIsolationError(`config serverCommandRules[${i}] invalid`);
    const r = rule as Record<string, unknown>;
    const command = absNorm(r.command, `serverCommandRules[${i}].command`);
    if (isForbiddenServerCommandName(command) || isForbiddenServerCommandName(realpathOrSelf(command)) ||
      allowedCommands.includes(command)) {
      throw new AgentIsolationError(`config serverCommandRules[${i}] names a shell, interpreter, exec wrapper or agent CLI`);
    }
    if (r.args !== undefined && (!Array.isArray(r.args) || !r.args.every((a) => typeof a === "string"))) {
      throw new AgentIsolationError(`config serverCommandRules[${i}].args must be an array of strings`);
    }
    const envKeys = r.envKeys ?? [];
    if (!Array.isArray(envKeys) || !envKeys.every((k) => typeof k === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(k) &&
      !NO_IDENTITY_FORBIDDEN_ENV_RE.test(k) && !SERVER_SECRET_ENV_KEYS.includes(k))) {
      throw new AgentIsolationError(`config serverCommandRules[${i}].envKeys invalid`);
    }
    return {
      command,
      args: r.args === undefined ? null : [...(r.args as string[])],
      envKeys: [...(envKeys as string[])],
    };
  });
  if (raw.gitWorkspaceRoots !== undefined && raw.gitWorkspaceRoots !== null && !Array.isArray(raw.gitWorkspaceRoots)) {
    throw new AgentIsolationError("config gitWorkspaceRoots must be an array");
  }
  if (raw.workspaceRoots !== undefined && raw.workspaceRoots !== null && !Array.isArray(raw.workspaceRoots)) {
    throw new AgentIsolationError("config workspaceRoots must be an array");
  }
  return {
    serverUid: raw.serverUid as number,
    spoolDir: absNorm(raw.spoolDir, "spoolDir"),
    instanceRoot: absNorm(raw.instanceRoot, "instanceRoot"),
    runDirRoot: absNorm(raw.runDirRoot, "runDirRoot"),
    allowedCommands,
    allowedCommandRealpaths: new Set(allowedCommands.map((c) => {
      try {
        return fs.realpathSync(c);
      } catch {
        return c;
      }
    })),
    agents,
    gitWorkspaceRoots: ((raw.gitWorkspaceRoots ?? []) as unknown[]).map((root, i) => {
      const r = root as Record<string, unknown> | null;
      if (!r || !Number.isInteger(r.depth) || (r.depth as number) < 1 || (r.depth as number) > 4) {
        throw new AgentIsolationError(`config gitWorkspaceRoots[${i}] invalid`);
      }
      return { path: absNorm(r.path, `gitWorkspaceRoots[${i}].path`), depth: r.depth as number };
    }),
    workspaceRoots: ((raw.workspaceRoots ?? []) as unknown[]).map((p, i) => absNorm(p, `workspaceRoots[${i}]`)),
    serverCommandRules,
    helperPath: raw.helperPath ? absNorm(raw.helperPath, "helperPath") : AGENT_LAUNCH_HELPER_PATH,
    sudoPath: raw.sudoPath ? absNorm(raw.sudoPath, "sudoPath") : SUDO_PATH,
  };
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

export function isProtectedAgentCommand(config: AgentIsolationConfig, resolvedCommand: string | null | undefined): boolean {
  if (!resolvedCommand) return false;
  return config.allowedCommands.includes(resolvedCommand) ||
    config.allowedCommandRealpaths.has(realpathOrSelf(resolvedCommand));
}

// ------------------------------------------------------------------ B2: run binding
//
// Per-run dirs and prompt bundles are derived ONLY from values the server
// assigned for this run: the runId passed to runChildProcess (never env or
// adapter config), the agent's own instance paths, and server-written,
// server-owned binding markers. argv and env values are at most hints, and a
// hint is accepted only when the binding proves it belongs to this agent/run.
// The helper re-checks every binding as root (defence in depth).

export function runScratchSegment(runId: string): string {
  // Mirrors server/src/services/run-scratch.ts sanitizePathSegment(runId.slice(0, 12)).
  return runId.slice(0, 12).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "").replace(/[.-]+$/g, "");
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function isPlainDir(p: string): boolean {
  const st = lstatOrNull(p);
  return !!st && st.isDirectory() && !st.isSymbolicLink();
}

/** Read a server-written marker: a single-link regular file owned by the server uid. */
export function readServerMarker(dir: string, name: string): Record<string, unknown> | null {
  const p = path.join(dir, name);
  const st = lstatOrNull(p);
  const serverUid = process.getuid?.();
  if (!st || !st.isFile() || st.nlink !== 1 || st.uid !== serverUid || st.size > 65536) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(p, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function listDir(p: string): string[] {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
}

/**
 * The per-run dirs that provably belong to (agentId, runId). Returns sorted
 * absolute paths. `hints` are env values that may name the managed AI home.
 */
export function deriveRunDirs(
  config: AgentIsolationConfig,
  agentId: string,
  runId: string | null | undefined,
  hints: ReadonlyArray<unknown> = [],
): string[] {
  const out = new Set<string>();
  if (!runId || !UUID_RE.test(runId)) return [];
  // 1. GitHub runtime dir: named by the runId.
  const gh = path.join(config.runDirRoot, "paperclip-github-runtime", runId);
  if (isPlainDir(gh)) out.add(gh);
  // 2. Claude runtime run dir: under this agent's own instance path, named by the runId.
  const companies = path.join(config.instanceRoot, "companies");
  for (const c of listDir(companies)) {
    if (!UUID_RE.test(c)) continue;
    const d = path.join(companies, c, "agents", agentId, "claude-runtime", "runs", runId);
    if (isPlainDir(d)) out.add(d);
  }
  // 3. Heartbeat run scratch: name carries the run segment AND the
  //    server-written marker names this agent and this run.
  const seg = runScratchSegment(runId);
  for (const name of listDir(config.runDirRoot)) {
    if (!name.startsWith("paperclip-run-") || !name.includes(`-${seg}-`)) continue;
    const d = path.join(config.runDirRoot, name);
    if (!isPlainDir(d)) continue;
    const m = readServerMarker(d, RUN_SCRATCH_MARKER);
    if (m && m.agentId === agentId && m.runId === runId) out.add(d);
  }
  // 4. Managed AI home: only a hinted paperclip-ai-* dir whose server-written
  //    binding marker names this agent (written by ai-connection-runtime).
  const aiRe = new RegExp(`^(${escapeRe(config.runDirRoot)}/paperclip-ai-[A-Za-z0-9._-]{1,200})(?:/|$)`);
  for (const h of hints) {
    if (typeof h !== "string" || !path.isAbsolute(h)) continue;
    const m = aiRe.exec(path.normalize(h));
    if (!m || !isPlainDir(m[1]!)) continue;
    const b = readServerMarker(m[1]!, AI_HOME_BINDING_MARKER);
    if (b && b.agentId === agentId) out.add(m[1]!);
  }
  return [...out].sort();
}

/** Prompt bundles are per agent (prompt-cache): .../claude-prompt-cache/agents/<agentId>/<sha256>. */
export function agentPromptBundleDir(config: AgentIsolationConfig, agentId: string, p: unknown): string | null {
  if (typeof p !== "string" || !path.isAbsolute(p)) return null;
  const n = path.normalize(p);
  const re = new RegExp(`^(${escapeRe(config.instanceRoot)}/companies/[0-9a-f-]{36}/claude-prompt-cache/agents/${escapeRe(agentId)}/[0-9a-f]{64})(?:/|$)`);
  const m = re.exec(n);
  return m && isPlainDir(m[1]!) ? m[1]! : null;
}

// ------------------------------------------------------------------ B3: run workspaces
//
// The heartbeat registers the execution workspace (and agent home) the server
// resolved for each run, keyed by the server-assigned runId. Only these are
// handed to the agent uid at launch. In-process only; bounded. Registration is
// unconditional (it is inert while isolation is off: nothing reads it).

const runWorkspaceRegistry = new Map<string, { agentId: string; dirs: string[] }>();
const RUN_WORKSPACE_REGISTRY_MAX = 2048;

export function registerRunWorkspaces(
  runId: string | null | undefined,
  agentId: string | null | undefined,
  dirs: ReadonlyArray<unknown> | null | undefined,
): void {
  if (!runId || !UUID_RE.test(runId) || !agentId || !UUID_RE.test(agentId)) return;
  const list = (dirs ?? [])
    .filter((d): d is string => typeof d === "string" && path.isAbsolute(d))
    .map((d) => path.normalize(d));
  runWorkspaceRegistry.delete(runId);
  runWorkspaceRegistry.set(runId, { agentId, dirs: list });
  while (runWorkspaceRegistry.size > RUN_WORKSPACE_REGISTRY_MAX) {
    const oldest = runWorkspaceRegistry.keys().next().value;
    if (oldest === undefined) break;
    runWorkspaceRegistry.delete(oldest);
  }
}

export function __resetRunWorkspacesForTests(): void {
  runWorkspaceRegistry.clear();
}

/** Lexical workspace top (M2 rule): the first `depth` segments under a git workspace root. */
export function workspaceTopOf(config: AgentIsolationConfig, p: unknown): string | null {
  if (typeof p !== "string" || !path.isAbsolute(p)) return null;
  const n = path.normalize(p).replace(/\/+$/, "");
  for (const r of config.gitWorkspaceRoots ?? []) {
    if (n === r.path || !n.startsWith(`${r.path}/`)) continue;
    const parts = n.slice(r.path.length + 1).split("/");
    if (parts.length < r.depth) return null;
    return path.join(r.path, ...parts.slice(0, r.depth));
  }
  return null;
}

/** Workspace tops the server assigned to this run (registered), for this agent only. */
export function runAssignedWorkspaces(
  config: AgentIsolationConfig,
  agentId: string,
  runId: string | null | undefined,
): string[] {
  const entry = runId && UUID_RE.test(runId) ? runWorkspaceRegistry.get(runId) : undefined;
  if (!entry) return [];
  if (entry.agentId !== agentId) {
    throw new AgentIsolationError(`run ${runId} is registered for a different agent; refusing workspace hand-over`);
  }
  const tops = new Set<string>();
  for (const d of entry.dirs) {
    const top = workspaceTopOf(config, d);
    if (top) tops.add(top);
  }
  return [...tops].sort();
}

// ------------------------------------------------------------------ env

export interface BuildIsolatedChildEnvOptions {
  shared?: boolean;
  safeDirectories?: ReadonlyArray<string>;
  extraCeilings?: ReadonlyArray<string>;
}

export function buildIsolatedChildEnv(
  baseEnv: AgentIsolationEnv,
  adapterEnv: AgentIsolationEnv | null | undefined,
  opts: BuildIsolatedChildEnvOptions = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ISOLATED_BASE_ENV_KEYS) {
    const value = baseEnv[key];
    if (typeof value === "string") env[key] = value;
  }
  for (const [key, value] of Object.entries(adapterEnv ?? {})) {
    if (typeof value === "string") env[key] = value;
  }
  for (const key of SERVER_SECRET_ENV_KEYS) delete env[key];
  for (const key of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION", "CLAUDE_CODE_PARENT_SESSION"]) {
    delete env[key];
  }
  for (const key of ["PATH", "Path"]) {
    const value = env[key];
    if (typeof value === "string") {
      env[key] = value.split(":").filter((p) => p && path.normalize(p).replace(/\/+$/, "") !== SERVER_GIT_SHIM_DIR).join(":");
    }
  }
  // M1: never disable git's ownership check wholesale. Private (PA/CFO-class)
  // agents get no safe.directory at all: everything they work in is their own.
  // Shared agents get only the exact shared workspace paths of this run.
  if (opts.shared === true) {
    for (const dir of [...new Set(opts.safeDirectories ?? [])].sort()) {
      if (typeof dir === "string" && path.isAbsolute(dir) && dir !== "/" && !dir.includes("*")) {
        appendGitConfigEnv(env, "safe.directory", dir);
      }
    }
  }
  const ceilings = [...ISOLATED_GIT_CEILING_DIRS, ...(opts.extraCeilings ?? [])];
  const existing = typeof env.GIT_CEILING_DIRECTORIES === "string" && env.GIT_CEILING_DIRECTORIES
    ? env.GIT_CEILING_DIRECTORIES.split(":").filter(Boolean) : [];
  env.GIT_CEILING_DIRECTORIES = [...new Set([...existing, ...ceilings])].join(":");
  return env;
}

// Uses git's GIT_CONFIG_COUNT/KEY_n/VALUE_n env channel, appending to existing entries.
export function appendGitConfigEnv(env: Record<string, string>, key: string, value: string): void {
  const raw = env.GIT_CONFIG_COUNT;
  const count = raw === undefined ? 0 : Number.parseInt(raw, 10);
  if (!Number.isInteger(count) || count < 0 || String(count) !== String(raw ?? "0")) {
    throw new AgentIsolationError("GIT_CONFIG_COUNT in the run env is malformed");
  }
  env[`GIT_CONFIG_KEY_${count}`] = key;
  env[`GIT_CONFIG_VALUE_${count}`] = value;
  env.GIT_CONFIG_COUNT = String(count + 1);
}

function commandBaseName(p: string | null | undefined): string {
  return typeof p === "string" && p ? path.basename(p).toLowerCase().replace(/\.(cmd|exe|js|mjs|cjs)$/, "") : "";
}

/** B1: refuse agent-code engines that do not launch through runChildProcess. */
export function assertAgentEngineAllowedUnderIsolation(
  engineLabel: string,
  loadConfig: () => AgentIsolationConfig | null = loadAgentIsolationConfig,
): void {
  const config = loadConfig();
  if (!config) return;
  throw new AgentIsolationError(`refusing the ${engineLabel} engine: it launches agent code outside the isolated launcher (use engine "cli")`);
}

function isUnderOrEqual(p: string, root: string): boolean {
  return p === root || p.startsWith(`${root}/`);
}

/** Root-owned regular ELF file whose every ancestor dir is root-owned and not group/other writable. */
function rootOwnedElfProblem(real: string): string | null {
  const st = lstatOrNull(real);
  if (!st || !st.isFile()) return "is not a regular file";
  if (st.uid !== 0 || (st.mode & 0o022) !== 0) return "is not root-owned or is group/other writable";
  if ((st.mode & 0o6000) !== 0) return "is setuid/setgid";
  for (let d = path.dirname(real); ; d = path.dirname(d)) {
    const ds = lstatOrNull(d);
    if (!ds || !ds.isDirectory() || ds.uid !== 0 || (ds.mode & 0o022) !== 0) {
      return `has a parent dir (${d}) that is not root-owned or is group/other writable`;
    }
    if (d === "/") break;
  }
  let fd: number | undefined;
  try {
    fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const buf = Buffer.alloc(4);
    if (fs.readSync(fd, buf, 0, 4, 0) !== 4 || buf.toString("latin1") !== "\x7fELF") {
      return "is not an ELF binary (scripts are never allowed)";
    }
  } catch {
    return "cannot be read";
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return null;
}

/**
 * P2-B1: a launch WITHOUT an agent identity while isolation is on. Refused
 * unless one serverCommandRules entry allows exactly this command; returns
 * the spawn target (realpath command, minimal env) when it does.
 */
export function planNoIdentityServerLaunch(
  config: AgentIsolationConfig,
  input: PlanAgentIsolatedLaunchInput,
): AgentIsolatedLaunchPlan {
  const label = input.command;
  const deny = (why: string) => new AgentIsolationError(`refusing "${label}" launched without an agent identity: ${why} (no-identity launches are denied by default while isolation is enabled)`);
  const resolved = typeof input.resolvedCommand === "string" && path.isAbsolute(input.resolvedCommand) ? input.resolvedCommand : null;
  if (!resolved) throw deny("the command does not resolve to an absolute path");
  let real: string;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    throw deny("the command cannot be resolved");
  }
  const rule = (config.serverCommandRules ?? []).find((r) => r.command === resolved || realpathOrSelf(r.command) === real);
  if (!rule) throw deny("no serverCommandRules entry allows it");
  if ([input.command, resolved, real].some((p) => isForbiddenServerCommandName(p))) {
    throw deny("shells, interpreters, exec wrappers and agent CLIs are never allowed");
  }
  const problem = rootOwnedElfProblem(real);
  if (problem) throw deny(`${real} ${problem}`);
  const args = input.args ?? [];
  if (rule.args && (rule.args.length !== args.length || rule.args.some((a, i) => a !== args[i]))) {
    throw deny("its argv does not match the rule");
  }
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  if (!path.isAbsolute(cwd)) throw deny("its cwd is not absolute");
  let realCwd: string;
  try {
    realCwd = fs.realpathSync(cwd);
  } catch {
    throw deny("its cwd does not exist");
  }
  const roots = [config.instanceRoot, config.runDirRoot, ...(config.workspaceRoots ?? []),
    ...(config.gitWorkspaceRoots ?? []).map((r) => r.path)];
  for (const r of roots) {
    for (const c of [path.normalize(cwd).replace(/\/+$/, "") || "/", realCwd]) {
      if (isUnderOrEqual(c, r) || isUnderOrEqual(c, realpathOrSelf(r))) {
        throw deny(`its cwd ${cwd} is inside an agent workspace, instance or run root`);
      }
    }
  }
  const base = input.baseEnv ?? process.env;
  const env: Record<string, string> = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ"]) {
    const value = base[key];
    if (typeof value === "string") env[key] = value;
  }
  if (typeof env.PATH === "string") {
    env.PATH = env.PATH.split(":").filter((p) => p && path.normalize(p).replace(/\/+$/, "") !== SERVER_GIT_SHIM_DIR).join(":");
  }
  for (const key of rule.envKeys) {
    const value = input.env?.[key];
    if (typeof value === "string") env[key] = value;
  }
  return { command: real, args, env, replaceEnv: true, serverRule: rule.command, cleanup: async () => { } };
}

/**
 * Decide how to launch. Returns null for a normal (non-isolated) spawn, or a
 * spawn target that runs the root helper through sudo. Throws
 * AgentIsolationError when isolation is required but impossible.
 */
export function planAgentIsolatedLaunch(input: PlanAgentIsolatedLaunchInput): AgentIsolatedLaunchPlan | null {
  const config = input.loadConfig ? input.loadConfig() : loadAgentIsolationConfig();
  if (!config) return null;
  if (input.remote) return null; // remote execution targets are out of RR1 scope
  const rawAgentId = input.env?.PAPERCLIP_AGENT_ID;
  const agentId = typeof rawAgentId === "string" ? rawAgentId.trim() : "";
  const entry = agentId ? config.agents.get(agentId) : undefined;
  const protectedCommand = isProtectedAgentCommand(config, input.resolvedCommand);
  const knownAgentCli = KNOWN_AGENT_CLI_NAMES.has(commandBaseName(input.resolvedCommand)) ||
    KNOWN_AGENT_CLI_NAMES.has(commandBaseName(input.command)) ||
    KNOWN_AGENT_CLI_NAMES.has(commandBaseName(realpathOrSelf(input.resolvedCommand ?? "")));
  // B1: any launch that carries an agent identity is in scope, whatever the command.
  if (agentId && !entry) {
    throw new AgentIsolationError(`refusing to launch "${input.command}" for agent ${agentId}: it has no isolated OS user in the agent map`);
  }
  if (!agentId || !entry) {
    if (protectedCommand) {
      throw new AgentIsolationError(`refusing to launch pinned agent CLI "${input.command}" without an agent identity (PAPERCLIP_AGENT_ID)`);
    }
    if (knownAgentCli) {
      throw new AgentIsolationError(`refusing to launch agent CLI "${input.command}" outside the isolated launcher`);
    }
    // P2-B1: default-deny; only a root-authored serverCommandRules entry allows it.
    return planNoIdentityServerLaunch(config, input);
  }
  if (!protectedCommand) {
    throw new AgentIsolationError(`refusing to launch "${input.command}" for mapped agent ${agentId}: command is not a pinned agent CLI`);
  }
  if (input.localProcessSandbox) {
    throw new AgentIsolationError("the bwrap local process sandbox cannot be combined with OS identity isolation");
  }
  const runId = typeof input.runId === "string" ? input.runId : "";
  const workspaces = runAssignedWorkspaces(config, agentId, runId);
  const cwdTop = workspaceTopOf(config, input.cwd);
  const env = buildIsolatedChildEnv(input.baseEnv ?? process.env, input.env, {
    shared: entry.shared,
    safeDirectories: [...workspaces, ...(cwdTop ? [cwdTop] : []), ...(input.cwd ? [path.normalize(input.cwd)] : [])],
    extraCeilings: [config.runDirRoot],
  });
  const runDirs = deriveRunDirs(config, agentId, runId, AI_HOME_HINT_ENV_KEYS.map((k) => input.env?.[k]));
  const readDirs = new Set<string>();
  for (const a of input.args ?? []) {
    for (const v of typeof a === "string" && a.includes("=") ? [a, a.slice(a.indexOf("=") + 1)] : [a]) {
      const b = agentPromptBundleDir(config, agentId, v);
      if (b) readDirs.add(b);
    }
  }
  const request = {
    version: 1,
    agentId,
    runId: UUID_RE.test(runId) ? runId : null,
    command: input.resolvedCommand,
    args: input.args ?? [],
    cwd: input.cwd,
    env,
    runDirs,
    readDirs: [...readDirs].sort(),
    workspaces,
  };
  const name = `${crypto.randomBytes(24).toString("base64url")}.json`;
  const requestPath = path.join(config.spoolDir, name);
  let spoolStat: fs.Stats;
  try {
    spoolStat = fs.lstatSync(config.spoolDir);
  } catch (err) {
    throw new AgentIsolationError(`launch spool ${config.spoolDir} is missing (${errCode(err)})`);
  }
  if (!spoolStat.isDirectory() || (spoolStat.mode & 0o077) !== 0) {
    throw new AgentIsolationError(`launch spool ${config.spoolDir} must be a 0700 directory`);
  }
  const fd = fs.openSync(requestPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(request));
  } finally {
    fs.closeSync(fd);
  }
  return {
    command: config.sudoPath,
    args: ["-n", "--", config.helperPath, "--request", name],
    // sudo resets the environment anyway; give it nothing worth leaking.
    env: { PATH: "/usr/bin:/bin", LANG: env.LANG ?? "C.UTF-8" },
    replaceEnv: true,
    agentId,
    runDirs: request.runDirs,
    readDirs: request.readDirs,
    workspaces,
    cleanup: async () => {
      // The helper unlinks the request on read; remove it if it never ran.
      await fs.promises.rm(requestPath, { force: true }).catch(() => { });
    },
  };
}
