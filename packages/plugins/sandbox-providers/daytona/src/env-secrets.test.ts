// BLA-4139: caller env (the agent's PAPERCLIP_API_KEY and other secrets) must
// never appear in the command text handed to Daytona `executeCommand` or
// `executeSessionCommand`, or in any argv, and must still reach the target
// process env. The fake sandbox runs the exact command text locally through
// `sh -c`, mapping the sandbox's /tmp staging paths into a private test
// directory. Only the file-upload body may hold a value: that is the file
// channel itself.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGet = vi.hoisted(() => vi.fn());
const { MockDaytonaNotFoundError, MockDaytonaTimeoutError } = vi.hoisted(() => {
  class MockDaytonaNotFoundError extends Error {}
  class MockDaytonaTimeoutError extends Error {}
  return { MockDaytonaNotFoundError, MockDaytonaTimeoutError };
});

vi.mock("@daytonaio/sdk", () => ({
  Daytona: class MockDaytona {
    create = vi.fn();
    get = mockGet;
    snapshot = { get: vi.fn(), delete: vi.fn() };
    constructor(_config?: unknown) {}
  },
  DaytonaNotFoundError: MockDaytonaNotFoundError,
  DaytonaTimeoutError: MockDaytonaTimeoutError,
}));

import plugin, { __resetDaytonaSandboxHandleCacheForTest } from "./plugin.js";

const DUMMY_API_KEY = "pcp-dummy-api-key-bla4139-daytona";
const DUMMY_OTHER = "dummy-other-secret-bla4139-daytona";

// Prints env, argv, stdin and any leftover staged env files as JSON.
const PROBE = [
  "const fs=require('fs');",
  "const dir=process.env.PROBE_DIR;",
  "const stdin=process.env.PROBE_READ_STDIN?fs.readFileSync(0,'utf8'):null;",
  "const leftovers=fs.readdirSync(dir).filter((n)=>n.startsWith('paperclip-env-'));",
  "process.stdout.write(JSON.stringify({key:process.env.PAPERCLIP_API_KEY??null,other:process.env.OTHER_SECRET??null,",
  "multi:process.env.MULTI??null,uid:process.env.UID??null,profileOnly:process.env.PROFILE_ONLY??null,",
  "git:process.env.GIT_TERMINAL_PROMPT??null,",
  "aliases:Object.keys(process.env).filter((k)=>k.startsWith('__paperclip_env')),",
  "argv:process.argv,stdin,leftovers}));",
  "process.exit(Number(process.env.PROBE_EXIT??0));",
].join("");

let root: string;

