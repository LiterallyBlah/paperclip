// BLA-433 (B2): claude_local prompt bundles live under a per-agent path
// (claude-prompt-cache/agents/<agentId>/<sha256>) so the isolated launcher can
// grant an agent read access to its own bundles only. Without a valid agent
// UUID the legacy shared path is kept. Ported from bla433
// tests/agent-isolation.test.mjs; synthetic PAPERCLIP_HOME only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareClaudePromptBundle } from "./prompt-cache.js";
import { resolveClaudeExecutionEngine } from "./acp.js";

const COMPANY = "b0f71539-5099-4ca6-9e17-5cb96724bc24";
const AGENT = "11111111-2222-4333-8444-555555555555";
let root: string;
const prev = { h: process.env.PAPERCLIP_HOME, i: process.env.PAPERCLIP_INSTANCE_ID };

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bla433-pc-")));
  process.env.PAPERCLIP_HOME = path.join(root, "pchome");
  process.env.PAPERCLIP_INSTANCE_ID = "t";
});

afterAll(() => {
  if (prev.h === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = prev.h;
  if (prev.i === undefined) delete process.env.PAPERCLIP_INSTANCE_ID; else process.env.PAPERCLIP_INSTANCE_ID = prev.i;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("per-agent prompt bundle path", () => {
  it("uses claude-prompt-cache/agents/<agentId>/<sha256> for a valid agent id", async () => {
    const b = await prepareClaudePromptBundle({ companyId: COMPANY, agentId: AGENT, skills: [], instructionsContents: "x", onLog: async () => {} });
    expect(b.rootDir).toMatch(new RegExp(`/companies/${COMPANY}/claude-prompt-cache/agents/${AGENT}/[0-9a-f]{64}$`));
    expect(b.addDir.startsWith(b.rootDir)).toBe(true);
    expect(fs.statSync(b.rootDir).isDirectory()).toBe(true);
  });

  it("keeps the legacy shared path without an agent id or with a non-UUID one", async () => {
    for (const agentId of [undefined, null, "../../etc", "AGENT", `${AGENT}/x`]) {
      const b = await prepareClaudePromptBundle({ companyId: COMPANY, agentId, skills: [], instructionsContents: "y", onLog: async () => {} });
      expect(b.rootDir, String(agentId)).toMatch(new RegExp(`/companies/${COMPANY}/claude-prompt-cache/[0-9a-f]{64}$`));
    }
  });
});

describe("claude_local default engine (B1)", () => {
  it("defaults to the ACP engine, which goes through the guarded acpx executor", () => {
    expect(resolveClaudeExecutionEngine({}).engine).toBe("acp");
    const src = fs.readFileSync(new URL("./acp.ts", import.meta.url), "utf8");
    expect(src).toMatch(/createAcpxEngineExecutor/);
  });
});
