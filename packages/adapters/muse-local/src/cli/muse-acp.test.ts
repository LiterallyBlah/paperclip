import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

const written: string[] = [];
const spawnArgs: string[][] = [];
let childStdout: PassThrough;

vi.mock("node:child_process", () => ({
  spawn: vi.fn((_cmd: string, args: string[]) => {
    spawnArgs.push(args);
    const child = new EventEmitter() as EventEmitter & {
      stdin: Writable;
      stdout: PassThrough;
    };
    childStdout = new PassThrough();
    child.stdout = childStdout;
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        written.push(chunk.toString());
        callback();
      },
    });
    return child;
  }),
}));

import { MuseAcpBridge } from "./muse-acp.js";

function sentMessages() {
  return written
    .join("")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("waitFor timed out");
}

describe("MuseAcpBridge MSP handshake", () => {
  beforeEach(() => {
    written.length = 0;
    spawnArgs.length = 0;
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  async function startBridge(options: Record<string, unknown> = {}) {
    const bridge = new MuseAcpBridge({
      provider: "echo",
      model: "muse-wonder-1.0",
      command: "muse-test-double",
      disableSandbox: true,
      trustWorkspace: true,
      extraArgs: [],
      ...options,
    } as never);
    const started = bridge.start();
    await waitFor(() => sentMessages().some((msg) => msg.method === "initialize"));
    childStdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }) + "\n");
    await started;
    return bridge;
  }

  function respondTo(method: string, result: unknown) {
    const msg = sentMessages().find((m) => m.method === method);
    childStdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
    return msg;
  }

  it("sends the initialized notification after initialize and before session/start", async () => {
    const bridge = await startBridge();

    const afterInit = sentMessages();
    const initialized = afterInit.find((msg) => msg.method === "initialized");
    expect(initialized, "bridge must send an initialized notification").toBeDefined();
    expect(initialized.id, "initialized must be a notification (no id)").toBeUndefined();

    const sessionNew = bridge.handleAcpRequest({
      jsonrpc: "2.0",
      id: 99,
      method: "session/new",
      params: { cwd: process.cwd() },
    });
    await waitFor(() => sentMessages().some((msg) => msg.method === "session/start"));
    respondTo("session/start", { session: { sessionId: "session-1" } });
    await sessionNew;

    const methods = sentMessages().map((msg) => msg.method);
    expect(methods.indexOf("initialize")).toBeLessThan(methods.indexOf("initialized"));
    expect(methods.indexOf("initialized")).toBeLessThan(methods.indexOf("session/start"));
  });

  it("includes a commandId in session/resume", async () => {
    const bridge = await startBridge();
    const load = bridge.handleAcpRequest({
      jsonrpc: "2.0",
      id: 7,
      method: "session/load",
      params: { sessionId: "session-9" },
    });
    await waitFor(() => sentMessages().some((msg) => msg.method === "session/resume"));
    const resume = respondTo("session/resume", {});
    await load;
    expect(resume.params.sessionId).toBe("session-9");
    expect(typeof resume.params.commandId).toBe("string");
    expect(resume.params.commandId.length).toBeGreaterThan(0);
  });

  it("includes a commandId in turn/cancel", async () => {
    const bridge = await startBridge();
    const sessionNew = bridge.handleAcpRequest({
      jsonrpc: "2.0",
      id: 8,
      method: "session/new",
      params: { cwd: process.cwd() },
    });
    await waitFor(() => sentMessages().some((msg) => msg.method === "session/start"));
    respondTo("session/start", { session: { sessionId: "session-3" } });
    await sessionNew;

    const cancel = bridge.handleAcpRequest({
      jsonrpc: "2.0",
      id: 9,
      method: "session/cancel",
      params: {},
    });
    await waitFor(() => sentMessages().some((msg) => msg.method === "turn/cancel"));
    const cancelMsg = respondTo("turn/cancel", {});
    await cancel;
    expect(cancelMsg.params.sessionId).toBe("session-3");
    expect(typeof cancelMsg.params.commandId).toBe("string");
    expect(cancelMsg.params.commandId.length).toBeGreaterThan(0);
  });

  it("never passes --reasoning-effort to muse serve and gates --model to meta/local", async () => {
    await startBridge({ provider: "echo", reasoningEffort: "high" });
    expect(spawnArgs[0]).not.toContain("--reasoning-effort");
    expect(spawnArgs[0]).not.toContain("--model");

    written.length = 0;
    spawnArgs.length = 0;
    await startBridge({ provider: "meta", reasoningEffort: "high" });
    expect(spawnArgs[0]).not.toContain("--reasoning-effort");
    expect(spawnArgs[0]).toContain("--model");
  });
});
