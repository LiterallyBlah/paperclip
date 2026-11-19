// BLA-433 RR1: server-side isolation regressions, ported from bla433
// tests/server-overlays.test.mjs to the TypeScript source.
//  - B1: the Paperclip Runner native runtime and its probe are refused while
//        isolation is enabled, before any agent process starts.
//  - m5: workspace provision/job shells (recorded and unrecorded) are refused
//        while isolation is enabled; no shell runs.
//  - B2/B3: the heartbeat registers server-resolved workspaces; managed AI
//        homes carry a server-written binding marker.
//  - P2-B1: local adapter environment probes are refused at the registry,
//        and below it a no-identity launch cannot run as the server uid.
// Synthetic fixtures and dummy values only; the isolation config is a fixture
// file pointed at through the test-only override.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as iso from "@paperclipai/adapter-utils/agent-isolation";
import type { WorkspaceOperationRecorder } from "../services/workspace-operations.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const AGENT = "11111111-2222-4333-8444-555555555555";
let root: string;
let cfgPath: string;

function writeConfig(enabled: boolean) {
  fs.writeFileSync(cfgPath, JSON.stringify({
    version: 1, enabled, serverUid: process.getuid!(), spoolDir: path.join(root, "spool"),
    instanceRoot: path.join(root, "inst"), runDirRoot: path.join(root, "run"),
    allowedCommands: ["/bin/true"], agents: { [AGENT]: { user: "nobody", shared: false } },
  }));
  fs.chmodSync(cfgPath, 0o644);
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bla433-srv-")));
  fs.mkdirSync(path.join(root, "etc"), { mode: 0o700 });
  cfgPath = path.join(root, "etc", "agent-launch.json");
  iso.__setAgentIsolationConfigPathForTests(cfgPath);
  writeConfig(true);
});

afterAll(() => {
  iso.__setAgentIsolationConfigPathForTests(null);
  fs.rmSync(root, { recursive: true, force: true });
});

function plantProbeFixture(tag: string) {
  const cwd = path.join(root, `agentws-${tag}`);
  fs.mkdirSync(cwd, { recursive: true });
  const marker = path.join(root, `MARKER-${tag}`);
  for (const w of ["models", "exec", "run", "--version", "-p", "--print", "-v", "--help", "--model"]) {
    fs.writeFileSync(path.join(cwd, w), `id -u > ${marker}\n`);
  }
  return { cwd, marker };
}

const grokCtx = (cwd: string) => ({
  companyId: "b0f71539-5099-4ca6-9e17-5cb96724bc24",
  adapterType: "grok_local",
  config: { command: "/bin/sh", cwd, engine: "cli" },
});

async function withoutAgentIdInProcessEnv<T>(fn: () => Promise<T>): Promise<T> {
  // these probes merge process.env; a test run inside an agent run would otherwise carry its id
  const saved = process.env.PAPERCLIP_AGENT_ID;
  delete process.env.PAPERCLIP_AGENT_ID;
  try {
    return await fn();
  } finally {
    if (saved !== undefined) process.env.PAPERCLIP_AGENT_ID = saved;
  }
}

describe("B1: Paperclip Runner native runtime", () => {
  it("fresh and persisted native runs are refused while isolation is enabled", async () => {
    writeConfig(true);
    const rm = await import("../services/native-runtime/runtime-mode.ts");
    const isIsolationRefusal = (e: unknown) =>
      (e as { code?: string }).code === "agent_os_isolation_enabled";
    const fresh = {
      enabled: true, runtimeConfig: {}, adapterConfig: {},
      agent: { status: "active", adapterType: "paperclip_runner" },
      issue: { id: "i", workMode: "standard" }, target: null, workspaceId: null,
    };
    expect(() => rm.resolveNativeRuntimeMode(fresh)).toThrow(expect.objectContaining({ code: "agent_os_isolation_enabled" }));
    expect(rm.resolveNativeRuntimeMode({ ...fresh, agent: { status: "active", adapterType: "claude_local" } }).kind).toBe("legacy");

    const persistedNative = { runtimeMode: "native", runtimeModeReason: "x", runtimeModeResolvedAt: new Date() };
    let err: unknown = null;
    try {
      rm.resolveHeartbeatRuntimeMode({
        persisted: persistedNative, enabled: true, adapterType: "paperclip_runner", adapterConfig: {},
        agentStatus: "active", issue: null, executionTarget: null,
      });
    } catch (e) { err = e; }
    expect(isIsolationRefusal(err)).toBe(true);
    err = null;
    try {
      rm.resolveHeartbeatNativeRuntimeMode({ ...fresh, persisted: persistedNative });
    } catch (e) { err = e; }
    expect(isIsolationRefusal(err)).toBe(true);

    // persisted legacy runs are untouched
    expect(rm.resolveHeartbeatRuntimeMode({
      persisted: { ...persistedNative, runtimeMode: "legacy" }, enabled: true, adapterType: "claude_local", adapterConfig: {},
      agentStatus: "active", issue: null, executionTarget: null,
    }).kind).toBe("legacy");

    // isolation disabled: the persisted native selection is unchanged
    writeConfig(false);
    try {
      expect(rm.resolveHeartbeatRuntimeMode({
        persisted: persistedNative, enabled: true, adapterType: "paperclip_runner", adapterConfig: {},
        agentStatus: "active", issue: null, executionTarget: null,
      }).kind).toBe("native");
    } finally {
      writeConfig(true);
    }
  });

  it("the Paperclip Runner probe is refused at the registry", async () => {
    writeConfig(true);
    const reg = await import("../adapters/registry.ts");
    const res = await reg.getServerAdapter("paperclip_runner").testEnvironment({ config: {}, companyId: "c", adapterType: "paperclip_runner" });
    expect(res.status).toBe("fail");
    expect(res.checks[0]?.code).toBe("agent_os_isolation_enabled");
  });
});

