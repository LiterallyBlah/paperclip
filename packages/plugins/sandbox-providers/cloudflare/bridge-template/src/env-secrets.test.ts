// BLA-4139: caller env (the agent's PAPERCLIP_API_KEY and other secrets) must
// never appear in the command string the bridge hands to the Cloudflare
// sandbox `exec`, or in any argv, and must still reach the target process env.
// The fake sandbox runs the exact command string locally through `/bin/sh -c`,
// mapping the sandbox's /tmp staging paths into a private test directory. Only
// the `writeFile` body may hold a value: that is the file channel itself.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/sandbox", () => ({ getSandbox: vi.fn() }));

import { executeInSandbox } from "./exec.js";

const DUMMY_API_KEY = "pcp-dummy-api-key-bla4139-cloudflare";
const DUMMY_OTHER = "dummy-other-secret-bla4139-cloudflare";

const PROBE = [
  "const fs=require('fs');",
  "const dir=process.env.PROBE_DIR;",
  "const stdin=process.env.PROBE_READ_STDIN?fs.readFileSync(0,'utf8'):null;",
  "const leftovers=fs.readdirSync(dir).filter((n)=>n.startsWith('.paperclip-bridge-env-'));",
  "process.stdout.write(JSON.stringify({key:process.env.PAPERCLIP_API_KEY??null,other:process.env.OTHER_SECRET??null,",
  "multi:process.env.MULTI??null,uid:process.env.UID??null,profileOnly:process.env.PROFILE_ONLY??null,",
  "aliases:Object.keys(process.env).filter((k)=>k.startsWith('__paperclip_env')),",
  "argv:process.argv,stdin,leftovers}));",
  "process.exit(Number(process.env.PROBE_EXIT??0));",
].join("");

let root: string;

function fakeSandbox(options: { binSh?: string; failWriteOf?: "env" | "stdin" } = {}) {
  const toLocal = (remote: string) => remote.replace(/^\/tmp\//, `${root}/`);
  const commandTexts: string[] = [];
  const writes: string[] = [];
  const exec = vi.fn(async (command: string, opts?: unknown) => {
    commandTexts.push(command, JSON.stringify(opts ?? null));
    let local = command.replace(/\/tmp\/\.paperclip-bridge-/g, () => `${root}/.paperclip-bridge-`);
    if (options.binSh) local = local.replace(/exec \/bin\/sh -c /g, () => `exec ${options.binSh} -c `);
    const res = spawnSync("/bin/sh", ["-c", local], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, PROBE_DIR: root },
      encoding: "utf8",
    });
    return { exitCode: res.status ?? 1, stdout: res.stdout, stderr: res.stderr };
  });
  const sandbox = {
    getSession: vi.fn().mockResolvedValue({ exec }),
    writeFile: vi.fn(async (remote: string, data: string) => {
      writes.push(remote);
      if (options.failWriteOf && remote.includes(`paperclip-bridge-${options.failWriteOf}-`)) throw new Error("write failed");
      fs.writeFileSync(toLocal(remote), data);
    }),
    deleteFile: vi.fn(async (remote: string) => {
      fs.rmSync(toLocal(remote), { force: true });
    }),
  };
  return { sandbox, exec, commandTexts, writes };
}

async function run(fake: ReturnType<typeof fakeSandbox>, env: Record<string, string>, extra: { stdin?: string } = {}) {
  return await executeInSandbox({
    sandbox: fake.sandbox as never,
    command: process.execPath,
    args: ["-e", PROBE],
    cwd: root,
    env,
    stdin: extra.stdin,
    sessionStrategy: "named",
    sessionId: "paperclip",
    timeoutMs: 30_000,
  });
}

function expectNoSecretIn(texts: unknown[], secrets: string[]) {
  const haystack = JSON.stringify(texts);
  for (const secret of secrets) expect(haystack).not.toContain(secret);
}

const staged = () => fs.readdirSync(root).filter((n) => n.startsWith(".paperclip-bridge-"));

