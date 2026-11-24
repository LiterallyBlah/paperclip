// BLA-3999: caller env (the agent's PAPERCLIP_API_KEY and other secrets) must
// never appear in the ssh argv or the remote command text, and must still
// reach the target process env. The fake `ssh` below runs the exact remote
// command through a real local `/bin/sh -c`, as sshd hands it to the login
// shell, and pipes the exact stdin bytes the plugin writes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const realSpawn = vi.hoisted(() => ({ fn: null as null | typeof import("node:child_process").spawn }));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  realSpawn.fn = actual.spawn;
  return { ...actual, spawn: spawnMock };
});

import plugin from "./plugin.js";

const DUMMY_API_KEY = "pcp-dummy-api-key-bla3999-exedev";
const DUMMY_OTHER = "dummy-other-secret-bla3999-exedev";

// Prints env, argv and stdin as JSON.
const PROBE = [
  "const fs=require('fs');",
  "const stdin=process.env.PROBE_READ_STDIN?fs.readFileSync(0,'utf8'):null;",
  "process.stdout.write(JSON.stringify({key:process.env.PAPERCLIP_API_KEY??null,other:process.env.OTHER_SECRET??null,",
  "multi:process.env.MULTI??null,uid:process.env.UID??null,profileOnly:process.env.PROFILE_ONLY??null,",
  "aliases:Object.keys(process.env).filter((k)=>k.startsWith('__paperclip_env')||k.startsWith('__pc_')),",
  "argv:process.argv,stdin}));",
  "process.exit(Number(process.env.PROBE_EXIT??0));",
].join("");

let root: string;
let sshArgv: string[][];

// `binSh` emulates a VM whose /bin/sh is another shell (for example bash).
function useRealShellSsh(shell: { binSh?: string } = {}) {
  spawnMock.mockImplementation((command: string, args: string[], options: Record<string, unknown>) => {
    expect(command).toBe("ssh");
    sshArgv.push(args);
    let remote = args.at(-1)!;
    if (shell.binSh) remote = remote.replace("exec /bin/sh -c ", () => `exec ${shell.binSh} -c `);
    return realSpawn.fn!("/bin/sh", ["-c", remote], {
      ...options,
      cwd: root,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, PROBE_DIR: root },
    });
  });
}

async function execute(env: Record<string, string>, extra: { stdin?: string } = {}) {
  return await plugin.definition.onEnvironmentExecute?.({
    driverKey: "exe-dev",
    companyId: "company-1",
    environmentId: "env-1",
    config: { apiKey: "api-key", timeoutMs: 30_000 },
    lease: { providerLeaseId: "vm-1", metadata: { sshDest: "vm-1.exe.xyz" } },
    command: process.execPath,
    args: ["-e", PROBE],
    cwd: root,
    env,
    stdin: extra.stdin,
    timeoutMs: 30_000,
  });
}

function expectNoSecretIn(texts: unknown[], secrets: string[]) {
  const haystack = JSON.stringify(texts);
  for (const secret of secrets) expect(haystack).not.toContain(secret);
}

