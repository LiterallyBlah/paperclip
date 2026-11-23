// BLA-4139: caller env (the agent's PAPERCLIP_API_KEY and other secrets) must
// never appear in the command text handed to Novita `commands.run`, or in any
// argv, and must still reach the target process env. The fake sandbox runs the
// exact command text locally through `/bin/bash -c` (as the Novita envd does),
// mapping the sandbox's /tmp staging paths into a private test directory. Only
// the files-API body may hold a value: that is the file channel itself.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSandboxConnect = vi.hoisted(() => vi.fn());

vi.mock("novita-sandbox", () => ({
  Sandbox: { connect: mockSandboxConnect, create: vi.fn() },
}));

import plugin from "./plugin.js";

const DUMMY_API_KEY = "pcp-dummy-api-key-bla4139-novita";
const DUMMY_OTHER = "dummy-other-secret-bla4139-novita";

const PROBE = [
  "const fs=require('fs');",
  "const dir=process.env.PROBE_DIR;",
  "const stdin=process.env.PROBE_READ_STDIN?fs.readFileSync(0,'utf8'):null;",
  "const leftovers=fs.readdirSync(dir).filter((n)=>n.startsWith('.paperclip-env-'));",
  "process.stdout.write(JSON.stringify({key:process.env.PAPERCLIP_API_KEY??null,other:process.env.OTHER_SECRET??null,",
  "multi:process.env.MULTI??null,uid:process.env.UID??null,",
  "aliases:Object.keys(process.env).filter((k)=>k.startsWith('__paperclip_env')),",
  "argv:process.argv,stdin,leftovers}));",
  "process.exit(Number(process.env.PROBE_EXIT??0));",
].join("");

let root: string;

function fakeSandbox(options: { binSh?: string; failWrite?: boolean } = {}) {
  const toLocal = (remote: string) => remote.replace(/^\/tmp\//, `${root}/`);
  const commandTexts: string[] = [];
  const writes: string[] = [];
  const sandbox = {
    sandboxId: "sb-env",
    files: {
      write: vi.fn(async (remote: string, data: string) => {
        writes.push(remote);
        if (options.failWrite) throw new Error("write failed");
        fs.writeFileSync(toLocal(remote), data);
        return { path: remote };
      }),
      remove: vi.fn(async (remote: string) => {
        fs.rmSync(toLocal(remote), { force: true });
      }),
    },
    commands: {
      run: vi.fn(async (command: string) => {
        commandTexts.push(command);
        let local = command.replace(/'\/tmp\/\.paperclip-/g, () => `'${root}/.paperclip-`);
        if (options.binSh) local = local.replace(/ \/bin\/sh -c /g, () => ` ${options.binSh} -c `);
        const res = spawnSync("/bin/bash", ["-c", local], {
          cwd: root,
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, PROBE_DIR: root },
          encoding: "utf8",
        });
        const result = { exitCode: res.status ?? 1, stdout: res.stdout, stderr: res.stderr };
        // The SDK throws a CommandExitError for a non-zero exit.
        if (result.exitCode !== 0) throw Object.assign(new Error("exit"), result);
        return result;
      }),
    },
  };
  mockSandboxConnect.mockResolvedValue(sandbox);
  return { sandbox, commandTexts, writes };
}

async function run(env: Record<string, string>, extra: { stdin?: string } = {}) {
  return await plugin.definition.onEnvironmentExecute!({
    driverKey: "novita",
    companyId: "company-1",
    environmentId: "env-1",
    config: { apiKey: "sk-test" },
    lease: { providerLeaseId: "sb-env", metadata: {} },
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

const staged = () => fs.readdirSync(root).filter((n) => n.startsWith(".paperclip-"));

describe("Novita execute keeps env secrets out of command text and argv (BLA-4139)", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novita-env-"));
  });
  afterEach(() => {
    vi.clearAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("delivers PAPERCLIP_API_KEY and another secret without putting them in the command text", async () => {
    const fake = fakeSandbox();

    const result = await run({ PAPERCLIP_API_KEY: DUMMY_API_KEY, OTHER_SECRET: DUMMY_OTHER });

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.key).toBe(DUMMY_API_KEY);
    expect(out.other).toBe(DUMMY_OTHER);
    expect(out.aliases).toEqual([]);
    expect(out.leftovers).toEqual([]);
    expectNoSecretIn(out.argv, [DUMMY_API_KEY, DUMMY_OTHER]);
    expectNoSecretIn(fake.commandTexts, [DUMMY_API_KEY, DUMMY_OTHER]);
    expect(fake.commandTexts.join("\n")).not.toMatch(/export [A-Z_]+=/);
    expect(fake.writes).toEqual([expect.stringMatching(/^\/tmp\/\.paperclip-env-/)]);
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

  it("does not run the command, and cleans up, when staging the env file fails", async () => {
    const fake = fakeSandbox({ failWrite: true });

    await expect(run({ PAPERCLIP_API_KEY: DUMMY_API_KEY })).rejects.toThrow("write failed");

    expect(fake.commandTexts).toEqual([]);
    expect(fake.sandbox.files.remove).toHaveBeenCalledWith(fake.writes[0], expect.anything());
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

  it("stages nothing and runs the command directly when there is no caller env", async () => {
    const fake = fakeSandbox();

    const result = await run({});

    expect(result.exitCode).toBe(0);
    expect(fake.writes).toEqual([]);
    expect(fake.commandTexts.join("\n")).not.toContain("__paperclip_env_run");
  });
});