describe("m5: workspace-runtime shells", () => {
  function recorderDouble() {
    const ran: string[] = [];
    const recorder = {
      attachExecutionWorkspaceId: async () => {},
      recordOperation: async (input: { run: (...a: unknown[]) => Promise<unknown>; command?: string | null }) => {
        ran.push(input.command ?? "");
        await input.run(async () => {});
        return { id: "op-1" };
      },
    } as unknown as WorkspaceOperationRecorder;
    return { recorder, ran };
  }

  it("refuses workspace job shells (unrecorded and recorded) while isolation is enabled", async () => {
    writeConfig(true);
    const wr = await import("../services/workspace-runtime.ts");
    const ws = path.join(root, "ws");
    fs.mkdirSync(ws, { recursive: true });
    const marker = path.join(root, "provision-ran");
    const workspace = {
      baseCwd: ws, source: "project_primary" as const, projectId: null, workspaceId: null, repoUrl: null, repoRef: null,
      strategy: "project_primary" as const, cwd: ws, branchName: null, branchCreatedByRuntime: false, worktreePath: null,
      warnings: [], created: false,
    };
    const actor = { id: AGENT, name: "t", companyId: "c" };
    await expect(wr.runWorkspaceJobForControl({
      command: { name: "probe", command: `touch ${marker}` }, workspace, actor, issue: null, recorder: null,
    })).rejects.toThrow(/Agent process isolation: refusing workspace command/);
    const { recorder, ran } = recorderDouble();
    await expect(wr.runWorkspaceJobForControl({
      command: { name: "probe", command: `touch ${marker}` }, workspace, actor, issue: null, recorder,
    })).rejects.toThrow(/Agent process isolation: refusing workspace command/);
    expect(ran, "no operation was recorded or run").toEqual([]);
    expect(fs.existsSync(marker), "the shell never ran").toBe(false);

    // control: with isolation disabled the same job runs
    writeConfig(false);
    try {
      await wr.runWorkspaceJobForControl({
        command: { name: "probe", command: `touch ${marker}` }, workspace, actor, issue: null, recorder: null,
      });
      expect(fs.existsSync(marker)).toBe(true);
    } finally {
      writeConfig(true);
      fs.rmSync(marker, { force: true });
    }
  });

  it("local runtime services are guarded before any spawn", () => {
    const src = fs.readFileSync(path.join(here, "../services/workspace-runtime.ts"), "utf8");
    expect(src).toMatch(
      /async function spawnLocalRuntimeService\(input: StartLocalRuntimeServiceInput\): Promise<LocalRuntimeServiceStart> \{\n(?:\s*\/\/[^\n]*\n)*\s+if \(loadAgentIsolationConfig\(\)\) \{\n\s+throw new AgentIsolationError\("refusing local runtime service/,
    );
  });
});

describe("B2/B3 server hooks", () => {
  it("heartbeat registers the server-resolved workspaces; AI homes carry a binding marker", async () => {
    const hb = fs.readFileSync(path.join(here, "../services/heartbeat.ts"), "utf8");
    expect(hb).toMatch(/registerRunWorkspaces\(run\.id, agent\.id, \[\s*executionWorkspace\.cwd,\s*\(context\.paperclipWorkspace as \{ agentHome\?: unknown \}\)\.agentHome,\s*\]\)/);
    const ai = fs.readFileSync(path.join(here, "../services/ai-connection-runtime.ts"), "utf8");
    expect(ai).toMatch(/path\.join\(home, AI_HOME_BINDING_MARKER\),\s*JSON\.stringify\(\{ version: 1, agentId: input\.agentId, companyId: input\.companyId \}\),\s*\{ mode: 0o600, flag: "wx" \}/);
    expect(iso.AI_HOME_BINDING_MARKER).toBe(".paperclip-agent-binding.json");
    // the AI-runtime module loads in the real module graph
    await import("../services/ai-connection-runtime.ts");
  });
});

// ----------------------------------------------------------------- P2-B1 (r3)
// SE pass-2 probe F: grok_local testEnvironment with command=/bin/sh and a
// planted `models` script in the cwd wrote a marker as the server uid.

describe("P2-B1: local adapter probes", () => {
  it("grok_local /bin/sh + planted models is refused at the registry and leaves no marker", async () => {
    writeConfig(true);
    const reg = await import("../adapters/registry.ts");
    const { cwd, marker } = plantProbeFixture("reg");
    const res = await reg.getServerAdapter("grok_local").testEnvironment(grokCtx(cwd));
    expect(res.status).toBe("fail");
    expect(res.checks[0]?.code).toBe("agent_os_isolation_enabled");
    expect(fs.existsSync(marker), "no marker").toBe(false);
  });

  it("below the registry, the same probe cannot run as the server uid (planner default-deny)", async () => {
    writeConfig(true);
    const grok = await import("@paperclipai/adapter-grok-local/server");
    const { cwd, marker } = plantProbeFixture("direct");
    const out = await withoutAgentIdInProcessEnv(() =>
      grok.testEnvironment(grokCtx(cwd)).then((r) => JSON.stringify(r), (e) => String(e)));
    expect(out).toMatch(/launched without an agent identity: no serverCommandRules entry allows it/);
    expect(fs.existsSync(marker), "the command never ran: no marker, so no server-uid execution").toBe(false);
  });

  it("control: with isolation disabled the same probe does run as the server uid (the route was real)", async () => {
    writeConfig(false);
    try {
      const grok = await import("@paperclipai/adapter-grok-local/server");
      const { cwd, marker } = plantProbeFixture("control");
      await withoutAgentIdInProcessEnv(() => grok.testEnvironment(grokCtx(cwd)).catch(() => undefined));
      expect(fs.existsSync(marker), "control marker written").toBe(true);
      expect(fs.readFileSync(marker, "utf8").trim()).toBe(String(process.getuid!()));
    } finally {
      writeConfig(true);
    }
  });

  it("opencode/pi model discovery with /bin/sh + planted script cannot run as the server uid", async () => {
    writeConfig(true);
    const opencode = await import("@paperclipai/adapter-opencode-local/server");
    const pi = await import("@paperclipai/adapter-pi-local/server");
    const cases: Array<[string, (input: { command: string; cwd: string }) => Promise<unknown>, string, string]> = [
      ["opencode", (input) => opencode.discoverOpenCodeModels(input), "models", "oc"],
      ["pi", (input) => pi.discoverPiModels(input), "--list-models", "pi"],
    ];
    for (const [name, discover, argv0, tag] of cases) {
      const { cwd, marker } = plantProbeFixture(tag);
      fs.writeFileSync(path.join(cwd, argv0), `id -u > ${marker}\n`);
      const out = await withoutAgentIdInProcessEnv(() =>
        discover({ command: "/bin/sh", cwd }).then((r) => JSON.stringify(r), (e) => String(e)));
      expect(out, name).toMatch(/launched without an agent identity/);
      expect(fs.existsSync(marker), `${name}: no marker`).toBe(false);
    }
  });

  it("every local adapter probe is refused, including later-registered externals; network-only ones are not", async () => {
    writeConfig(true);
    const reg = await import("../adapters/registry.ts");
    const network = new Set(["http", "openclaw_gateway", "cursor_cloud"]);
    const seen: string[] = [];
    for (const a of reg.listServerAdapters()) {
      if (typeof a.testEnvironment !== "function" || network.has(a.type)) continue;
      const res = await a.testEnvironment({ companyId: "c", adapterType: a.type, config: { command: "/bin/sh", cwd: root } });
      expect(res.checks?.[0]?.code, a.type).toBe("agent_os_isolation_enabled");
      seen.push(a.type);
    }
    for (const t of ["claude_local", "codex_local", "grok_local", "opencode_local", "pi_local", "gemini_local", "cursor", "kimi_local", "process"]) {
      expect(seen.some((s) => s === t || s.startsWith(t)), `covered: ${t} (${seen.join(",")})`).toBe(true);
    }
    const marker = path.join(root, "MARKER-external");
    const touch = async () => {
      fs.writeFileSync(marker, "ran");
      return { adapterType: "x", status: "pass" as const, checks: [], testedAt: new Date().toISOString() };
    };
    const external = (type: string) => ({ type, execute: async () => ({ exitCode: 0, signal: null, timedOut: false }), testEnvironment: touch }) as never;
    reg.registerServerAdapter(external("droid_local"));
    reg.registerServerAdapter(Object.freeze(external("frozen_local")));
    for (const t of ["droid_local", "frozen_local"]) {
      const res = await reg.getServerAdapter(t).testEnvironment({ companyId: "c", adapterType: t, config: {} });
      expect(res.checks[0]?.code, t).toBe("agent_os_isolation_enabled");
    }
    expect(fs.existsSync(marker), "external probes never ran").toBe(false);
    reg.unregisterServerAdapter("droid_local");
    reg.unregisterServerAdapter("frozen_local");
    // with isolation disabled the guard is transparent
    writeConfig(false);
    try {
      reg.registerServerAdapter(external("droid_local"));
      expect((await reg.getServerAdapter("droid_local").testEnvironment({ companyId: "c", adapterType: "droid_local", config: {} })).status).toBe("pass");
      expect(fs.existsSync(marker)).toBe(true);
      reg.unregisterServerAdapter("droid_local");
    } finally {
      writeConfig(true);
    }
  });
});
