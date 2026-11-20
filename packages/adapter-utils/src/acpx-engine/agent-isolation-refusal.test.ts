// BLA-433 (B1): executeAcpxEngine refuses before creating any ACP runtime
// while per-agent OS isolation is enabled (ported from bla433
// tests/server-overlays.test.mjs). Synthetic fixture config only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { __setAgentIsolationConfigPathForTests } from "../agent-isolation.js";
import { createAcpxEngineExecutor } from "./execute.js";
import type { AdapterExecutionContext } from "../types.js";

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
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bla433-acpx-")));
  cfgPath = path.join(root, "agent-launch.json");
  __setAgentIsolationConfigPathForTests(cfgPath);
});

afterAll(() => {
  __setAgentIsolationConfigPathForTests(null);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("ACP (acpx) engine under agent OS isolation", () => {
  it("refuses before creating any ACP runtime", async () => {
    writeConfig(true);
    let created = 0;
    const exec = createAcpxEngineExecutor({
      createRuntime: (() => {
        created += 1;
        throw new Error("must not be reached");
      }) as never,
    });
    const ctx = { runId: "r", agent: { id: AGENT }, config: {}, context: {}, onLog: async () => {} } as unknown as AdapterExecutionContext;
    await expect(exec(ctx)).rejects.toThrow(/refusing the ACP \(acpx\) engine/);
    expect(created).toBe(0);
  });

  it("an unsafe isolation config fails closed too", async () => {
    writeConfig(true);
    fs.chmodSync(cfgPath, 0o666);
    try {
      const exec = createAcpxEngineExecutor({ createRuntime: (() => { throw new Error("must not be reached"); }) as never });
      const ctx = { runId: "r", agent: { id: AGENT }, config: {}, context: {}, onLog: async () => {} } as unknown as AdapterExecutionContext;
      await expect(exec(ctx)).rejects.toThrow(/Agent process isolation: .*root-owned/);
    } finally {
      fs.chmodSync(cfgPath, 0o644);
    }
  });

  it("isolation disabled: the guard does not fire", async () => {
    writeConfig(false);
    let created = 0;
    const exec = createAcpxEngineExecutor({
      createRuntime: (() => {
        created += 1;
        throw new Error("sentinel: runtime creation reached");
      }) as never,
    });
    const ctx = { runId: "r", agent: { id: AGENT }, config: {}, context: {}, onLog: async () => {} } as unknown as AdapterExecutionContext;
    const out = await exec(ctx).then((r) => JSON.stringify(r), (e) => String(e));
    expect(out).not.toMatch(/refusing the ACP \(acpx\) engine/);
  });
});
