// BLA-433 RR1 regressions for the server-side launch planner and the
// runChildProcess integration. Ported from bla433 tests/agent-isolation.test.mjs.
//
// Runs unprivileged with synthetic fixtures and dummy secrets only. The real
// root helper (/usr/local/libexec/paperclip-agent-launch) is a host artefact
// and is not in this repository, so a fake `sudo` stub stands in for
// sudo + helper: it checks the exact argv shape, consumes the spool request
// and echoes it back. Helper-side validation (forbidden uids, binding
// re-checks as root, privilege drop) is covered by the host test suite.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as iso from "./agent-isolation.js";
import { runChildProcess, sanitizeInheritedPaperclipEnv } from "./server-utils.js";

const COMPANY = "b0f71539-5099-4ca6-9e17-5cb96724bc24";
const AGENT = "11111111-2222-4333-8444-555555555555";
const OTHER_AGENT = "99999999-2222-4333-8444-555555555555";
const UNMAPPED = "aaaaaaaa-2222-4333-8444-555555555555";
const RUN = "22222222-3333-4444-8555-666666666666";
const OTHER_RUN = "33333333-3333-4444-8555-666666666666";
const HASH = "a".repeat(64);
const HELPER = "/usr/local/libexec/paperclip-agent-launch";

let root: string;
let cfgPath: string;
let spool: string;
let inst: string;
let runRoot: string;
let fakeCli: string;
let fakeSudo: string;
let refuseFlag: string;
let ws: string;
let dirs: Record<string, string>;

function writeConfig(overrides: Record<string, unknown> = {}) {
  const cfg = {
    version: 1,
    enabled: true,
    serverUid: process.getuid!(),
    spoolDir: spool,
    instanceRoot: inst,
    runDirRoot: runRoot,
    workspaceRoots: [path.join(inst, "isolated-workspaces")],
    allowedCommands: [fakeCli],
    sharedGroup: null,
    minAgentUid: 2000,
    helperPath: HELPER,
    sudoPath: fakeSudo,
    gitWorkspaceRoots: [
      { path: path.join(inst, "isolated-workspaces"), depth: 2 },
      { path: path.join(inst, "workspaces"), depth: 1 },
    ],
    agents: { [AGENT]: { user: "nobody", shared: false } },
    ...overrides,
  };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  fs.chmodSync(cfgPath, 0o644);
}

