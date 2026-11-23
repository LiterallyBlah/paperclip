import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  type AdapterSshExecutionTarget,
} from "./execution-target.js";
import { runChildProcess } from "./server-utils.js";
import {
  buildSshEnvLabFixtureConfig,
  buildSshSpawnTarget,
  createSshCommandManagedRuntimeRunner,
  getSshEnvLabSupport,
  runSshCommand,
  startSshEnvLabFixture,
  stopSshEnvLabFixture,
  type SshEnvLabFixtureState,
  type SshRemoteExecutionSpec,
} from "./ssh.js";

// Regression for BLA-3929: SSH launches must never put an env value in a
// process argument, at the local ssh end or in the remote shell, during
// startup or execution. All values here are dummies.

const TEST_TIMEOUT_MS = 60_000;

// A second process scans every /proc/<pid>/cmdline in a tight loop for the
// whole launch. The markers reach it through its environment, never its argv,
// so the scanner cannot match itself. It also records every process whose argv
// carries the per-test probe token, which proves it saw both the local ssh and
// the remote shell, so an empty hit list is a real observation.
const ARGV_SCANNER_SOURCE = `
const fs = require("node:fs");
const markers = JSON.parse(process.env.PC_SCAN_MARKERS);
const probe = process.env.PC_SCAN_PROBE;
const out = process.env.PC_SCAN_OUT;
const self = String(process.pid);
const hits = new Map();
const probes = new Map();
let scans = 0;
let stop = false;
process.on("SIGTERM", () => { stop = true; });
function scan() {
  let entries = [];
  try { entries = fs.readdirSync("/proc"); } catch { return; }
  for (const pid of entries) {
    if (pid === self || !/^[0-9]+$/.test(pid)) continue;
    let raw;
    try { raw = fs.readFileSync("/proc/" + pid + "/cmdline", "latin1"); } catch { continue; }
    if (!raw) continue;
    const head = raw.split("\\0").slice(0, 2).join(" ");
    if (markers.some((marker) => raw.includes(marker))) hits.set(pid, head);
    if (raw.includes(probe)) probes.set(pid, head);
  }
  scans += 1;
}
process.stdout.write("ready\\n");
(function loop() {
  if (stop) {
    fs.writeFileSync(out, JSON.stringify({ scans, hits: [...hits.values()], probes: [...probes.values()] }));
    process.exit(0);
  }
  scan();
  setImmediate(loop);
})();
`;

interface ArgvScanResult {
  scans: number;
  hits: string[];
  probes: string[];
}

