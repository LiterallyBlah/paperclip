// BLA-3954: the sandbox duplex gateway launch must keep every environment value,
// above all `PAPERCLIP_BRIDGE_TOKEN`, out of the argument vector and the command
// text handed to the runner, at every stage of startup.
//
// These tests run the real launch command through real `bash` and `sh` (dash)
// processes over pipes and over a real pseudo-terminal, and scan
// `/proc/*/cmdline` while each launch runs. Every value is a dummy test value.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandManagedDuplexChannel } from "./command-managed-runtime.js";
import * as executionTarget from "./execution-target.js";
import {
  startAdapterExecutionTargetPaperclipBridge,
  type AdapterSandboxExecutionTarget,
} from "./execution-target.js";
import { runChildProcess } from "./server-utils.js";
import { fileURLToPath, pathToFileURL } from "node:url";

// The Daytona provider plugin ships standalone, outside this package's build,
// so load its launch wrapper builder at run time instead of a typed import.
const DAYTONA_DUPLEX_MODULE = pathToFileURL(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../plugins/sandbox-providers/daytona/src/duplex-command-stream.ts"),
).href;
async function loadDaytonaLaunchWrapper(): Promise<(command: readonly string[], diagnosticsPath: string) => string> {
  const module = (await import(/* @vite-ignore */ DAYTONA_DUPLEX_MODULE)) as {
    buildDuplexChannelLaunchWrapper: (command: readonly string[], diagnosticsPath: string) => string;
  };
  return module.buildDuplexChannelLaunchWrapper;
}

const SHELLS = ["bash", "sh"] as const;
const REQUEST_LINE = "PAPERCLIP_DUPLEX_BOOTSTRAP_REQUEST";

// The candidate API. The base exposes neither helper, so a base run fails at
// the first use with a clear message instead of a type error.
type LaunchArgvInput = { shellCommand: "bash" | "sh"; remoteEntrypoint: string; nodeCommand?: string | null };
const buildLaunchArgv = executionTarget.buildDuplexGatewayLaunchArgv as (input: LaunchArgvInput) => string[];
const exported = executionTarget as unknown as {
  buildDuplexGatewayBootstrap?: (env: Record<string, string>) => Buffer;
  attachDuplexGatewayBootstrap?: (
    channel: CommandManagedDuplexChannel,
    bootstrap: Uint8Array,
    options?: { capBytes?: number },
  ) => CommandManagedDuplexChannel;
};
function buildBootstrap(env: Record<string, string>): Buffer {
  if (!exported.buildDuplexGatewayBootstrap) throw new Error("buildDuplexGatewayBootstrap is not exported");
  return exported.buildDuplexGatewayBootstrap(env);
}
function attachBootstrap(
  channel: CommandManagedDuplexChannel,
  bootstrap: Uint8Array,
  options?: { capBytes?: number },
): CommandManagedDuplexChannel {
  if (!exported.attachDuplexGatewayBootstrap) throw new Error("attachDuplexGatewayBootstrap is not exported");
  return exported.attachDuplexGatewayBootstrap(channel, bootstrap, options);
}