describe("Cloudflare bridge exec keeps env secrets out of the command string and argv (BLA-4139)", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-bridge-env-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("delivers PAPERCLIP_API_KEY and another secret without putting them in the exec command", async () => {
    const fake = fakeSandbox();

    const result = await run(fake, { PAPERCLIP_API_KEY: DUMMY_API_KEY, OTHER_SECRET: DUMMY_OTHER });

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.key).toBe(DUMMY_API_KEY);
    expect(out.other).toBe(DUMMY_OTHER);
    expect(out.aliases).toEqual([]);
    expect(out.leftovers).toEqual([]);
    expectNoSecretIn(out.argv, [DUMMY_API_KEY, DUMMY_OTHER]);
    expectNoSecretIn(fake.commandTexts, [DUMMY_API_KEY, DUMMY_OTHER]);
    expect(fake.commandTexts.join("\n")).not.toMatch(/\benv [A-Z_]+=/);
    expect(fake.writes).toEqual([expect.stringMatching(/^\/tmp\/\.paperclip-bridge-env-/)]);
    expect(staged()).toEqual([]);
  });

  it("preserves quoted and multiline values exactly", async () => {
    const fake = fakeSandbox();
    const multi = "line one\nit's \"quoted\" $HOME `x` \\ end\n\nlast";

    const result = await run(fake, { PAPERCLIP_API_KEY: DUMMY_API_KEY, MULTI: multi });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).multi).toBe(multi);
    expectNoSecretIn(fake.commandTexts, [DUMMY_API_KEY, "line one", "quoted"]);
  });

  it("delivers stdin up to EOF alongside staged env", async () => {
    const fake = fakeSandbox();
    const stdin = "first line\nsecond line without newline";

    const result = await run(fake, { PAPERCLIP_API_KEY: DUMMY_API_KEY, PROBE_READ_STDIN: "1" }, { stdin });

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.stdin).toBe(stdin);
    expect(out.key).toBe(DUMMY_API_KEY);
    expectNoSecretIn(fake.commandTexts, [DUMMY_API_KEY]);
    expect(staged()).toEqual([]);
  });

  it("returns the command's exit code and still removes staged files on failure", async () => {
    const fake = fakeSandbox();

    const result = await run(fake, { PAPERCLIP_API_KEY: DUMMY_API_KEY, PROBE_EXIT: "7" }, { stdin: "x" });

    expect(result.exitCode).toBe(7);
    expect(staged()).toEqual([]);
  });

  it("removes the staged env file when staging stdin fails", async () => {
    const fake = fakeSandbox({ failWriteOf: "stdin" });

    await expect(run(fake, { PAPERCLIP_API_KEY: DUMMY_API_KEY }, { stdin: "x" })).rejects.toThrow("write failed");

    expect(fake.writes).toHaveLength(2);
    expect(staged()).toEqual([]);
    expect(fake.exec).not.toHaveBeenCalled();
  });

  it("keeps caller env over a value and readonly flag set by the login profile", async () => {
    const fake = fakeSandbox();
    fs.writeFileSync(
      path.join(root, ".profile"),
      // `sh -lc` sources the profile and then the wrapper sources it again, so
      // guard the readonly assignment (a second one would end the shell).
      "[ -n \"$PROFILE_DONE\" ] || { PROFILE_DONE=1; PAPERCLIP_API_KEY=from-profile; export PAPERCLIP_API_KEY; readonly PAPERCLIP_API_KEY; PROFILE_ONLY=yes; export PROFILE_ONLY; }\n",
    );

    const result = await run(fake, { PAPERCLIP_API_KEY: DUMMY_API_KEY });

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.key).toBe(DUMMY_API_KEY);
    expect(out.profileOnly).toBe("yes");
  });

  it("keeps a bash-readonly name (UID) when /bin/sh is bash, without values in argv", async () => {
    const fake = fakeSandbox({ binSh: "/bin/bash" });

    const result = await run(fake, { PAPERCLIP_API_KEY: DUMMY_API_KEY, UID: "dummy-uid-bla4139" });

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.uid).toBe("dummy-uid-bla4139");
    expect(out.key).toBe(DUMMY_API_KEY);
    expect(out.aliases).toEqual([]);
    expectNoSecretIn([out.argv, fake.commandTexts], [DUMMY_API_KEY, "dummy-uid-bla4139"]);
  });

  it("stages nothing and runs the command directly when there is no caller env", async () => {
    const fake = fakeSandbox();

    const result = await run(fake, {});

    expect(result.exitCode).toBe(0);
    expect(fake.writes).toEqual([]);
    expect(fake.commandTexts.join("\n")).not.toContain("__paperclip_env_run");
  });
});