async function withArgvScanner<T>(
  markers: string[],
  probe: string,
  work: () => Promise<T>,
): Promise<{ value: T; scan: ArgvScanResult }> {
  const outPath = path.join(scratchDir, `scan-${randomUUID()}.json`);
  const scanner: ChildProcess = spawn(process.execPath, ["-e", ARGV_SCANNER_SOURCE], {
    env: {
      PATH: process.env.PATH ?? "",
      PC_SCAN_MARKERS: JSON.stringify(markers),
      PC_SCAN_PROBE: probe,
      PC_SCAN_OUT: outPath,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    scanner.once("error", reject);
    scanner.stdout?.once("data", () => resolve());
  });
  let value: T;
  try {
    value = await work();
  } finally {
    const exited = new Promise<void>((resolve) => scanner.once("exit", () => resolve()));
    scanner.kill("SIGTERM");
    await exited;
  }
  const scan = JSON.parse(await readFile(outPath, "utf8")) as ArgvScanResult;
  await rm(outPath, { force: true });
  return { value, scan };
}

function expectBothEndsObservedAndClean(scan: ArgvScanResult) {
  expect(scan.scans).toBeGreaterThan(2);
  // Local end: the ssh client argv (the real client, or the loopback stand-in
  // run as `/bin/sh <dir>/ssh ...`).
  expect(scan.probes.some((head) => /(^|\/)ssh( |$)/.test(head))).toBe(true);
  // Remote end: the `<shell> -c` that sshd (or the stand-in) starts for the
  // command, and the shells it execs.
  expect(scan.probes.some((head) => /^(\S*\/)?-?(ba|da)?sh -c$/.test(head))).toBe(true);
  expect(scan.hits).toEqual([]);
}

function dummySecret() {
  const id = randomUUID().replace(/-/g, "");
  const firstLine = `dummy-ssh-secret-${id}`;
  const secondLine = `second-${id}`;
  // Quotes, shell metacharacters and a multiline value must arrive intact.
  const value = `${firstLine}\n${secondLine} 'single' "double" $HOME \`tick\` \\ ;|&\n\ttrailing  `;
  return { value, markers: [firstLine, secondLine] };
}

let scratchDir = "";
let fixtureRoot = "";
let fixtureState: SshEnvLabFixtureState | null = null;
let spec: SshRemoteExecutionSpec | null = null;
let unsupportedReason: string | null = null;
let originalPath: string | undefined;

// Loopback stand-in for the ssh client, used when the real sshd fixture cannot
// run commands (for example, a service account whose login shell is nologin).
// It stays alive as the local client process, as ssh does, and runs the remote
// command string through `/bin/sh -c`, as sshd runs it through the login shell.
// stdin, EOF and the exit status pass straight through.
const LOOPBACK_SSH_SCRIPT = `#!/bin/sh
for last; do :; done
/bin/sh -c "$last"
exit $?
`;

async function useLoopbackSsh(reason: string) {
  const binDir = path.join(scratchDir, "bin");
  await mkdir(binDir, { recursive: true, mode: 0o700 });
  const shimPath = path.join(binDir, "ssh");
  await writeFile(shimPath, LOOPBACK_SSH_SCRIPT, { mode: 0o700 });
  await chmod(shimPath, 0o700);
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
  const remoteDir = await mkdtemp(path.join(scratchDir, "remote-"));
  spec = {
    host: "127.0.0.1",
    port: 22,
    username: os.userInfo().username,
    remoteCwd: remoteDir,
    remoteWorkspacePath: remoteDir,
    privateKey: "dummy-private-key",
    knownHosts: null,
    strictHostKeyChecking: false,
  };
  console.warn(`ssh-env-argv: using the loopback ssh stand-in (${reason})`);
}

beforeAll(async () => {
  scratchDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-env-argv-"));
  if (process.platform !== "linux") {
    unsupportedReason = "argv scan needs Linux /proc";
    return;
  }
  const support = await getSshEnvLabSupport();
  if (!support.supported) {
    await useLoopbackSsh(support.reason ?? "sshd fixture unsupported");
    return;
  }
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-fixture-"));
  try {
    fixtureState = await startSshEnvLabFixture({ statePath: path.join(fixtureRoot, "state.json") });
  } catch {
    // The fixture error text carries the fixture's own launch script, which
    // is noise here; name the fallback and use the stand-in.
    await useLoopbackSsh("sshd fixture could not run a command");
    return;
  }
  const config = await buildSshEnvLabFixtureConfig(fixtureState);
  spec = { ...config, remoteCwd: config.remoteWorkspacePath };
  console.warn("ssh-env-argv: using the real sshd fixture");
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  if (originalPath !== undefined) process.env.PATH = originalPath;
  if (fixtureState) await stopSshEnvLabFixture(fixtureState).catch(() => undefined);
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
  if (scratchDir) await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
});

function requireSpec(label: string): SshRemoteExecutionSpec | null {
  if (!spec) {
    console.warn(`Skipping ${label}: ${unsupportedReason ?? "SSH fixture unavailable"}`);
    return null;
  }
  return spec;
}

// Prints the secret, a separator, then the caller's stdin. `cat` returns only
// on EOF, so a completed run proves EOF reached the target. The pause keeps
// the remote process alive long enough for the scanner to sample it.
const ECHO_ENV_AND_STDIN_SCRIPT =
  'printf "%s" "$PC_DUMMY_SECRET"; printf "\\n--stdin--\\n"; cat; sleep 0.3';

describe("SSH env values stay out of process arguments", () => {
  it("never puts env values in the spawn target argv (unit)", async () => {
    const { value } = dummySecret();
    const target = await buildSshSpawnTarget({
      spec: {
        host: "ssh.example.test",
        port: 22,
        username: "ssh-user",
        remoteCwd: "/srv/paperclip/workspace",
        remoteWorkspacePath: "/srv/paperclip/workspace",
        privateKey: "dummy-private-key",
        knownHosts: null,
        strictHostKeyChecking: true,
      },
      command: "node",
      args: ["--version"],
      env: { PC_DUMMY_SECRET: value },
    });
    const keyPath = target.args[target.args.indexOf("-i") + 1]!;
    try {
      expect(target.args.join("\0")).not.toContain("dummy-ssh-secret-");
      expect(target.args.join("\0")).not.toContain("exec env ");
      expect(target.stdinPrefix).toContain("dummy-ssh-secret-");
      await expect(stat(keyPath)).resolves.toBeTruthy();
    } finally {
      await target.cleanup();
    }
    await expect(stat(keyPath)).rejects.toThrow();
  });

  it("buildSshSpawnTarget via runChildProcess: value reaches the target, stdin and EOF intact", async () => {
    const remote = requireSpec("spawn target argv scan");
    if (!remote) return;
    const { value, markers } = dummySecret();
    const probe = `pc-probe-${randomUUID()}`;
    const { value: result, scan } = await withArgvScanner(markers, probe, () =>
      runChildProcess(`ssh-argv-${randomUUID()}`, "sh", ["-c", ECHO_ENV_AND_STDIN_SCRIPT, probe], {
        cwd: process.cwd(),
        env: { PC_DUMMY_SECRET: value, PC_SECOND: "plain" },
        stdin: "caller line 1\ncaller line 2",
        timeoutSec: 30,
        graceSec: 2,
        onLog: async () => {},
        remoteExecution: remote,
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${value}\n--stdin--\ncaller line 1\ncaller line 2`);
    expectBothEndsObservedAndClean(scan);
  }, TEST_TIMEOUT_MS);

  it("buildSshSpawnTarget via runChildProcess: no caller stdin still gets EOF, exit code propagates", async () => {
    const remote = requireSpec("spawn target EOF");
    if (!remote) return;
    const { value, markers } = dummySecret();
    const probe = `pc-probe-${randomUUID()}`;
    const { value: result, scan } = await withArgvScanner(markers, probe, () =>
      runChildProcess(
        `ssh-argv-${randomUUID()}`,
        "sh",
        ["-c", `${ECHO_ENV_AND_STDIN_SCRIPT}; exit 7`, probe],
        {
          cwd: process.cwd(),
          env: { PC_DUMMY_SECRET: value },
          timeoutSec: 30,
          graceSec: 2,
          onLog: async () => {},
          remoteExecution: remote,
        },
      ),
    );
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toBe(`${value}\n--stdin--\n`);
    expectBothEndsObservedAndClean(scan);
  }, TEST_TIMEOUT_MS);

  it("runSshCommand: value reaches the command, stdin and EOF intact", async () => {
    const remote = requireSpec("runSshCommand argv scan");
    if (!remote) return;
    const { value, markers } = dummySecret();
    const probe = `pc-probe-${randomUUID()}`;
    const { value: result, scan } = await withArgvScanner(markers, probe, () =>
      runSshCommand(remote, `: ${probe}; ${ECHO_ENV_AND_STDIN_SCRIPT}`, {
        env: { PC_DUMMY_SECRET: value },
        stdin: "from caller\n",
        timeoutMs: 30_000,
      }),
    );
    expect(result.stdout).toBe(`${value}\n--stdin--\nfrom caller\n`);
    expectBothEndsObservedAndClean(scan);
  }, TEST_TIMEOUT_MS);

  it("runSshCommand: caller env still overrides a login profile export", async () => {
    const remote = requireSpec("profile override");
    if (!remote) return;
    if (fixtureState) {
      // The real fixture logs in with the account's own HOME; this check needs
      // a controlled profile, which only the loopback stand-in gives.
      console.warn("Skipping profile override: needs the loopback stand-in");
      return;
    }
    const fakeHome = await mkdtemp(path.join(scratchDir, "home-"));
    await writeFile(
      path.join(fakeHome, ".profile"),
      "export PC_OVERRIDE=from-profile\nexport PC_PROFILE_ONLY=yes\n",
      { mode: 0o600 },
    );
    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const result = await runSshCommand(
        remote,
        'printf "%s|%s|%s" "$PC_OVERRIDE" "$PC_PROFILE_ONLY" "$__pc_env"',
        {
          // A caller key that shares a reader variable name must survive too.
          env: { PC_OVERRIDE: "from-caller", __pc_env: "kept" },
          timeoutMs: 30_000,
        },
      );
      expect(result.stdout).toBe("from-caller|yes|kept");
    } finally {
      process.env.HOME = originalHome;
    }
  }, TEST_TIMEOUT_MS);

  it("runSshCommand: a failure keeps the value out of argv and out of the error", async () => {
    const remote = requireSpec("runSshCommand failure");
    if (!remote) return;
    const { value, markers } = dummySecret();
    const probe = `pc-probe-${randomUUID()}`;
    const { value: failure, scan } = await withArgvScanner(markers, probe, async () => {
      try {
        await runSshCommand(remote, `: ${probe}; sleep 0.3; echo boom >&2; exit 3`, {
          env: { PC_DUMMY_SECRET: value },
          timeoutMs: 30_000,
        });
        return null;
      } catch (error) {
        return error as Error & { code?: number; stderr?: string };
      }
    });
    expect(failure).not.toBeNull();
    expect(failure?.code).toBe(3);
    expect(failure?.stderr).toContain("boom");
    for (const marker of markers) {
      expect(String(failure?.message)).not.toContain(marker);
      expect(String(failure?.stderr)).not.toContain(marker);
    }
    expectBothEndsObservedAndClean(scan);
  }, TEST_TIMEOUT_MS);

  it("runSshCommand: a truncated env header fails closed before the command runs", async () => {
    const remote = requireSpec("truncated header");
    if (!remote) return;
    const target = await buildSshSpawnTarget({
      spec: remote,
      command: "sh",
      args: ["-c", "echo target-ran"],
      env: { PC_DUMMY_SECRET: "a\nb\nc" },
    });
    try {
      const header = target.stdinPrefix!;
      const truncated = header.slice(0, header.lastIndexOf("b"));
      const result = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
        const child = spawn(target.command, target.args, { stdio: ["pipe", "pipe", "ignore"] });
        let stdout = "";
        child.stdout.on("data", (chunk) => { stdout += String(chunk); });
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, stdout }));
        child.stdin.end(truncated);
      });
      expect(result.code).toBe(125);
      expect(result.stdout).not.toContain("target-ran");
    } finally {
      await target.cleanup();
    }
  }, TEST_TIMEOUT_MS);

  it("createSshCommandManagedRuntimeRunner: value reaches the command, stdin and EOF intact", async () => {
    const remote = requireSpec("command runner argv scan");
    if (!remote) return;
    const { value, markers } = dummySecret();
    const probe = `pc-probe-${randomUUID()}`;
    const runner = createSshCommandManagedRuntimeRunner({ spec: remote });
    const { value: result, scan } = await withArgvScanner(markers, probe, () =>
      runner.execute({
        command: "sh",
        args: ["-c", ECHO_ENV_AND_STDIN_SCRIPT, probe],
        env: { PC_DUMMY_SECRET: value },
        stdin: "runner input",
        timeoutMs: 30_000,
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${value}\n--stdin--\nrunner input`);
    expectBothEndsObservedAndClean(scan);
  }, TEST_TIMEOUT_MS);

  it("adapter SSH execution target: process and shell paths keep the value out of argv", async () => {
    const remote = requireSpec("adapter execution target argv scan");
    if (!remote) return;
    const target: AdapterSshExecutionTarget = {
      kind: "remote",
      transport: "ssh",
      remoteCwd: remote.remoteCwd,
      spec: remote,
    };
    const { value, markers } = dummySecret();
    const probe = `pc-probe-${randomUUID()}`;
    const { value: results, scan } = await withArgvScanner(markers, probe, async () => {
      const processResult = await runAdapterExecutionTargetProcess(
        `ssh-argv-${randomUUID()}`,
        target,
        "sh",
        ["-c", ECHO_ENV_AND_STDIN_SCRIPT, probe],
        {
          cwd: process.cwd(),
          env: { PC_DUMMY_SECRET: value },
          stdin: "adapter prompt\n",
          timeoutSec: 30,
          graceSec: 2,
          onLog: async () => {},
        },
      );
      const shellResult = await runAdapterExecutionTargetShellCommand(
        `ssh-argv-${randomUUID()}`,
        target,
        `: ${probe}; printf "%s" "$PC_DUMMY_SECRET"; sleep 0.3`,
        { cwd: remote.remoteCwd, env: { PC_DUMMY_SECRET: value }, timeoutSec: 30 },
      );
      return { processResult, shellResult };
    });
    expect(results.processResult.exitCode).toBe(0);
    expect(results.processResult.stdout).toBe(`${value}\n--stdin--\nadapter prompt\n`);
    expect(results.shellResult.exitCode).toBe(0);
    expect(results.shellResult.stdout).toBe(value);
    expectBothEndsObservedAndClean(scan);
  }, TEST_TIMEOUT_MS);
});