const cleanupDirs: string[] = [];
const cleanupChildren: ChildProcessWithoutNullStreams[] = [];
afterEach(async () => {
  for (const child of cleanupChildren.splice(0)) child.kill("SIGKILL");
  for (const dir of cleanupDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function scratchDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

function dummySecret(label: string): string {
  return `dummy-${label}-${randomBytes(12).toString("hex")}`;
}

/**
 * Scan every visible `/proc/<pid>/cmdline` for any needle. Returns the matching
 * command lines. `cmdline` is world-readable, so this is what any local user
 * of the sandbox sees through `ps`.
 */
function scanProcCmdlines(needles: readonly string[]): string[] {
  const hits: string[] = [];
  let pids: string[] = [];
  try {
    pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  } catch {
    return hits;
  }
  for (const pid of pids) {
    if (pid === String(process.pid)) continue;
    let cmdline = "";
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, "latin1");
    } catch {
      continue;
    }
    for (const needle of needles) {
      if (needle.length > 0 && cmdline.includes(needle)) hits.push(cmdline.replace(/\0/g, " "));
    }
  }
  return hits;
}

/** Sample `/proc` on a short interval for the life of a launch. */
function startProcWatch(needles: readonly string[]): { sample: () => void; stop: () => string[] } {
  const hits: string[] = [];
  const sample = () => {
    hits.push(...scanProcCmdlines(needles));
  };
  const timer = setInterval(sample, 2);
  return {
    sample,
    stop: () => {
      clearInterval(timer);
      sample();
      return hits;
    },
  };
}

// A stand-in gateway. It records the environment it received, prints a line,
// then echoes every stdin byte back until EOF and exits 7, so a test can prove
// the bootstrap reached the process, the later input reached it, and EOF ends it.
const STUB_GATEWAY_SOURCE = `
const fs = require("node:fs");
const keys = JSON.parse(fs.readFileSync(__filename + ".keys", "utf8"));
const seen = {};
for (const key of keys) seen[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : null;
seen.__argv = process.argv.slice(1);
fs.writeFileSync(__filename + ".env.json", JSON.stringify(seen));
process.stdout.write("STUB_STARTED\\n");
let bytes = 0;
process.stdin.on("data", (chunk) => { bytes += chunk.length; process.stdout.write(chunk); });
process.stdin.on("end", () => { fs.writeFileSync(__filename + ".bytes", String(bytes)); process.exit(7); });
`;

async function writeStubGateway(dir: string, keys: readonly string[]): Promise<string> {
  const entrypoint = path.join(dir, "gateway-stub.cjs");
  await writeFile(entrypoint, STUB_GATEWAY_SOURCE);
  await writeFile(`${entrypoint}.keys`, JSON.stringify(keys));
  return entrypoint;
}

function waitForOutput(
  read: () => string,
  predicate: (text: string) => boolean,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate(read())) return resolve();
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${label}; output: ${JSON.stringify(read())}`));
      setTimeout(tick, 5);
    };
    tick();
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    child.once("exit", (code) => resolve(code));
  });
}

describe("duplex gateway launch keeps environment values out of argv (BLA-3954)", () => {
  describe.each(SHELLS)("through a real %s over pipes", (shellCommand) => {
    it("delivers quoted and multiline values to the gateway with no value in any argv", async () => {
      const dir = await scratchDir("pc-duplex-launch-");
      const token = dummySecret("bridge-token");
      const otherSecret = dummySecret("other-secret");
      const env: Record<string, string> = {
        PAPERCLIP_BRIDGE_TOKEN: token,
        PAPERCLIP_OTHER_SECRET: otherSecret,
        PAPERCLIP_MULTILINE: `first ${otherSecret}-line\nsecond line\n\nfourth\n`,
        PAPERCLIP_QUOTED: `it's "quoted" $HOME \`id\` \\ back; $(echo nope) 'x'`,
        PAPERCLIP_EMPTY: "",
        // A caller name that matches a reader variable still survives.
        __pc_env: "reader-name-collision",
      };
      const entrypoint = await writeStubGateway(dir, Object.keys(env));
      const argv = buildLaunchArgv({ shellCommand, remoteEntrypoint: entrypoint });
      const bootstrap = buildBootstrap(env);
      const commandText = argv.join("\n");
      for (const needle of [token, otherSecret, "second line", "quoted"]) {
        expect(commandText).not.toContain(needle);
      }

      const watch = startProcWatch([token, otherSecret]);
      const child = spawn(argv[0]!, argv.slice(1), { stdio: ["pipe", "pipe", "pipe"], cwd: dir });
      cleanupChildren.push(child);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        watch.sample();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      await waitForOutput(() => stdout, (text) => text.includes(`${REQUEST_LINE}\n`), "bootstrap request");
      watch.sample();
      child.stdin.write(bootstrap);
      await waitForOutput(() => stdout, (text) => text.includes("STUB_STARTED\n"), "gateway start");
      watch.sample();
      // Ordinary input after the bootstrap reaches the gateway unchanged, and
      // EOF ends it with its own exit code.
      child.stdin.write("ordinary input\n");
      child.stdin.end("tail-without-newline");
      const exitCode = await waitForExit(child);
      const hits = watch.stop();

      expect(stderr).toBe("");
      expect(exitCode).toBe(7);
      expect(hits).toEqual([]);
      const seen = JSON.parse(await readFile(`${entrypoint}.env.json`, "utf8")) as Record<string, unknown>;
      for (const [key, value] of Object.entries(env)) expect(seen[key]).toBe(value);
      expect(seen.__argv).toEqual([entrypoint]);
      expect(stdout.endsWith("STUB_STARTED\nordinary input\ntail-without-newline")).toBe(true);
      expect(await readFile(`${entrypoint}.bytes`, "utf8")).toBe(String("ordinary input\ntail-without-newline".length));
      // Nothing the gateway receives on stdin carries the bootstrap.
      expect(stdout).not.toContain(token);
    }, 20_000);

    it("fails closed with exit 125 on a truncated bootstrap and never starts the gateway", async () => {
      const dir = await scratchDir("pc-duplex-truncated-");
      const token = dummySecret("bridge-token");
      const entrypoint = await writeStubGateway(dir, ["PAPERCLIP_BRIDGE_TOKEN"]);
      const argv = buildLaunchArgv({ shellCommand, remoteEntrypoint: entrypoint });
      const bootstrap = buildBootstrap({ PAPERCLIP_BRIDGE_TOKEN: token, PAPERCLIP_BRIDGE_NONCE: "n" }).toString("utf8");
      const truncated = bootstrap.slice(0, bootstrap.indexOf("\n", bootstrap.indexOf("\n") + 1) + 1);
      const child = spawn(argv[0]!, argv.slice(1), { stdio: ["pipe", "pipe", "pipe"], cwd: dir });
      cleanupChildren.push(child);
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      await waitForOutput(() => stdout, (text) => text.includes(`${REQUEST_LINE}\n`), "bootstrap request");
      child.stdin.end(truncated);
      expect(await waitForExit(child)).toBe(125);
      expect(stdout).not.toContain("STUB_STARTED");
    }, 20_000);

    it("fails closed with exit 125 on a malformed line count", async () => {
      const dir = await scratchDir("pc-duplex-malformed-");
      const entrypoint = await writeStubGateway(dir, []);
      const argv = buildLaunchArgv({ shellCommand, remoteEntrypoint: entrypoint });
      const child = spawn(argv[0]!, argv.slice(1), { stdio: ["pipe", "pipe", "pipe"], cwd: dir });
      cleanupChildren.push(child);
      child.stdout.resume();
      child.stdin.end("not-a-number\nexport A='b'\n");
      expect(await waitForExit(child)).toBe(125);
    }, 20_000);
  });

  it("puts no dummy secret in the constructed launch argv, even when a caller passes env", () => {
    // The base builder took `env` and serialised every entry into an
    // `exec env KEY=value ...` script. The candidate builder takes no env: any
    // env a caller still passes must never reach the argv.
    const token = dummySecret("bridge-token");
    const otherSecret = dummySecret("other-secret");
    for (const shellCommand of SHELLS) {
      const legacyInput = {
        shellCommand,
        remoteEntrypoint: "/srv/gateway.mjs",
        env: { PAPERCLIP_BRIDGE_TOKEN: token, PAPERCLIP_OTHER_SECRET: otherSecret },
      };
      const argv = buildLaunchArgv(legacyInput);
      expect(argv.slice(0, 2)).toEqual([shellCommand, "-c"]);
      expect(argv.join("\n")).not.toContain(token);
      expect(argv.join("\n")).not.toContain(otherSecret);
    }
  });

  it("rejects an environment name that is not a shell identifier", () => {
    expect(() => buildBootstrap({ "BAD-NAME": "x" })).toThrow(/Invalid duplex gateway environment variable key/);
    expect(() => buildBootstrap({ "A=B": "x" })).toThrow(/Invalid duplex gateway environment variable key/);
  });

  it("keeps the request line text out of the launch command, so an echo cannot forge it", async () => {
    const buildDuplexChannelLaunchWrapper = await loadDaytonaLaunchWrapper();
    for (const shellCommand of SHELLS) {
      const argv = buildLaunchArgv({ shellCommand, remoteEntrypoint: "/srv/gateway.mjs" });
      expect(argv.join(" ")).not.toContain(REQUEST_LINE);
      expect(buildDuplexChannelLaunchWrapper(argv, "/tmp/d.log")).not.toContain(REQUEST_LINE);
    }
  });

  // The Daytona provider types its launch wrapper into an interactive shell on a
  // pseudo-terminal. The terminal echoes input until the wrapper sets raw mode,
  // so this proves the bootstrap is written only after echo is off: the token
  // never comes back on the terminal output, and never reaches an argv.
  describe.each(SHELLS)("through the Daytona launch wrapper on a real terminal (%s)", (shellCommand) => {
    it("never echoes or exposes the bootstrap", async () => {
      const dir = await scratchDir("pc-duplex-pty-");
      const token = dummySecret("bridge-token");
      const otherSecret = dummySecret("other-secret");
      const env = {
        PAPERCLIP_BRIDGE_TOKEN: token,
        PAPERCLIP_OTHER_SECRET: `${otherSecret}\nline two`,
      };
      const entrypoint = await writeStubGateway(dir, Object.keys(env));
      const diagnosticsPath = path.join(dir, "diagnostics.log");
      const argv = buildLaunchArgv({ shellCommand, remoteEntrypoint: entrypoint });
      const buildDuplexChannelLaunchWrapper = await loadDaytonaLaunchWrapper();
      const wrapper = buildDuplexChannelLaunchWrapper(argv, diagnosticsPath);
      expect(wrapper).not.toContain(token);
      expect(wrapper).not.toContain(otherSecret);

      // A minimal pseudo-terminal relay: an interactive bash with echo on, in
      // canonical mode, the way a provider PTY session starts.
      const relay = [
        "import os, pty, select, sys",
        "pid, fd = pty.fork()",
        "if pid == 0:",
        "    os.execvp('bash', ['bash', '--norc', '--noprofile', '-i'])",
        "inp = sys.stdin.fileno(); out = sys.stdout.fileno()",
        "while True:",
        "    r, _, _ = select.select([fd, inp], [], [])",
        "    if fd in r:",
        "        try: data = os.read(fd, 65536)",
        "        except OSError: break",
        "        if not data: break",
        "        os.write(out, data)",
        "    if inp in r:",
        "        data = os.read(inp, 65536)",
        "        if not data: inp = -1; continue",
        "        os.write(fd, data)",
        "_, status = os.waitpid(pid, 0)",
        "sys.exit(os.waitstatus_to_exitcode(status))",
      ].join("\n");
      const watch = startProcWatch([token, otherSecret]);
      const child = spawn("python3", ["-I", "-c", relay], {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: dir,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, TERM: "dumb", PS1: "$ " },
      });
      cleanupChildren.push(child);
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("latin1");
        watch.sample();
      });
      child.stderr.resume();

      child.stdin.write(wrapper);
      await waitForOutput(
        () => output,
        (text) => text.split("\n").some((line) => line.replace(/\r$/, "").endsWith(REQUEST_LINE)),
        "bootstrap request",
        10_000,
      );
      child.stdin.write(buildBootstrap(env));
      await waitForOutput(() => output, (text) => text.includes("STUB_STARTED\n"), "gateway start", 10_000);
      watch.sample();
      // Raw mode with echo off: ordinary input reaches the gateway once, unchanged.
      child.stdin.write("pty input\n");
      await waitForOutput(() => output, (text) => text.endsWith("STUB_STARTED\npty input\n"), "gateway echo", 10_000);
      child.kill("SIGTERM");
      await waitForExit(child);
      const hits = watch.stop();

      expect(hits).toEqual([]);
      expect(output).not.toContain(token);
      expect(output).not.toContain(otherSecret);
      const diagnostics = await readFile(diagnosticsPath, "utf8").catch(() => "");
      expect(diagnostics).not.toContain(token);
      const seen = JSON.parse(await readFile(`${entrypoint}.env.json`, "utf8")) as Record<string, unknown>;
      expect(seen.PAPERCLIP_BRIDGE_TOKEN).toBe(token);
      expect(seen.PAPERCLIP_OTHER_SECRET).toBe(env.PAPERCLIP_OTHER_SECRET);
    }, 30_000);
  });

  describe("bootstrap handshake on the host side of the channel", () => {
    function fakeChannel() {
      const writes: Buffer[] = [];
      let dataListener: ((chunk: Uint8Array) => void) | null = null;
      let exitListener: ((exit: { exitCode: number | null; transportClosed?: boolean }) => void) | null = null;
      const counts = { stop: 0, close: 0 };
      const channel: CommandManagedDuplexChannel = {
        write: (data) => writes.push(Buffer.from(data)),
        onData: (listener) => {
          dataListener = listener;
        },
        onExit: (listener) => {
          exitListener = listener;
        },
        stop: () => {
          counts.stop += 1;
        },
        close: async () => {
          counts.close += 1;
        },
      };
      return {
        channel,
        writes,
        counts,
        emit: (text: string | Buffer) => dataListener?.(typeof text === "string" ? Buffer.from(text, "latin1") : text),
        exit: (exit: { exitCode: number | null; transportClosed?: boolean }) => exitListener?.(exit),
      };
    }

    it("drops the pre-request echo, writes the bootstrap once, and forwards the rest", () => {
      const fake = fakeChannel();
      const bootstrap = Buffer.from("1\nunset __pc_env __pc_nl\n");
      const wrapped = attachBootstrap(fake.channel, bootstrap);
      const received: Buffer[] = [];
      wrapped.onData((chunk) => received.push(Buffer.from(chunk)));
      // A host write before the request is held, not sent.
      wrapped.write(Buffer.from("early"));
      expect(fake.writes).toEqual([]);
      // The terminal echo of the typed wrapper carries the request text only in
      // two quoted pieces, so it does not count as the request.
      fake.emit("$ exec 2>'/tmp/d.log'; stty raw -echo; exec 'sh' '-c' 'printf '\"'\"'%s%s\\n'\"'\"' '\"'\"'PAPERCLIP_DUPLEX_'\"'\"' '\"'\"'BOOTSTRAP_REQUEST'\"'\"''\r\n");
      expect(fake.writes).toEqual([]);
      // A bracketed-paste disable sequence on the same line, a split chunk, a CR.
      fake.emit("\x1b[?2004l\rPAPERCLIP_DUPLEX_BOOT");
      expect(fake.writes).toEqual([]);
      fake.emit('STRAP_REQUEST\r\n{"version":2,"type":"ready"');
      expect(Buffer.concat(fake.writes).toString()).toBe(`${bootstrap.toString()}early`);
      expect(fake.writes[0]).toEqual(bootstrap);
      fake.emit("}\n");
      expect(Buffer.concat(received).toString()).toBe('{"version":2,"type":"ready"}\n');
      // A second request line is ordinary gateway output now; no second bootstrap.
      fake.emit(`${REQUEST_LINE}\n`);
      expect(fake.writes).toHaveLength(2);
      wrapped.write(Buffer.from("later"));
      expect(fake.writes[2]?.toString()).toBe("later");
      wrapped.stop();
      void wrapped.close();
      expect(fake.counts).toEqual({ stop: 1, close: 1 });
    });

    it("buffers post-request bytes and an exit until the listeners register", () => {
      const fake = fakeChannel();
      const wrapped = attachBootstrap(fake.channel, Buffer.from("0\n"));
      fake.emit(`${REQUEST_LINE}\nREADY-BYTES`);
      fake.exit({ exitCode: 3 });
      const received: string[] = [];
      const exits: Array<{ exitCode: number | null }> = [];
      wrapped.onData((chunk) => received.push(Buffer.from(chunk).toString()));
      wrapped.onExit((exit) => exits.push(exit));
      expect(received).toEqual(["READY-BYTES"]);
      expect(exits).toEqual([{ exitCode: 3 }]);
    });

    it("forwards an exit before the request and never writes the bootstrap", () => {
      const fake = fakeChannel();
      const wrapped = attachBootstrap(fake.channel, Buffer.from("0\n"));
      const exits: Array<{ exitCode: number | null; transportClosed?: boolean }> = [];
      wrapped.onExit((exit) => exits.push(exit));
      fake.emit("bash: node: command not found\r\n");
      fake.exit({ exitCode: null, transportClosed: true });
      expect(exits).toEqual([{ exitCode: null, transportClosed: true }]);
      expect(fake.writes).toEqual([]);
    });

    it("stops the channel when the pre-request bytes pass the cap", () => {
      for (const noise of ["x".repeat(200), `${"line\n".repeat(50)}`]) {
        const fake = fakeChannel();
        const wrapped = attachBootstrap(fake.channel, Buffer.from("0\n"), { capBytes: 100 });
        wrapped.onData(() => {
          throw new Error("no byte may pass before the request");
        });
        fake.emit(noise);
        expect(fake.counts.stop).toBe(1);
        fake.emit(`${REQUEST_LINE}\n`);
        expect(fake.writes).toEqual([]);
      }
    });
  });

  // End to end through the host bridge start: the real launch command runs in a
  // real shell, the real gateway asset reads the bootstrap, the HTTP/2 path comes
  // up, and a request authenticated with the bridge token reaches the host API.
  describe.each(SHELLS)("through startAdapterExecutionTargetPaperclipBridge (%s)", (shellCommand) => {
    it("hands the runner no bridge token or nonce and still serves HTTP/2", async () => {
      const rootDir = await scratchDir("pc-duplex-e2e-");
      const remoteCwd = path.join(rootDir, "workspace");
      await mkdir(remoteCwd, { recursive: true });

      const apiRequests: Array<{ url: string; auth: string | null }> = [];
      const apiServer = createServer((req, res) => {
        req.resume();
        req.on("end", () => {
          apiRequests.push({ url: req.url ?? "/", auth: req.headers.authorization ?? null });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
      });
      await new Promise<void>((resolve) => apiServer.listen(0, "127.0.0.1", () => resolve()));
      const apiAddress = apiServer.address();
      if (!apiAddress || typeof apiAddress === "string") throw new Error("no api address");

      const runnerCommandTexts: string[] = [];
      const channelOutput: Buffer[] = [];
      const logLines: string[] = [];
      let sampleOnChunk: (() => void) | null = null;
      const needles: string[] = [];
      let counter = 0;
      const children: ChildProcessWithoutNullStreams[] = [];
      const runner = {
        execute: async (input: {
          command: string;
          args?: string[];
          cwd?: string;
          env?: Record<string, string>;
          stdin?: string;
          timeoutMs?: number;
          onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
        }) => {
          counter += 1;
          runnerCommandTexts.push([input.command, ...(input.args ?? []), JSON.stringify(input.env ?? {})].join("\n"));
          const command = input.command === "bash" ? "/bin/bash" : input.command;
          return runChildProcess(`duplex-e2e-${counter}`, command, input.args ?? [], {
            cwd: input.cwd ?? process.cwd(),
            env: input.env ?? {},
            stdin: input.stdin,
            timeoutSec: Math.max(1, Math.ceil((input.timeoutMs ?? 30_000) / 1000)),
            graceSec: 5,
            onLog: input.onLog ?? (async () => {}),
          });
        },
        openDuplexChannel: async ({ command }: { command: readonly string[] }): Promise<CommandManagedDuplexChannel> => {
          runnerCommandTexts.push(command.join("\n"));
          const child = spawn(command[0]!, command.slice(1), { stdio: ["pipe", "pipe", "pipe"], cwd: remoteCwd });
          children.push(child);
          cleanupChildren.push(child);
          child.stderr.resume();
          child.stdin.on("error", () => {});
          return {
            write: (data) => {
              child.stdin.write(Buffer.from(data));
            },
            onData: (listener) => {
              child.stdout.on("data", (chunk: Buffer) => {
                channelOutput.push(chunk);
                sampleOnChunk?.();
                listener(chunk);
              });
            },
            onExit: (listener) => {
              child.once("exit", (exitCode) => listener({ exitCode }));
            },
            stop: () => {
              child.kill();
            },
            close: async () => {
              child.stdin.end();
              child.kill();
            },
          };
        },
      };
      const target: AdapterSandboxExecutionTarget = {
        kind: "remote",
        transport: "sandbox",
        providerKey: "daytona",
        remoteCwd,
        timeoutMs: 30_000,
        shellCommand,
        runner,
        effectiveCapabilities: {
          reusableLeases: false,
          nativeSyncIn: false,
          nativeSyncOut: false,
          persistentProcessSessions: false,
          independentControlCommands: false,
          incrementalSessionOutput: false,
          concurrentSyncOperations: false,
          duplexCommandStream: true,
          runnerWebSocketIngress: false,
        },
      };

      // The bridge start generates the token and the nonce, so the test cannot
      // match them while startup runs. It records every command line it sees
      // during startup (on a short interval and on every channel chunk) and
      // matches them once the values are known.
      const allCmdlines = new Set<string>();
      const collect = () => {
        let pids: string[] = [];
        try {
          pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
        } catch {
          return;
        }
        for (const pid of pids) {
          try {
            allCmdlines.add(readFileSync(`/proc/${pid}/cmdline`, "latin1"));
          } catch {
            // The process ended.
          }
        }
      };
      const collector = setInterval(collect, 2);
      sampleOnChunk = collect;

      const bridge = await startAdapterExecutionTargetPaperclipBridge({
        runId: "run-bla-3954",
        target,
        runtimeRootDir: path.join(remoteCwd, ".paperclip-runtime", "codex"),
        adapterKey: "codex",
        hostApiToken: "dummy-host-run-jwt",
        hostApiUrl: `http://127.0.0.1:${apiAddress.port}`,
        enableSandboxDuplexBridge: true,
        duplexReadinessTimeoutMs: 10_000,
        onLog: async (_stream, chunk) => {
          logLines.push(chunk);
        },
      });
      try {
        expect(bridge).not.toBeNull();
        const bridgeToken = bridge!.env.PAPERCLIP_API_KEY ?? "";
        expect(bridgeToken.length).toBeGreaterThan(16);
        const readyLine = Buffer.concat(channelOutput)
          .toString("latin1")
          .split("\n")
          .find((line) => line.includes('"type":"ready"'));
        const nonce = readyLine ? (JSON.parse(readyLine.slice(readyLine.indexOf("{"))) as { nonce?: string }).nonce ?? "" : "";
        needles.push(bridgeToken, nonce);

        // The token and the nonce never reach the runner's command text.
        for (const text of runnerCommandTexts) {
          expect(text).not.toContain(bridgeToken);
          if (nonce) expect(text).not.toContain(nonce);
        }
        expect(bridge!.env.PAPERCLIP_API_BRIDGE_MODE).toBe("http2_v1");
        expect(nonce).toMatch(/^[0-9a-f]{32}$/);

        // The gateway got the token: a request authenticated with it goes all
        // the way to the host API, which sees only the host run credential.
        const response = await fetch(`${bridge!.env.PAPERCLIP_API_URL}/api/issues/issue-1/comments`, {
          method: "POST",
          headers: { authorization: `Bearer ${bridgeToken}`, "content-type": "application/json" },
          body: JSON.stringify({ body: "hello" }),
        });
        expect(response.status).toBe(200);
        expect(apiRequests.at(-1)).toEqual({ url: "/api/issues/issue-1/comments", auth: "Bearer dummy-host-run-jwt" });
        // A wrong token is still refused by the gateway.
        const refused = await fetch(`${bridge!.env.PAPERCLIP_API_URL}/api/issues/issue-1/comments`, {
          method: "POST",
          headers: { authorization: "Bearer wrong-token", "content-type": "application/json" },
          body: JSON.stringify({ body: "hello" }),
        });
        expect(refused.status).toBe(401);

        clearInterval(collector);
        collect();
        const leaked = [...allCmdlines].filter((cmdline) =>
          needles.some((needle) => needle.length > 0 && cmdline.includes(needle)),
        );
        expect(leaked.map((cmdline) => cmdline.replace(/\0/g, " "))).toEqual([]);
        for (const line of logLines) expect(line).not.toContain(bridgeToken);
      } finally {
        clearInterval(collector);
        await bridge?.stop();
        await new Promise<void>((resolve) => apiServer.close(() => resolve()));
      }
      // stop() tears the gateway down.
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) await waitForExit(child);
      }
    }, 60_000);
  });
});
