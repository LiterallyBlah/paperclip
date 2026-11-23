// BLA-4139: caller env (the agent's PAPERCLIP_API_KEY and other secrets) must
// never appear in the Kubernetes exec argv (the in-pod process argv and the
// apiserver request URL) and must still reach the target process env. The fake
// `Exec` below runs the exact exec argv locally, wiring the exec stdin stream to
// the child's stdin, so `execInPod`'s own `head -c` stdin bounding is exercised.
// The composition mirrors the sandbox-cr execute path in plugin.ts.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StatusCb = (status: { status: string; details?: { causes?: { reason?: string; message?: string }[] } }) => void;

const execArgv: string[][] = [];
let binSh: string | null = null;
let root = "";

vi.mock("@kubernetes/client-node", () => {
  class Exec {
    constructor(_kc: unknown) {}
    async exec(
      _namespace: string,
      _podName: string,
      _containerName: string,
      command: string[],
      stdout: PassThrough,
      stderr: PassThrough,
      stdin: PassThrough | null,
      _tty: boolean,
      statusCb: StatusCb,
    ) {
      execArgv.push([...command]);
      let local = command;
      if (binSh) local = command.map((arg) => arg.replace(/exec \/bin\/sh -c /g, () => `exec ${binSh} -c `));
      const child = spawn(local[0]!, local.slice(1), {
        cwd: root,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root },
        stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
      });
      if (stdin && child.stdin) stdin.pipe(child.stdin);
      child.stdout!.on("data", (chunk) => stdout.write(chunk));
      child.stderr!.on("data", (chunk) => stderr.write(chunk));
      child.on("close", (code) => {
        statusCb(code === 0
          ? { status: "Success" }
          : { status: "Failure", details: { causes: [{ reason: "ExitCode", message: String(code ?? 1) }] } });
        stdout.end();
        stderr.end();
      });
      return { close() {} };
    }
  }
  return { Exec };
});

const { execInPod, wrapCommandWithEnv } = await import("../../src/pod-exec.js");

const DUMMY_API_KEY = "pcp-dummy-api-key-bla4139-kubernetes";
const DUMMY_OTHER = "dummy-other-secret-bla4139-kubernetes";

const PROBE = [
  "const fs=require('fs');",
  "const stdin=process.env.PROBE_READ_STDIN?fs.readFileSync(0,'utf8'):null;",
  "process.stdout.write(JSON.stringify({key:process.env.PAPERCLIP_API_KEY??null,other:process.env.OTHER_SECRET??null,",
  "multi:process.env.MULTI??null,uid:process.env.UID??null,",
  "leaked:Object.keys(process.env).filter((k)=>k.startsWith('__paperclip_env')||k.startsWith('__pc_')),",
  "argv:process.argv,stdin}));",
  "process.exit(Number(process.env.PROBE_EXIT??0));",
].join("");

// Same composition as the sandbox-cr execute path in plugin.ts. Accepts the
// base shape (a bare argv) too, so this test runs, and fails, on the base.
async function run(env: Record<string, string>, stdin?: string) {
  const wrapped = wrapCommandWithEnv([process.execPath, "-e", PROBE], env) as unknown;
  const { command, stdinPrefix } = Array.isArray(wrapped)
    ? { command: wrapped as string[], stdinPrefix: null }
    : (wrapped as { command: string[]; stdinPrefix: string | null });
  const execStdin = stdinPrefix != null ? stdinPrefix + (stdin ?? "") : stdin;
  return await execInPod({} as never, "ns", "pod", "agent", command, execStdin, 30_000);
}

function expectNoSecretIn(texts: unknown[], secrets: string[]) {
  const haystack = JSON.stringify(texts);
  for (const secret of secrets) expect(haystack).not.toContain(secret);
}

describe("Kubernetes pod exec keeps env secrets out of the exec argv (BLA-4139)", () => {
  beforeEach(() => {
    execArgv.length = 0;
    binSh = null;
    root = fs.mkdtempSync(path.join(os.tmpdir(), "k8s-env-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("delivers PAPERCLIP_API_KEY and another secret without putting them in the exec argv", async () => {
    const result = await run({ PAPERCLIP_API_KEY: DUMMY_API_KEY, OTHER_SECRET: DUMMY_OTHER });

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.key).toBe(DUMMY_API_KEY);
    expect(out.other).toBe(DUMMY_OTHER);
    expect(out.leaked).toEqual([]);
    expectNoSecretIn([out.argv, execArgv], [DUMMY_API_KEY, DUMMY_OTHER]);
    expect(JSON.stringify(execArgv)).not.toMatch(/export [A-Z_]+=/);
  });

  it("preserves quoted and multiline values exactly", async () => {
    const multi = "line one\nit's \"quoted\" $HOME `x` \\ end\n\nlast";

    const result = await run({ PAPERCLIP_API_KEY: DUMMY_API_KEY, MULTI: multi });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).multi).toBe(multi);
    expectNoSecretIn(execArgv, [DUMMY_API_KEY, "line one", "quoted"]);
  });

  it("delivers caller stdin exactly, then EOF, after the env header", async () => {
    const stdin = "first line\nsecond line without newline ünïcode";

    const result = await run({ PAPERCLIP_API_KEY: DUMMY_API_KEY, PROBE_READ_STDIN: "1" }, stdin);

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.stdin).toBe(stdin);
    expect(out.key).toBe(DUMMY_API_KEY);
    expectNoSecretIn(execArgv, [DUMMY_API_KEY]);
  });

  it("gives the target EOF when the caller sends no stdin", async () => {
    const result = await run({ PAPERCLIP_API_KEY: DUMMY_API_KEY, PROBE_READ_STDIN: "1" });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).stdin).toBe("");
  });

  it("returns the command's exit code", async () => {
    const result = await run({ PAPERCLIP_API_KEY: DUMMY_API_KEY, PROBE_EXIT: "7" }, "x");

    expect(result.exitCode).toBe(7);
  });

  it("keeps a bash-readonly name (UID) when /bin/sh is bash, without values in argv", async () => {
    binSh = "/bin/bash";

    const result = await run({ PAPERCLIP_API_KEY: DUMMY_API_KEY, UID: "dummy-uid-bla4139" });

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.uid).toBe("dummy-uid-bla4139");
    expect(out.key).toBe(DUMMY_API_KEY);
    expect(out.leaked).toEqual([]);
    expectNoSecretIn([out.argv, execArgv], [DUMMY_API_KEY, "dummy-uid-bla4139"]);
  });

  it("runs the command unwrapped when there is no applicable env", async () => {
    const result = await run({ PATH: "/server/bin" });

    expect(result.exitCode).toBe(0);
    expect(execArgv).toEqual([[process.execPath, "-e", PROBE]]);
  });
});