function readRequest(plan: { args: string[] }) {
  return JSON.parse(fs.readFileSync(path.join(spool, plan.args[4]!), "utf8"));
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bla433-t-")));
  const etc = path.join(root, "etc");
  fs.mkdirSync(etc, { mode: 0o700 });
  cfgPath = path.join(etc, "agent-launch.json");
  spool = path.join(root, "spool");
  fs.mkdirSync(spool, { mode: 0o700 });
  inst = path.join(root, "inst");
  runRoot = path.join(root, "run");
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fakeCli = path.join(bin, "fakeclaude");
  fs.writeFileSync(fakeCli, "#!/bin/sh\necho fake\n", { mode: 0o755 });
  refuseFlag = path.join(root, "helper-refuses");
  fakeSudo = path.join(bin, "sudo");
  // Fake sudo + helper: require "-n -- <helper> --request <name>", consume the
  // request (as the helper does) and print it with the env sudo received.
  fs.writeFileSync(fakeSudo, `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const a = process.argv.slice(2);
if (a.length !== 5 || a[0] !== "-n" || a[1] !== "--" || a[2] !== ${JSON.stringify(HELPER)} || a[3] !== "--request") process.exit(99);
if (!/^[A-Za-z0-9_-]+\\.json$/.test(a[4])) process.exit(98);
const p = path.join(${JSON.stringify(spool)}, a[4]);
const req = JSON.parse(fs.readFileSync(p, "utf8"));
fs.unlinkSync(p);
if (fs.existsSync(${JSON.stringify(refuseFlag)})) { process.stderr.write("paperclip-agent-launch: refused: test stub\\n"); process.exit(125); }
process.stdout.write(JSON.stringify({ ok: true, request: req, sudoEnv: process.env, cwd: process.cwd() }));
`, { mode: 0o755 });
  const seg = iso.runScratchSegment(RUN);
  dirs = {
    home: path.join(runRoot, `paperclip-ai-${COMPANY}-conn-ABC123`),
    scratch: path.join(runRoot, `paperclip-run-bla-1-${seg}-Zz09ab`),
    gh: path.join(runRoot, "paperclip-github-runtime", RUN),
    mcp: path.join(inst, "companies", COMPANY, "agents", AGENT, "claude-runtime", "runs", RUN),
    otherMcp: path.join(inst, "companies", COMPANY, "agents", OTHER_AGENT, "claude-runtime", "runs", RUN),
    prompt: path.join(inst, "companies", COMPANY, "claude-prompt-cache", "agents", AGENT, HASH),
    // B2 targets that must never be handed to AGENT's run:
    otherScratch: path.join(runRoot, `paperclip-run-bla-2-${iso.runScratchSegment(OTHER_RUN)}-Qq11cd`),
    sameSegOtherAgent: path.join(runRoot, `paperclip-run-bla-3-${seg}-Rr22ef`),
    otherGh: path.join(runRoot, "paperclip-github-runtime", OTHER_RUN),
    otherHome: path.join(runRoot, `paperclip-ai-${COMPANY}-conn-PAPAPA`),
    unboundHome: path.join(runRoot, `paperclip-ai-${COMPANY}-conn-LEGACY`),
    otherPrompt: path.join(inst, "companies", COMPANY, "claude-prompt-cache", "agents", OTHER_AGENT, HASH),
    legacyPrompt: path.join(inst, "companies", COMPANY, "claude-prompt-cache", HASH),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const marker = (d: string, name: string, body: unknown) =>
    fs.writeFileSync(path.join(d, name), JSON.stringify(body), { mode: 0o600 });
  marker(dirs.scratch!, iso.RUN_SCRATCH_MARKER, { version: 1, agentId: AGENT, runId: RUN });
  marker(dirs.otherScratch!, iso.RUN_SCRATCH_MARKER, { version: 1, agentId: OTHER_AGENT, runId: OTHER_RUN });
  marker(dirs.sameSegOtherAgent!, iso.RUN_SCRATCH_MARKER, { version: 1, agentId: OTHER_AGENT, runId: RUN });
  marker(dirs.home!, iso.AI_HOME_BINDING_MARKER, { version: 1, agentId: AGENT });
  marker(dirs.otherHome!, iso.AI_HOME_BINDING_MARKER, { version: 1, agentId: OTHER_AGENT });
  fs.mkdirSync(path.join(dirs.home!, "provider"));
  fs.mkdirSync(path.join(dirs.gh!, "gh-config"));
  fs.mkdirSync(path.join(dirs.mcp!, "mcp"));
  fs.writeFileSync(path.join(dirs.mcp!, "mcp", "config.json"), "{}");
  fs.writeFileSync(path.join(dirs.prompt!, "agent-instructions.md"), "x");
  ws = path.join(inst, "isolated-workspaces", COMPANY, "ws1");
  fs.mkdirSync(ws, { recursive: true });
  iso.__setAgentIsolationConfigPathForTests(cfgPath);
  writeConfig();
});

afterAll(() => {
  iso.__setAgentIsolationConfigPathForTests(null);
  iso.__resetRunWorkspacesForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

function agentEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PAPERCLIP_AGENT_ID: AGENT,
    PAPERCLIP_API_KEY: "dummy-run-token",
    HOME: dirs.home!,
    CLAUDE_CONFIG_DIR: path.join(dirs.home!, "provider"),
    TMPDIR: dirs.scratch!,
    PAPERCLIP_RUN_SCRATCH_DIR: dirs.scratch!,
    PAPERCLIP_GITHUB_LAUNCHER_DIR: dirs.gh!,
    GH_CONFIG_DIR: path.join(dirs.gh!, "gh-config"),
    ...extra,
  };
}

const agentArgs = () => [
  "--print", "--append-system-prompt-file", path.join(dirs.prompt!, "agent-instructions.md"),
  "--mcp-config", path.join(dirs.mcp!, "mcp", "config.json"), "--add-dir", dirs.prompt!,
];

function spoolEntries() {
  return fs.readdirSync(spool);
}

async function run(
  command: string,
  args: string[],
  env: Record<string, string>,
  extraOpts: { cwd?: string } = {},
  runId = RUN,
) {
  return runChildProcess(runId, command, args, {
    cwd: ws, env, timeoutSec: 30, graceSec: 1, onLog: async () => { }, ...extraOpts,
  });
}

