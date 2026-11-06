import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSshSpawnTarget, buildSshEnvLabFixtureConfig, runSshCommand, startSshEnvLabFixture, stopSshEnvLabFixture, type SshEnvLabFixtureState, type SshRemoteExecutionSpec } from "./ssh.js";
import { runChildProcess, runningProcesses, signalRunningProcess } from "./server-utils.js";

// Real loopback SSH fixture; setup errors fail rather than silently pass/skip.
describe("private SSH launch protocol", () => {
  let root: string, state: SshEnvLabFixtureState, spec: SshRemoteExecutionSpec;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "ssh-private-"));
    state = await startSshEnvLabFixture({ statePath: path.join(root, "state.json") });
    spec = { ...await buildSshEnvLabFixtureConfig(state), remoteCwd: state.workspaceDir };
  }, 30000);
  afterAll(async () => { if (state) await stopSshEnvLabFixture(state); if (root) await rm(root, { recursive: true, force: true }); });

  it("keeps bearer/env/query out of argv and preserves unicode, multiline env and stdin", async () => {
    const marker = "Bearer SSH_ARGV_MUST_NOT_CONTAIN_ME";
    const env = { PAPERCLIP_API_KEY: marker, OVERLAY: "line one\n'\"$; 雪\n", HOME: root, HERMES_HOME: path.join(root, "oracle") };
    const stdin = "input\u0000 雪\nsecond\n";
    const target = await buildSshSpawnTarget({ spec, command: "python3", args: ["-c", "import json,os,sys;print(json.dumps([os.environ['PAPERCLIP_API_KEY'],os.environ['OVERLAY'],os.environ['HOME'],os.environ['HERMES_HOME'],sys.stdin.read()]))"], env, stdin });
    try {
      expect(target.args.join(" ")).not.toContain(marker);
      expect(target.args.join(" ")).not.toContain(env.OVERLAY);
      const child = spawn(target.command, target.args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", c => { stdout += c; }); child.stderr.on("data", c => { stderr += c; });
      child.stdin.write(target.stdin);
      const [code] = await once(child, "close");
      expect(stderr).toBe(""); expect(code).toBe(0);
      expect(JSON.parse(stdout)).toEqual([marker, env.OVERLAY, root, env.HERMES_HOME, stdin]);
    } finally { await target.cleanup(); }
    const shell = await runSshCommand(spec, "printf '%s' \"$PAPERCLIP_API_KEY\"; cat", { env, stdin });
    expect(shell.stdout).toBe(marker + stdin);
  }, 30000);

  it.each(["timeout", "cancel"])("kills TERM-resistant remote children on %s without treating SSH close as a stop receipt", async mode => {
    const pidFile = path.join(root, `${mode}.pid`);
    const script = "import os,signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); open(os.environ['PID_FILE'],'w').write(str(os.getpid())); print('ready',flush=True); time.sleep(60)";
    let ready!: () => void; const started = new Promise<void>(r => { ready = r; });
    const runId = `ssh-private-${mode}`;
    const running = runChildProcess(runId, "python3", ["-c", script], { remoteExecution: spec, cwd: root, env: { PID_FILE: pidFile }, timeoutSec: mode === "timeout" ? 1 : 0, graceSec: 0.1, onLog: async (_s, text) => { if (text.includes("ready")) ready(); } });
    await started;
    if (mode === "cancel") signalRunningProcess(runningProcesses.get(runId)!, "SIGTERM");
    const result = await running;
    expect(result.timedOut).toBe(mode === "timeout");
    const pid = Number(await readFile(pidFile, "utf8"));
    // Cleanup can finish after the client close; wait for the remote grace.
    await expect.poll(async () => {
      const out = await runSshCommand(spec, `if kill -0 ${pid} 2>/dev/null; then ps -o stat= -p ${pid}; else printf gone; fi`);
      return out.stdout.trim() === "gone" || out.stdout.trim().startsWith("Z");
    }, { timeout: 5000 }).toBe(true);
  }, 30000);
});
