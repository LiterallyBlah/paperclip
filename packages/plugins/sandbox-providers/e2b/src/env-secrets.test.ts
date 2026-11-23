// BLA-3978: caller env (the agent's PAPERCLIP_API_KEY and other secrets) must
// never appear in the command text handed to the E2B SDK or in any argv, and
// must still reach the target process env. The fake SDK below runs the exact
// command text through a real local `bash -c`, mapping the sandbox's /tmp
// staging paths into a private test directory.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockConnect = vi.hoisted(() => vi.fn());
const { MockCommandExitError } = vi.hoisted(() => {
  class MockCommandExitError extends Error {
    exitCode: number;
    stdout: string;
    stderr: string;
    constructor(result: { exitCode: number; stdout: string; stderr: string }) {
      super("command failed");
      this.exitCode = result.exitCode;
      this.stdout = result.stdout;
      this.stderr = result.stderr;
    }
  }
  return { MockCommandExitError };
});

vi.mock("e2b", () => ({
  CommandExitError: MockCommandExitError,
  SandboxNotFoundError: class extends Error {},
  TimeoutError: class extends Error {},
  Sandbox: { create: vi.fn(), connect: mockConnect },
}));

import plugin from "./plugin.js";

const DUMMY_API_KEY = "pcp-dummy-api-key-bla3978-e2b";
const DUMMY_OTHER = "dummy-other-secret-bla3978-e2b";

// Prints env, argv, stdin and any leftover staged env files as JSON.
const PROBE = [
  "const fs=require('fs');",
  "const dir=process.env.PROBE_DIR;",
  "const stdin=process.env.PROBE_READ_STDIN?fs.readFileSync(0,'utf8'):null;",
  "const leftovers=fs.readdirSync(dir).filter((n)=>n.startsWith('paperclip-env-'));",
  "process.stdout.write(JSON.stringify({key:process.env.PAPERCLIP_API_KEY??null,other:process.env.OTHER_SECRET??null,",
  "multi:process.env.MULTI??null,argv:process.argv,stdin,leftovers}));",
  "process.exit(Number(process.env.PROBE_EXIT??0));",
].join("");

let root: string;

function createRealShellSandbox() {
  const toLocal = (remote: string) => remote.replace(/^\/tmp\//, `${root}/`);
  const commandTexts: string[] = [];
  const runOptions: unknown[] = [];
  const sandbox = {
    sandboxId: "sandbox-env",
    setTimeout: vi.fn().mockResolvedValue(undefined),
    files: {
      write: vi.fn(async (remote: string, data: string) => {
        fs.writeFileSync(toLocal(remote), data);
      }),
      remove: vi.fn(async (remote: string) => {
        fs.rmSync(toLocal(remote), { force: true });
      }),
    },
    commands: {
      run: vi.fn(async (command: string, options?: unknown) => {
        commandTexts.push(command);
        runOptions.push(options);
        const localCommand = command.split("/tmp/paperclip-").join(`${root}/paperclip-`);
        const res = spawnSync("bash", ["-c", localCommand], {
          cwd: root,
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, PROBE_DIR: root },
          encoding: "utf8",
        });
        const result = { exitCode: res.status ?? 1, stdout: res.stdout, stderr: res.stderr };
        if (result.exitCode !== 0) throw new MockCommandExitError(result);
        return result;
      }),
    },
  };
  return { sandbox, commandTexts, runOptions };
}