// ------------------------------------------------------------- planner units

describe("agent isolation planner", () => {
  it("config absent or disabled: no isolation (phase A install is inert)", () => {
    iso.__setAgentIsolationConfigPathForTests(path.join(root, "missing.json"));
    expect(iso.loadAgentIsolationConfig()).toBeNull();
    expect(iso.planAgentIsolatedLaunch({ command: "/bin/sh", resolvedCommand: "/bin/sh", args: [], cwd: ws, env: {} })).toBeNull();
    iso.__setAgentIsolationConfigPathForTests(cfgPath);
    writeConfig({ enabled: false });
    expect(iso.planAgentIsolatedLaunch({ command: fakeCli, resolvedCommand: fakeCli, args: [], cwd: ws, env: agentEnv() })).toBeNull();
    expect(iso.planAgentIsolatedLaunch({ command: "/bin/sh", resolvedCommand: "/bin/sh", args: [], cwd: ws, env: { PAPERCLIP_AGENT_ID: UNMAPPED } })).toBeNull();
    writeConfig();
  });

  it("unsafe or invalid config fails closed", () => {
    fs.chmodSync(cfgPath, 0o666);
    expect(() => iso.loadAgentIsolationConfig()).toThrow(/root-owned and not group\/other writable/);
    fs.chmodSync(cfgPath, 0o644);
    fs.writeFileSync(cfgPath, "{not json");
    expect(() => iso.loadAgentIsolationConfig()).toThrow(/not valid JSON/);
    writeConfig({ allowedCommands: [] });
    expect(() => iso.loadAgentIsolationConfig()).toThrow(/allowedCommands is empty/);
    writeConfig({ version: 2 });
    expect(() => iso.loadAgentIsolationConfig()).toThrow(/version must be 1/);
    writeConfig({ agents: { "not-a-uuid": { user: "x" } } });
    expect(() => iso.loadAgentIsolationConfig()).toThrow(/agents map is invalid/);
    writeConfig();
  });

  it("pinned CLI without agent identity is refused", () => {
    expect(() => iso.planAgentIsolatedLaunch({ command: fakeCli, resolvedCommand: fakeCli, args: [], cwd: ws, env: {} }))
      .toThrow(/without an agent identity/);
  });

  it("pinned CLI for an unmapped agent is refused", () => {
    expect(() => iso.planAgentIsolatedLaunch({ command: fakeCli, resolvedCommand: fakeCli, args: [], cwd: ws, env: { PAPERCLIP_AGENT_ID: UNMAPPED } }))
      .toThrow(/no isolated OS user/);
  });

  it("B1: an unmapped agent is refused whatever the command (no same-uid spawn)", () => {
    for (const cmd of ["/bin/sh", "/usr/bin/env", fakeCli]) {
      expect(() => iso.planAgentIsolatedLaunch({ command: cmd, resolvedCommand: cmd, args: [], cwd: ws, env: { PAPERCLIP_AGENT_ID: UNMAPPED } }), cmd)
        .toThrow(/no isolated OS user/);
    }
  });

  it("B1: a known agent CLI without identity is refused (new codex/gemini/... hires)", () => {
    for (const name of ["codex", "gemini", "cursor-agent", "opencode", "pi", "grok", "kimi", "acpx", "claude-agent-acp"]) {
      const p = path.join(root, "bin", name);
      fs.writeFileSync(p, "#!/bin/sh\n", { mode: 0o755 });
      expect(() => iso.planAgentIsolatedLaunch({ command: name, resolvedCommand: p, args: [], cwd: ws, env: {} }), name)
        .toThrow(/outside the isolated launcher/);
    }
  });

  it("B1: the engine guard refuses while isolation is enabled", () => {
    expect(() => iso.assertAgentEngineAllowedUnderIsolation("ACP (acpx)")).toThrow(/refusing the ACP \(acpx\) engine/);
    writeConfig({ enabled: false });
    expect(() => iso.assertAgentEngineAllowedUnderIsolation("ACP (acpx)")).not.toThrow();
    writeConfig();
  });

  it("mapped agent launching a non-pinned command is refused", () => {
    expect(() => iso.planAgentIsolatedLaunch({ command: "/bin/sh", resolvedCommand: "/bin/sh", args: [], cwd: ws, env: { PAPERCLIP_AGENT_ID: AGENT } }))
      .toThrow(/not a pinned agent CLI/);
  });

  it("bwrap sandbox combined with isolation is refused", () => {
    expect(() => iso.planAgentIsolatedLaunch({
      command: fakeCli, resolvedCommand: fakeCli, args: [], cwd: ws, env: { PAPERCLIP_AGENT_ID: AGENT }, localProcessSandbox: { workspaceDir: ws },
    })).toThrow(/cannot be combined/);
  });

  it("remote execution targets are out of scope (null plan)", () => {
    expect(iso.planAgentIsolatedLaunch({ command: fakeCli, resolvedCommand: fakeCli, args: [], cwd: ws, env: {}, remote: true })).toBeNull();
  });
});

