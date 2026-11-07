import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

const written: string[] = [];
let childStdout: PassThrough;

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
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
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("sends the initialized notification after initialize and before session/start", async () => {
    const bridge = new MuseAcpBridge({
      provider: "echo",
      model: "muse-wonder-1.0",
      command: "muse-test-double",
      disableSandbox: true,
      trustWorkspace: true,
      extraArgs: [],
    });

    const started = bridge.start();
    await waitFor(() => sentMessages().some((msg) => msg.method === "initialize"));
    childStdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }) + "\n");
    await started;

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
    const startMsg = sentMessages().find((msg) => msg.method === "session/start");
    childStdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: startMsg.id,
        result: { session: { sessionId: "session-1" } },
      }) + "\n",
    );
    await sessionNew;

    const methods = sentMessages().map((msg) => msg.method);
    expect(methods.indexOf("initialize")).toBeLessThan(methods.indexOf("initialized"));
    expect(methods.indexOf("initialized")).toBeLessThan(methods.indexOf("session/start"));
  });
});