async function execute(env: Record<string, string>, extra: { stdin?: string } = {}) {
  return await plugin.definition.onEnvironmentExecute?.({
    driverKey: "e2b",
    companyId: "company-1",
    environmentId: "env-1",
    config: { template: "base", apiKey: "resolved-key", timeoutMs: 30_000, reuseLease: false },
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

describe("E2B execute keeps env secrets out of command text and argv (BLA-3978)", () => {
  beforeEach(() => {
    mockConnect.mockReset();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "e2b-env-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("delivers PAPERCLIP_API_KEY and another secret without putting them in the SDK command text", async () => {
    const fake = createRealShellSandbox();
    mockConnect.mockResolvedValue(fake.sandbox);

    const result = await execute({ PAPERCLIP_API_KEY: DUMMY_API_KEY, OTHER_SECRET: DUMMY_OTHER });

    expect(result?.exitCode).toBe(0);
    const out = JSON.parse(result!.stdout);
    expect(out.key).toBe(DUMMY_API_KEY);
    expect(out.other).toBe(DUMMY_OTHER);
    expect(out.leftovers).toEqual([]);
    expectNoSecretIn(out.argv, [DUMMY_API_KEY, DUMMY_OTHER]);
    expectNoSecretIn(fake.commandTexts, [DUMMY_API_KEY, DUMMY_OTHER]);
    expectNoSecretIn(fake.runOptions, [DUMMY_API_KEY, DUMMY_OTHER]);
    expect(fake.commandTexts.join("\n")).not.toMatch(/\benv [A-Z_]+=/);
    expect(fs.readdirSync(root).filter((n) => n.startsWith("paperclip-"))).toEqual([]);
  });

  it("preserves quoted and multiline values exactly", async () => {
    const fake = createRealShellSandbox();
    mockConnect.mockResolvedValue(fake.sandbox);
    const multi = `line one\nit's "quoted" $HOME \`not run\` \\ back\n\ttab'`;

    const result = await execute({ PAPERCLIP_API_KEY: DUMMY_API_KEY, MULTI: multi });

    const out = JSON.parse(result!.stdout);
    expect(out.multi).toBe(multi);
    expect(out.key).toBe(DUMMY_API_KEY);
    expectNoSecretIn(fake.commandTexts, [DUMMY_API_KEY, "not run"]);
  });

  it("delivers stdin up to EOF alongside staged env", async () => {
    const fake = createRealShellSandbox();
    mockConnect.mockResolvedValue(fake.sandbox);

    const result = await execute(
      { PAPERCLIP_API_KEY: DUMMY_API_KEY, OTHER_SECRET: DUMMY_OTHER, PROBE_READ_STDIN: "1" },
      { stdin: "first\nsecond line\n" },
    );

    const out = JSON.parse(result!.stdout);
    expect(out.stdin).toBe("first\nsecond line\n");
    expect(out.key).toBe(DUMMY_API_KEY);
    expectNoSecretIn(fake.commandTexts, [DUMMY_API_KEY, DUMMY_OTHER]);
    expect(fs.readdirSync(root).filter((n) => n.startsWith("paperclip-"))).toEqual([]);
  });

  it("returns the command's exit code and still removes staged files on failure", async () => {
    const fake = createRealShellSandbox();
    mockConnect.mockResolvedValue(fake.sandbox);

    const result = await execute(
      { PAPERCLIP_API_KEY: DUMMY_API_KEY, PROBE_EXIT: "7" },
      { stdin: "x" },
    );

    expect(result?.exitCode).toBe(7);
    expect(result?.timedOut).toBe(false);
    expectNoSecretIn(fake.commandTexts, [DUMMY_API_KEY]);
    expect(fs.readdirSync(root).filter((n) => n.startsWith("paperclip-"))).toEqual([]);
  });

  it("removes the staged env file when staging stdin fails", async () => {
    const fake = createRealShellSandbox();
    const realWrite = fake.sandbox.files.write.getMockImplementation()!;
    fake.sandbox.files.write.mockImplementation(async (remote: string, data: string) => {
      if (remote.includes("paperclip-stdin-")) throw new Error("stdin write failed");
      return realWrite(remote, data);
    });
    mockConnect.mockResolvedValue(fake.sandbox);

    await expect(execute({ PAPERCLIP_API_KEY: DUMMY_API_KEY }, { stdin: "x" })).rejects.toThrow(
      "stdin write failed",
    );
    expect(fake.commandTexts).toEqual([]);
    expect(fake.sandbox.files.remove).toHaveBeenCalledWith(expect.stringMatching(/^\/tmp\/paperclip-env-/));
    expect(fs.readdirSync(root).filter((n) => n.startsWith("paperclip-"))).toEqual([]);
  });
});