// ------------------------------------------- P2-B1: no-identity default-deny

describe("P2-B1 no-identity default-deny", () => {
  it("a launch without identity and without a rule is refused (shell, env, git, any binary)", () => {
    const srvCwd = path.join(root, "srvcwd");
    fs.mkdirSync(srvCwd, { recursive: true });
    for (const [command, resolvedCommand] of [["/bin/sh", "/bin/sh"], ["git", "/usr/bin/git"], ["/usr/bin/env", "/usr/bin/env"],
      ["printenv", "/usr/bin/printenv"], ["models", path.join(ws, "models")], ["nope", null]] as const) {
      expect(() => iso.planAgentIsolatedLaunch({ command, resolvedCommand, args: [], cwd: srvCwd, env: {} }), command)
        .toThrow(/launched without an agent identity: .*denied by default while isolation is enabled/);
    }
  });

  it("a rule naming a shell, interpreter, exec wrapper or agent CLI fails the config closed", () => {
    for (const command of ["/bin/sh", "/usr/bin/bash", "/usr/bin/env", "/usr/bin/python3", "/usr/bin/python3.11", "/usr/bin/perl",
      "/usr/bin/node", "/usr/bin/find", "/usr/bin/xargs", "/usr/bin/timeout", "/usr/bin/git", "/usr/bin/sudo", fakeCli, "/opt/x/grok"]) {
      writeConfig({ serverCommandRules: [{ command }] });
      expect(() => iso.loadAgentIsolationConfig(), command)
        .toThrow(/serverCommandRules\[0\] names a shell, interpreter, exec wrapper or agent CLI/);
    }
    writeConfig({ serverCommandRules: [{ command: "/usr/bin/printenv", envKeys: ["LD_PRELOAD"] }] });
    expect(() => iso.loadAgentIsolationConfig()).toThrow(/envKeys invalid/);
    writeConfig({ serverCommandRules: [{ command: "/usr/bin/printenv", envKeys: ["BETTER_AUTH_SECRET"] }] });
    expect(() => iso.loadAgentIsolationConfig()).toThrow(/envKeys invalid/);
    writeConfig({ serverCommandRules: { command: "/usr/bin/printenv" } });
    expect(() => iso.loadAgentIsolationConfig()).toThrow(/serverCommandRules must be an array/);
    writeConfig();
  });

  it("a rule allows only a root-owned ELF binary, exact argv, cwd outside the agent/run/instance roots", () => {
    const srvCwd = path.join(root, "srvcwd");
    fs.mkdirSync(srvCwd, { recursive: true });
    const userCopy = path.join(root, "bin", "printenv");
    fs.copyFileSync("/usr/bin/printenv", userCopy);
    fs.chmodSync(userCopy, 0o755);
    const link = path.join(ws, "printenv-link");
    fs.symlinkSync("/usr/bin/printenv", link);
    const shLink = path.join(ws, "printenv");
    fs.symlinkSync("/bin/sh", shLink);
    writeConfig({ serverCommandRules: [{ command: "/usr/bin/printenv", args: ["FOO"], envKeys: ["FOO"] },
      { command: "/usr/bin/ldd" }, { command: userCopy }] });
    try {
      const plan = (command: string, resolvedCommand: string, args: string[], cwd: string, env: Record<string, string> = {}) =>
        iso.planAgentIsolatedLaunch({ command, resolvedCommand, args, cwd, env, baseEnv: { PATH: "/usr/bin:/bin", BETTER_AUTH_SECRET: "dummy" } });
      const ok = plan("printenv", "/usr/bin/printenv", ["FOO"], srvCwd, { FOO: "bar", LD_PRELOAD: "/tmp/evil.so", PAPERCLIP_API_KEY: "dummy" });
      expect(ok?.command).toBe(fs.realpathSync("/usr/bin/printenv"));
      expect(ok?.replaceEnv).toBe(true);
      expect(ok?.env, "minimal env: no LD_*, no run token, no server secret").toEqual({ PATH: "/usr/bin:/bin", FOO: "bar" });
      // an agent-written symlink to the allowed binary runs the root-owned realpath, never the link
      expect(plan("printenv-link", link, ["FOO"], srvCwd)?.command).toBe(fs.realpathSync("/usr/bin/printenv"));
      expect(() => plan("printenv", shLink, ["FOO"], srvCwd), "a link named like the rule but resolving to sh")
        .toThrow(/no serverCommandRules entry allows it/);
      expect(() => plan("printenv", "/usr/bin/printenv", ["BAR"], srvCwd)).toThrow(/argv does not match the rule/);
      expect(() => plan("ldd", "/usr/bin/ldd", [], srvCwd), "root-owned script").toThrow(/is not an ELF binary/);
      expect(() => plan("printenv", userCopy, [], srvCwd), "server-uid-owned copy").toThrow(/is not root-owned/);
      for (const cwd of [ws, dirs.scratch!, runRoot, inst, path.join(inst, "workspaces")]) {
        fs.mkdirSync(cwd, { recursive: true });
        expect(() => plan("printenv", "/usr/bin/printenv", ["FOO"], cwd), cwd).toThrow(/inside an agent workspace, instance or run root/);
      }
      const cwdLink = path.join(root, "cwd-link");
      fs.symlinkSync(ws, cwdLink);
      expect(() => plan("printenv", "/usr/bin/printenv", ["FOO"], cwdLink), "a symlinked cwd into a workspace").toThrow(/inside an agent workspace/);
      expect(() => plan("printenv", "/usr/bin/printenv", ["FOO"], path.join(root, "no-such-dir"))).toThrow(/cwd does not exist/);
    } finally {
      for (const f of [link, shLink, userCopy, path.join(root, "cwd-link")]) fs.rmSync(f, { force: true });
      writeConfig();
    }
  });
});