describe("exe.dev execute keeps env secrets out of ssh argv and remote command text (BLA-3999)", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    sshArgv = [];
    root = fs.mkdtempSync(path.join(os.tmpdir(), "exedev-env-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("delivers PAPERCLIP_API_KEY and another secret without putting them in the ssh argv", async () => {
    useRealShellSsh();

    const result = await execute({ PAPERCLIP_API_KEY: DUMMY_API_KEY, OTHER_SECRET: DUMMY_OTHER });

    expect(result?.stderr).toBe("");
    expect(result?.exitCode).toBe(0);
    const out = JSON.parse(result!.stdout);
    expect(out.key).toBe(DUMMY_API_KEY);
    expect(out.other).toBe(DUMMY_OTHER);
    expect(out.aliases).toEqual([]);
    expect(out.stdin).toBeNull();
    expectNoSecretIn(out.argv, [DUMMY_API_KEY, DUMMY_OTHER]);
    expect(sshArgv).toHaveLength(1);
    expectNoSecretIn(sshArgv, [DUMMY_API_KEY, DUMMY_OTHER]);
    expect(sshArgv.flat().join(" ")).not.toMatch(/\benv [A-Z_]+=/);
  });

  it("preserves quoted and multiline values exactly", async () => {
    useRealShellSsh();
    const multi = "line one\nit's \"quoted\" $HOME `x` \\ end\n\nlast";

    const result = await execute({ PAPERCLIP_API_KEY: DUMMY_API_KEY, MULTI: multi });

    expect(result?.exitCode).toBe(0);
    const out = JSON.parse(result!.stdout);
    expect(out.multi).toBe(multi);
    expect(out.key).toBe(DUMMY_API_KEY);
    expectNoSecretIn(sshArgv, [DUMMY_API_KEY, "line one", "quoted"]);
  });

  it("delivers stdin up to EOF after the env header", async () => {
    useRealShellSsh();
    const stdin = "first line\nsecond line without newline";

    const result = await execute({ PAPERCLIP_API_KEY: DUMMY_API_KEY, PROBE_READ_STDIN: "1" }, { stdin });

    expect(result?.exitCode).toBe(0);
    const out = JSON.parse(result!.stdout);
    expect(out.stdin).toBe(stdin);
    expect(out.key).toBe(DUMMY_API_KEY);
    expectNoSecretIn(sshArgv, [DUMMY_API_KEY]);
  });

  it("gives the target EOF right after the header when there is no caller stdin", async () => {
    useRealShellSsh();

    const result = await execute({ PAPERCLIP_API_KEY: DUMMY_API_KEY, PROBE_READ_STDIN: "1" });

    expect(result?.exitCode).toBe(0);
    expect(JSON.parse(result!.stdout).stdin).toBe("");
  });

  it("returns the command's exit code with values still out of the ssh argv", async () => {
    useRealShellSsh();

    const result = await execute({ PAPERCLIP_API_KEY: DUMMY_API_KEY, PROBE_EXIT: "7" });

    expect(result?.exitCode).toBe(7);
    expect(JSON.parse(result!.stdout).key).toBe(DUMMY_API_KEY);
    expectNoSecretIn(sshArgv, [DUMMY_API_KEY]);
  });

  it("keeps caller env over a value and readonly flag set by the login profile", async () => {
    useRealShellSsh();
    fs.writeFileSync(
      path.join(root, ".profile"),
      "PAPERCLIP_API_KEY=from-profile; export PAPERCLIP_API_KEY; readonly PAPERCLIP_API_KEY; PROFILE_ONLY=yes; export PROFILE_ONLY\n",
    );

    const result = await execute({ PAPERCLIP_API_KEY: DUMMY_API_KEY });

    expect(result?.exitCode).toBe(0);
    const out = JSON.parse(result!.stdout);
    expect(out.key).toBe(DUMMY_API_KEY);
    expect(out.profileOnly).toBe("yes");
  });

  it("keeps a bash-readonly name (UID) when /bin/sh is bash, without values in argv", async () => {
    useRealShellSsh({ binSh: "/bin/bash" });

    const result = await execute({ PAPERCLIP_API_KEY: DUMMY_API_KEY, UID: "dummy-uid-bla3999" });

    expect(result?.exitCode).toBe(0);
    const out = JSON.parse(result!.stdout);
    expect(out.uid).toBe("dummy-uid-bla3999");
    expect(out.key).toBe(DUMMY_API_KEY);
    expect(out.aliases).toEqual([]);
    expectNoSecretIn([out.argv, sshArgv], [DUMMY_API_KEY, "dummy-uid-bla3999"]);
  });

  it("does not echo values when the profile turns on shell tracing", async () => {
    useRealShellSsh();
    fs.writeFileSync(path.join(root, ".profile"), "set -xv\n");

    const result = await execute({ PAPERCLIP_API_KEY: DUMMY_API_KEY });

    expect(result?.exitCode).toBe(0);
    expect(JSON.parse(result!.stdout).key).toBe(DUMMY_API_KEY);
    expectNoSecretIn([result?.stderr], [DUMMY_API_KEY]);
  });

  it("runs without a header or reader when there is no caller env", async () => {
    useRealShellSsh();

    const result = await execute({}, { stdin: "plain" });

    expect(result?.exitCode).toBe(0);
    expect(sshArgv[0]!.at(-1)).not.toContain("__pc_env");
  });

  it("rejects an invalid env name before starting ssh", async () => {
    useRealShellSsh();

    await expect(execute({ "BAD-KEY": DUMMY_API_KEY })).rejects.toThrow("Invalid exe.dev environment variable key: BAD-KEY");
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