// `binSh` emulates an image whose /bin/sh is another shell (for example bash).
function fakeSandbox(options: { binSh?: string; failUploadOf?: "env" | "stdin" } = {}) {
  const toLocal = (remote: string) => remote.replace(/^\/tmp\//, `${root}/`);
  const commandTexts: string[] = [];
  const uploads: string[] = [];
  const run = (command: string) => {
    let local = command.replace(/'\/tmp\/paperclip-/g, () => `'${root}/paperclip-`);
    if (options.binSh) local = local.replace(/ \/bin\/sh -c /g, () => ` ${options.binSh} -c `);
    const res = spawnSync("/bin/sh", ["-c", local], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, PROBE_DIR: root },
      encoding: "utf8",
    });
    return { status: res.status ?? 1, stdout: res.stdout, stderr: res.stderr };
  };
  let last: { status: number; stdout: string; stderr: string } | null = null;
  const sandbox = {
    id: "sandbox-env",
    state: "started",
    autoStopInterval: 15,
    autoArchiveInterval: 0,
    autoDeleteInterval: -1,
    getWorkDir: vi.fn().mockResolvedValue("/home/daytona"),
    getUserHomeDir: vi.fn().mockResolvedValue("/home/daytona"),
    start: vi.fn().mockResolvedValue(undefined),
    refreshData: vi.fn().mockResolvedValue(undefined),
    setAutoDeleteInterval: vi.fn().mockResolvedValue(undefined),
    fs: {
      createFolder: vi.fn().mockResolvedValue(undefined),
      uploadFile: vi.fn(async (body: Buffer, remote: string) => {
        uploads.push(remote);
        if (options.failUploadOf && remote.includes(`paperclip-${options.failUploadOf}-`)) {
          throw new Error("upload failed");
        }
        fs.writeFileSync(toLocal(remote), body);
      }),
      deleteFile: vi.fn(async (remote: string) => {
        fs.rmSync(toLocal(remote), { force: true });
      }),
    },
    process: {
      executeCommand: vi.fn(async (command: string) => {
        commandTexts.push(command);
        const res = run(command);
        return { exitCode: res.status, result: res.stdout + res.stderr };
      }),
      createSession: vi.fn().mockResolvedValue(undefined),
      executeSessionCommand: vi.fn(async (_id: string, request: { command: string }) => {
        commandTexts.push(request.command);
        last = run(request.command);
        return { cmdId: "cmd-env" };
      }),
      getSessionCommand: vi.fn(async () => ({ id: "cmd-env", command: "", exitCode: last?.status ?? 0 })),
      getSessionCommandLogs: vi.fn(async () => ({ stdout: last?.stdout ?? "", stderr: last?.stderr ?? "" })),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    },
  };
  mockGet.mockResolvedValue(sandbox);
  return { sandbox, commandTexts, uploads };
}

async function run(env: Record<string, string>, extra: { stdin?: string } = {}) {
  return await plugin.definition.onEnvironmentExecute!({
    driverKey: "daytona",
    companyId: "company-1",
    environmentId: "env-1",
    config: { timeoutMs: 300000, reuseLease: false },
    bypassSession: true,
    lease: { providerLeaseId: "sandbox-env", metadata: {} },
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

const staged = () => fs.readdirSync(root).filter((n) => n.startsWith("paperclip-"));

describe("Daytona execute keeps env secrets out of command text and argv (BLA-4139)", () => {
  beforeEach(() => {
    process.env.DAYTONA_API_KEY = "host-key";
    root = fs.mkdtempSync(path.join(os.tmpdir(), "daytona-env-"));
  });
  afterEach(() => {
    delete process.env.DAYTONA_API_KEY;
    vi.clearAllMocks();
    __resetDaytonaSandboxHandleCacheForTest();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("delivers PAPERCLIP_API_KEY and another secret without putting them in the command text", async () => {
    const fake = fakeSandbox();

    const result = await run({ PAPERCLIP_API_KEY: DUMMY_API_KEY, OTHER_SECRET: DUMMY_OTHER });

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.key).toBe(DUMMY_API_KEY);
    expect(out.other).toBe(DUMMY_OTHER);
    expect(out.git).toBe("0");
    expect(out.aliases).toEqual([]);
    // Removed before exec, not only in cleanup.
    expect(out.leftovers).toEqual([]);
    expectNoSecretIn(out.argv, [DUMMY_API_KEY, DUMMY_OTHER]);
    expectNoSecretIn(fake.commandTexts, [DUMMY_API_KEY, DUMMY_OTHER]);
    expect(fake.uploads).toEqual([expect.stringMatching(/^\/tmp\/paperclip-env-/)]);
    expect(staged()).toEqual([]);
  });

  it("keeps env secrets out of the persistent-session command text too", async () => {
    const fake = fakeSandbox();

    const result = await plugin.definition.onEnvironmentExecute!({
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      config: { timeoutMs: 300000, reuseLease: false },
      lease: { providerLeaseId: "sandbox-env", metadata: {} },
      command: process.execPath,
      args: ["-e", PROBE],
      cwd: root,
      env: { PAPERCLIP_API_KEY: DUMMY_API_KEY },
      timeoutMs: 30_000,
    });

    expect(fake.sandbox.process.executeSessionCommand).toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).key).toBe(DUMMY_API_KEY);
    expectNoSecretIn(fake.commandTexts, [DUMMY_API_KEY]);
    expect(staged()).toEqual([]);
  });

  it("preserves quoted and multiline values exactly", async () => {
    const fake = fakeSandbox();
    const multi = "line one\nit's \"quoted\" $HOME `x` \\ end\n\nlast";

    const result = await run({ PAPERCLIP_API_KEY: DUMMY_API_KEY, MULTI: multi });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).multi).toBe(multi);
    expectNoSecretIn(fake.commandTexts, [DUMMY_API_KEY, "line one", "quoted"]);
  });

  it("delivers stdin up to EOF alongside staged env", async () => {
    const fake = fakeSandbox();
    const stdin = "first line\nsecond line without newline";

    const result = await run({ PAPERCLIP_API_KEY: DUMMY_API_KEY, PROBE_READ_STDIN: "1" }, { stdin });

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.stdin).toBe(stdin);
    expect(out.key).toBe(DUMMY_API_KEY);
    expectNoSecretIn(fake.commandTexts, [DUMMY_API_KEY]);
    expect(staged()).toEqual([]);
  });

  it("returns the command's exit code and still removes staged files on failure", async () => {
    fakeSandbox();

    const result = await run({ PAPERCLIP_API_KEY: DUMMY_API_KEY, PROBE_EXIT: "7" }, { stdin: "x" });

    expect(result.exitCode).toBe(7);
    expect(staged()).toEqual([]);
  });

  it("removes the staged env file when staging stdin fails", async () => {
    const fake = fakeSandbox({ failUploadOf: "stdin" });

    await expect(run({ PAPERCLIP_API_KEY: DUMMY_API_KEY }, { stdin: "x" })).rejects.toThrow("upload failed");

    expect(fake.uploads).toHaveLength(2);
    expect(staged()).toEqual([]);
    expect(fake.commandTexts).toEqual([]);
  });

  it("keeps caller env over a value and readonly flag set by the login profile", async () => {
    fakeSandbox();
    fs.writeFileSync(
      path.join(root, ".profile"),
      "PAPERCLIP_API_KEY=from-profile; export PAPERCLIP_API_KEY; readonly PAPERCLIP_API_KEY; PROFILE_ONLY=yes; export PROFILE_ONLY\n",
    );

    const result = await run({ PAPERCLIP_API_KEY: DUMMY_API_KEY });

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.key).toBe(DUMMY_API_KEY);
    expect(out.profileOnly).toBe("yes");
  });

  it("keeps a bash-readonly name (UID) when /bin/sh is bash, without values in argv", async () => {
    const fake = fakeSandbox({ binSh: "/bin/bash" });

    const result = await run({ PAPERCLIP_API_KEY: DUMMY_API_KEY, UID: "dummy-uid-bla4139" });

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.uid).toBe("dummy-uid-bla4139");
    expect(out.key).toBe(DUMMY_API_KEY);
    expect(out.aliases).toEqual([]);
    expectNoSecretIn([out.argv, fake.commandTexts], [DUMMY_API_KEY, "dummy-uid-bla4139"]);
  });

  it("lets caller env override a git default, and stages nothing without caller env", async () => {
    const fake = fakeSandbox();

    const overridden = JSON.parse((await run({ GIT_TERMINAL_PROMPT: "1" })).stdout);
    expect(overridden.git).toBe("1");

    fake.uploads.length = 0;
    const plain = await run({});
    expect(plain.exitCode).toBe(0);
    expect(JSON.parse(plain.stdout).git).toBe("0");
    expect(fake.uploads).toEqual([]);
  });
});