// ------------------------------------------------- request, B2/B3 bindings

describe("isolated launch request and run bindings", () => {
  it("plan: request is a 0600 spool file, env is allowlisted, dirs derived, nothing on argv", async () => {
    const before = spoolEntries().length;
    const plan = iso.planAgentIsolatedLaunch({
      runId: RUN,
      command: fakeCli, resolvedCommand: fakeCli, args: agentArgs(), cwd: ws,
      env: agentEnv(), baseEnv: { PATH: "/usr/bin:/bin", BETTER_AUTH_SECRET: "dummy-server-secret", INVOCATION_ID: "x", LANG: "C.UTF-8" },
    })!;
    expect(plan.command).toBe(fakeSudo);
    expect(plan.args.slice(0, 4)).toEqual(["-n", "--", HELPER, "--request"]);
    expect(plan.args).toHaveLength(5);
    expect(plan.args.join(" "), "no secret on argv").not.toContain("dummy");
    expect(Object.keys(plan.env).sort()).toEqual(["LANG", "PATH"]);
    expect(spoolEntries()).toHaveLength(before + 1);
    const reqPath = path.join(spool, plan.args[4]!);
    expect(fs.statSync(reqPath).mode & 0o777).toBe(0o600);
    const req = readRequest(plan);
    expect(req.env.BETTER_AUTH_SECRET).toBeUndefined();
    expect(req.env.INVOCATION_ID).toBeUndefined();
    expect(req.env.PAPERCLIP_API_KEY).toBe("dummy-run-token");
    expect(req.runDirs).toEqual([dirs.mcp, dirs.home, dirs.gh, dirs.scratch].sort());
    expect(req.readDirs).toEqual([dirs.prompt]);
    expect(req.runId).toBe(RUN);
    await plan.cleanup();
    expect(spoolEntries()).toHaveLength(before);
  });

  it("B2: argv/config-env naming other runs' or agents' dirs never reach the hand-over", async () => {
    const hostileArgs = [
      `--add-dir=${dirs.otherScratch}`, "--add-dir", dirs.sameSegOtherAgent!, "--add-dir", dirs.otherGh!,
      "--mcp-config", path.join(dirs.otherMcp!, "x.json"), "--add-dir", dirs.otherPrompt!, `--add-dir=${dirs.legacyPrompt}`,
    ];
    const hostileEnv = {
      PAPERCLIP_AGENT_ID: AGENT, TMPDIR: dirs.otherScratch!, HOME: dirs.otherHome!, CLAUDE_CONFIG_DIR: dirs.unboundHome!,
      PAPERCLIP_RUN_SCRATCH_DIR: dirs.sameSegOtherAgent!, PAPERCLIP_GITHUB_LAUNCHER_DIR: dirs.otherGh!,
    };
    // runId comes only from runChildProcess's argument; a forged env value is ignored
    const plan = iso.planAgentIsolatedLaunch({
      runId: "66666666-3333-4444-8555-666666666666", command: fakeCli, resolvedCommand: fakeCli, args: hostileArgs, cwd: ws,
      env: { ...hostileEnv, PAPERCLIP_RUN_ID: RUN },
    })!;
    const req = readRequest(plan);
    await plan.cleanup();
    expect(req.runDirs, "a fresh run owns none of these dirs").toEqual([]);
    expect(req.readDirs).toEqual([]);
    const plan2 = iso.planAgentIsolatedLaunch({ runId: RUN, command: fakeCli, resolvedCommand: fakeCli, args: hostileArgs, cwd: ws, env: hostileEnv })!;
    const req2 = readRequest(plan2);
    expect(req2.runDirs, "only RUN's own, bound dirs").toEqual([dirs.mcp, dirs.gh, dirs.scratch].sort());
    expect(req2.readDirs).toEqual([]);
    await plan2.cleanup();
  });

  it("B3: the workspaces the server registered for this run are handed over; another agent's registration is refused", async () => {
    const top = path.join(inst, "isolated-workspaces", COMPANY, "fresh-ws");
    fs.mkdirSync(path.join(top, "sub"), { recursive: true });
    const home = path.join(inst, "workspaces", AGENT);
    fs.mkdirSync(home, { recursive: true });
    iso.registerRunWorkspaces(RUN, AGENT, [path.join(top, "sub"), home]);
    const plan = iso.planAgentIsolatedLaunch({ runId: RUN, command: fakeCli, resolvedCommand: fakeCli, args: [], cwd: path.join(top, "sub"), env: { PAPERCLIP_AGENT_ID: AGENT } })!;
    expect(plan.workspaces).toEqual([top, home].sort());
    await plan.cleanup();
    iso.registerRunWorkspaces(OTHER_RUN, OTHER_AGENT, [top]);
    expect(() => iso.planAgentIsolatedLaunch({ runId: OTHER_RUN, command: fakeCli, resolvedCommand: fakeCli, args: [], cwd: top, env: { PAPERCLIP_AGENT_ID: AGENT } }))
      .toThrow(/registered for a different agent/);
    // unregistered run: nothing handed over (a config cwd is never a hand-over source)
    const plan3 = iso.planAgentIsolatedLaunch({ runId: "55555555-3333-4444-8555-666666666666", command: fakeCli, resolvedCommand: fakeCli, args: [], cwd: top, env: { PAPERCLIP_AGENT_ID: AGENT } })!;
    expect(plan3.workspaces).toEqual([]);
    await plan3.cleanup();
    iso.__resetRunWorkspacesForTests();
  });

  it("registerRunWorkspaces ignores non-UUID ids and non-absolute dirs", async () => {
    iso.registerRunWorkspaces("not-a-run", AGENT, [ws]);
    iso.registerRunWorkspaces(RUN, AGENT, ["relative/dir", 42, null, ws]);
    const plan = iso.planAgentIsolatedLaunch({ runId: RUN, command: fakeCli, resolvedCommand: fakeCli, args: [], cwd: ws, env: { PAPERCLIP_AGENT_ID: AGENT } })!;
    expect(plan.workspaces).toEqual([path.join(inst, "isolated-workspaces", COMPANY, "ws1")]);
    await plan.cleanup();
    iso.__resetRunWorkspacesForTests();
  });

  it("sanitizeInheritedPaperclipEnv strips server secrets on the shared path", () => {
    const env = sanitizeInheritedPaperclipEnv({ BETTER_AUTH_SECRET: "d", PAPERCLIP_AGENT_JWT_SECRET: "d", DATABASE_URL: "d", PATH: "/bin" });
    expect(env).toEqual({ PATH: "/bin" });
  });
});

// ------------------------------------------------------ runChildProcess e2e

describe("runChildProcess integration", () => {
  it("routes a mapped agent CLI through sudo + helper with a replaced env", async () => {
    process.env.BETTER_AUTH_SECRET = "dummy-server-secret";
    try {
      const res = await run(fakeCli, agentArgs(), agentEnv({ LD_PRELOAD: "/tmp/evil.so" }));
      expect(res.exitCode, res.stderr).toBe(0);
      const out = JSON.parse(res.stdout);
      expect(out.ok).toBe(true);
      expect(out.request.command).toBe(fakeCli);
      expect(out.request.agentId).toBe(AGENT);
      expect(out.request.runId).toBe(RUN);
      expect(out.request.cwd).toBe(ws);
      expect(out.request.env.HOME).toBe(dirs.home);
      expect(out.request.env.BETTER_AUTH_SECRET).toBeUndefined();
      expect(out.request.readDirs).toEqual([dirs.prompt]);
      expect(out.request.runDirs).toEqual([dirs.mcp, dirs.home, dirs.gh, dirs.scratch].sort());
      // sudo itself gets only PATH and LANG (replaceEnv), never the merged server env
      expect(Object.keys(out.sudoEnv).sort()).toEqual(["LANG", "PATH"]);
      expect(spoolEntries(), "helper consumed the request").toHaveLength(0);
    } finally {
      delete process.env.BETTER_AUTH_SECRET;
    }
  });

  it("a helper refusal fails the run (exit 125), no same-uid fallback", async () => {
    fs.writeFileSync(refuseFlag, "");
    try {
      const res = await run(fakeCli, ["--print"], agentEnv());
      expect(res.exitCode).toBe(125);
      expect(res.stderr).toMatch(/refused/);
      expect(res.stdout, "the CLI never ran").not.toContain("fake");
    } finally {
      fs.rmSync(refuseFlag, { force: true });
    }
  });

  it("pinned CLI without identity rejects before spawning", async () => {
    await expect(run(fakeCli, ["--print"], {})).rejects.toThrow(/without an agent identity/);
  });

  it("missing sudo/helper fails closed", async () => {
    writeConfig({ sudoPath: path.join(root, "bin", "no-such-sudo") });
    try {
      await expect(run(fakeCli, ["--print"], agentEnv())).rejects.toThrow(/Failed to start command/);
    } finally {
      writeConfig();
    }
    for (const f of spoolEntries()) fs.rmSync(path.join(spool, f));
  });

  it("P2-B1: a no-identity /bin/sh launch (grok-style planted script in the cwd) rejects before spawning", async () => {
    const marker = path.join(root, "P2B1-MARKER");
    fs.writeFileSync(path.join(ws, "models"), `id -u > ${marker}\n`);
    try {
      await expect(run("/bin/sh", ["models"], {})).rejects.toThrow(/launched without an agent identity/);
      await expect(run("/usr/bin/env", [], { FOO: "bar" })).rejects.toThrow(/launched without an agent identity/);
      expect(fs.existsSync(marker), "nothing ran as the server uid").toBe(false);
    } finally {
      fs.rmSync(path.join(ws, "models"), { force: true });
    }
  });

  it("P2-B1: a rule-allowed server command runs with a minimal env and without server secrets", async () => {
    const srvCwd = path.join(root, "srvcwd");
    fs.mkdirSync(srvCwd, { recursive: true });
    writeConfig({ serverCommandRules: [{ command: "/usr/bin/printenv", envKeys: ["FOO"] }] });
    process.env.BETTER_AUTH_SECRET = "dummy-server-secret";
    try {
      const res = await run("printenv", [], { FOO: "bar", LD_PRELOAD: "/tmp/evil.so" }, { cwd: srvCwd });
      expect(res.exitCode, res.stderr).toBe(0);
      expect(res.stdout).toMatch(/^FOO=bar$/m);
      expect(res.stdout).not.toMatch(/BETTER_AUTH_SECRET|LD_PRELOAD|PAPERCLIP_/);
      await expect(run("printenv", [], { FOO: "bar" }), "same rule, cwd in a workspace").rejects.toThrow(/inside an agent workspace/);
    } finally {
      delete process.env.BETTER_AUTH_SECRET;
      writeConfig();
    }
  });

  it("isolation disabled: an ordinary launch is unchanged (merged env, server secrets still stripped)", async () => {
    writeConfig({ enabled: false });
    process.env.BETTER_AUTH_SECRET = "dummy-server-secret";
    try {
      const res = await run("/bin/sh", ["-c", "echo \"FOO=$FOO SECRET=${BETTER_AUTH_SECRET:-none}\""], { FOO: "bar" });
      expect(res.exitCode, res.stderr).toBe(0);
      expect(res.stdout.trim()).toBe("FOO=bar SECRET=none");
    } finally {
      delete process.env.BETTER_AUTH_SECRET;
      writeConfig();
    }
  });
});

// ------------------------------------------------------------------- M1 / env

describe("isolated env (M1)", () => {
  it("private agents get no safe.directory; shared agents only exact paths; ceilings always", () => {
    const priv = iso.buildIsolatedChildEnv({ PATH: "/bin" }, {}, { shared: false, safeDirectories: ["/w/a"] });
    expect(priv.GIT_CONFIG_COUNT).toBeUndefined();
    expect(JSON.stringify(priv)).not.toContain("safe.directory");
    expect(priv.GIT_CEILING_DIRECTORIES!.split(":")).toEqual(["/tmp", "/var/tmp", "/dev/shm"]);
    const shared = iso.buildIsolatedChildEnv({}, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "a.b", GIT_CONFIG_VALUE_0: "1" },
      { shared: true, safeDirectories: ["/w/b", "/w/a", "/w/a", "*", "/w/*", "/"], extraCeilings: ["/var/lib/paperclip/tmp"] });
    expect(shared.GIT_CONFIG_COUNT).toBe("3");
    expect([shared.GIT_CONFIG_KEY_1, shared.GIT_CONFIG_VALUE_1, shared.GIT_CONFIG_KEY_2, shared.GIT_CONFIG_VALUE_2])
      .toEqual(["safe.directory", "/w/a", "safe.directory", "/w/b"]);
    expect(Object.values(shared)).not.toContain("*");
    expect(shared.GIT_CEILING_DIRECTORIES!.split(":")).toContain("/var/lib/paperclip/tmp");
    expect(() => iso.buildIsolatedChildEnv({}, { GIT_CONFIG_COUNT: "x" }, { shared: true, safeDirectories: ["/w"] })).toThrow(/malformed/);
  });

  it("the planner gives PA/CFO-class agents no safe.directory, shared agents their workspace only", async () => {
    const p1 = iso.planAgentIsolatedLaunch({ runId: RUN, command: fakeCli, resolvedCommand: fakeCli, args: [], cwd: ws, env: { PAPERCLIP_AGENT_ID: AGENT } })!;
    const r1 = readRequest(p1);
    expect(JSON.stringify(r1.env)).not.toContain("safe.directory");
    expect(r1.env.GIT_CEILING_DIRECTORIES).toContain("/tmp");
    expect(r1.env.GIT_CEILING_DIRECTORIES.split(":")).toContain(runRoot);
    await p1.cleanup();
    writeConfig({ agents: { [AGENT]: { user: "nobody", shared: true } } });
    try {
      const p2 = iso.planAgentIsolatedLaunch({ runId: RUN, command: fakeCli, resolvedCommand: fakeCli, args: [], cwd: ws, env: { PAPERCLIP_AGENT_ID: AGENT } })!;
      const r2 = readRequest(p2);
      const vals = Object.entries(r2.env as Record<string, string>).filter(([k]) => k.startsWith("GIT_CONFIG_VALUE_")).map(([, v]) => v);
      expect(vals).toEqual([ws]);
      await p2.cleanup();
    } finally {
      writeConfig();
    }
  });

  it("isolated env never carries the server-only git shim dir on PATH", () => {
    const env = iso.buildIsolatedChildEnv({ PATH: "/usr/local/lib/paperclip-isolation/bin:/opt/paperclip/bin:/usr/bin" }, {});
    expect(env.PATH).toBe("/opt/paperclip/bin:/usr/bin");
    const env2 = iso.buildIsolatedChildEnv({}, { PATH: "/usr/local/lib/paperclip-isolation/bin/:/bin" });
    expect(env2.PATH).toBe("/bin");
  });
});
