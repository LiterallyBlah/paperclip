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
  "multi:process.env.MULTI??null,uid:process.env.UID??null,ppid:process.env.PPID??null,euid:process.env.EUID??null,profileOnly:process.env.PROFILE_ONLY??null,",
  "aliases:Object.keys(process.env).filter((k)=>k.startsWith('__paperclip_env')),",
  "argv:process.argv,stdin,leftovers}));",
  "process.exit(Number(process.env.PROBE_EXIT??0));",
].join("");

let root: string;

// `binSh` emulates an image whose /bin/sh is another shell (for example bash).
function createRealShellSandbox(shell: { binSh?: string } = {}) {
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
        let localCommand = command.replace(/'\/tmp\/paperclip-/g, () => `'${root}/paperclip-`);
        if (shell.binSh) localCommand = localCommand.replace("exec /bin/sh -c ", () => `exec ${shell.binSh} -c `);
        const res = spawnSync("/bin/bash", ["-c", localCommand], {
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
  it("keeps caller env over a name the login profile marks readonly", async () => {
    fs.writeFileSync(
      path.join(root, ".profile"),
      "export OTHER_SECRET='profile-dummy'\nreadonly OTHER_SECRET\nreadonly PAPERCLIP_API_KEY='profile-key'\nexport PROFILE_ONLY='from-profile'\n",
    );
    const fake = createRealShellSandbox();
    mockConnect.mockResolvedValue(fake.sandbox);

    const result = await execute({ PAPERCLIP_API_KEY: DUMMY_API_KEY, OTHER_SECRET: DUMMY_OTHER });

    expect(result?.exitCode).toBe(0);
    const out = JSON.parse(result!.stdout);
    expect(out.key).toBe(DUMMY_API_KEY);
    expect(out.other).toBe(DUMMY_OTHER);
    expect(out.profileOnly).toBe("from-profile");
    expect(out.leftovers).toEqual([]);
    expectNoSecretIn(fake.commandTexts, [DUMMY_API_KEY, DUMMY_OTHER]);
    expect(fs.readdirSync(root).filter((n) => n.startsWith("paperclip-"))).toEqual([]);
  });

  it("keeps caller env for a name that is a bash builtin readonly variable (UID)", async () => {
    const fake = createRealShellSandbox();
    mockConnect.mockResolvedValue(fake.sandbox);

    const result = await execute({ PAPERCLIP_API_KEY: DUMMY_API_KEY, UID: "dummy-uid-bla3978" });

    expect(result?.exitCode).toBe(0);
    const out = JSON.parse(result!.stdout);
    expect(out.uid).toBe("dummy-uid-bla3978");
    expect(out.key).toBe(DUMMY_API_KEY);
    expectNoSecretIn(fake.commandTexts, [DUMMY_API_KEY]);
    expect(fs.readdirSync(root).filter((n) => n.startsWith("paperclip-"))).toEqual([]);
  });

  // An image whose /bin/sh is bash: bash owns readonly UID even as `sh --posix`,
  // so the fresh shell cannot assign it and an execve helper applies the env.
  describe("when /bin/sh is bash", () => {
    const BASH_AS_SH = "/bin/bash --posix";
    const multi = `line one\nit's "quoted" $HOME \`not run\` \\ back\n\ttab'`;
    const commandOn = (bin: string) => spawnSync("/bin/sh", ["-c", `command -v ${bin}`], { encoding: "utf8" }).stdout.trim();
    // Limit the sandbox PATH to `rm` plus the given helpers. Set from ~/.profile,
    // which the wrapper sources after /etc/profile (that may reset PATH).
    function onlyHelpers(bins: string[]) {
      const dir = path.join(root, `bin-${bins.join("-") || "none"}`);
      fs.mkdirSync(dir);
      for (const bin of ["rm", ...bins]) fs.symlinkSync(commandOn(bin), path.join(dir, bin));
      fs.appendFileSync(path.join(root, ".profile"), `export PATH='${dir}'\n`);
    }

    // BLA-4033: bash as /bin/sh with no perl or python3. GNU `env -S` applies
    // the refused names; a recording `env` shim proves its argv holds no value.
    function envShimOnly() {
      const dir = path.join(root, "bin-env-shim");
      fs.mkdirSync(dir);
      fs.symlinkSync(commandOn("rm"), path.join(dir, "rm"));
      fs.writeFileSync(
        path.join(dir, "env"),
        `#!${commandOn("bash")}\nprintf '%s\\0' "$@" >>"$PROBE_DIR/env-argv.log"\nexec ${commandOn("env")} "$@"\n`,
        { mode: 0o755 },
      );
      fs.appendFileSync(path.join(root, ".profile"), `export PATH='${dir}'\n`);
    }

    it("keeps bash-refused names (UID, EUID, PPID) without perl or python3, via env -S", async () => {
      fs.writeFileSync(
        path.join(root, ".profile"),
        "export OTHER_SECRET='profile-dummy'\nreadonly OTHER_SECRET\nexport PROFILE_ONLY='from-profile'\n",
      );
      envShimOnly();
      const fake = createRealShellSandbox({ binSh: BASH_AS_SH });
      mockConnect.mockResolvedValue(fake.sandbox);

      const result = await execute({
        PAPERCLIP_API_KEY: DUMMY_API_KEY,
        OTHER_SECRET: DUMMY_OTHER,
        UID: "dummy-uid-bla4033",
        EUID: "dummy-euid-bla4033",
        PPID: "dummy-ppid-bla4033",
        MULTI: multi,
      });

      expect(result?.exitCode).toBe(0);
      const out = JSON.parse(result!.stdout);
      expect(out.key).toBe(DUMMY_API_KEY);
      expect(out.other).toBe(DUMMY_OTHER);
      expect(out.uid).toBe("dummy-uid-bla4033");
      expect(out.euid).toBe("dummy-euid-bla4033");
      expect(out.ppid).toBe("dummy-ppid-bla4033");
      expect(out.multi).toBe(multi);
      expect(out.profileOnly).toBe("from-profile");
      expect(out.aliases).toEqual([]);
      expect(out.leftovers).toEqual([]);
      const envArgv = fs.readFileSync(path.join(root, "env-argv.log"), "utf8");
      expect(envArgv).toContain("UID=${__paperclip_env_");
      const values = [DUMMY_API_KEY, DUMMY_OTHER, "dummy-uid-bla4033", "dummy-euid-bla4033", "dummy-ppid-bla4033", "not run"];
      expectNoSecretIn([envArgv], values);
      expectNoSecretIn(out.argv, values);
      expectNoSecretIn(fake.commandTexts, values);
      expect(fs.readdirSync(root).filter((n) => n.startsWith("paperclip-"))).toEqual([]);
    });

    it("keeps stdin to EOF and the exit code on the env -S path", async () => {
      envShimOnly();
      const fake = createRealShellSandbox({ binSh: BASH_AS_SH });
      mockConnect.mockResolvedValue(fake.sandbox);

      const result = await execute(
        { PAPERCLIP_API_KEY: DUMMY_API_KEY, UID: "dummy-uid-bla4033", PROBE_READ_STDIN: "1", PROBE_EXIT: "7" },
        { stdin: "first\nsecond line\n" },
      );

      expect(result?.exitCode).toBe(7);
      const out = JSON.parse(result!.stdout);
      expect(out.key).toBe(DUMMY_API_KEY);
      expect(out.uid).toBe("dummy-uid-bla4033");
      expect(out.stdin).toBe("first\nsecond line\n");
      expect(out.aliases).toEqual([]);
      expectNoSecretIn([fs.readFileSync(path.join(root, "env-argv.log"), "utf8")], [DUMMY_API_KEY, "dummy-uid-bla4033"]);
      expectNoSecretIn(fake.commandTexts, [DUMMY_API_KEY]);
      expect(fs.readdirSync(root).filter((n) => n.startsWith("paperclip-"))).toEqual([]);
    });

    it("keeps UID, readonly-profile names and multiline values (perl helper)", async () => {
      fs.writeFileSync(
        path.join(root, ".profile"),
        "export OTHER_SECRET='profile-dummy'\nreadonly OTHER_SECRET\nexport PROFILE_ONLY='from-profile'\n",
      );
      onlyHelpers(["perl"]);
      const fake = createRealShellSandbox({ binSh: BASH_AS_SH });
      mockConnect.mockResolvedValue(fake.sandbox);

      const result = await execute({
        PAPERCLIP_API_KEY: DUMMY_API_KEY,
        OTHER_SECRET: DUMMY_OTHER,
        UID: "dummy-uid-bla3978",
        MULTI: multi,
      });

      expect(result?.exitCode).toBe(0);
      const out = JSON.parse(result!.stdout);
      expect(out.key).toBe(DUMMY_API_KEY);
      expect(out.other).toBe(DUMMY_OTHER);
      expect(out.uid).toBe("dummy-uid-bla3978");
      expect(out.multi).toBe(multi);
      expect(out.profileOnly).toBe("from-profile");
      expect(out.aliases).toEqual([]);
      expect(out.leftovers).toEqual([]);
      expectNoSecretIn(out.argv, [DUMMY_API_KEY, DUMMY_OTHER]);
      expectNoSecretIn(fake.commandTexts, [DUMMY_API_KEY, DUMMY_OTHER, "not run"]);
      expect(fs.readdirSync(root).filter((n) => n.startsWith("paperclip-"))).toEqual([]);
    });

    it("falls back to python3 and keeps stdin and the exit code", async () => {
      onlyHelpers(["python3"]);
      const fake = createRealShellSandbox({ binSh: BASH_AS_SH });
      mockConnect.mockResolvedValue(fake.sandbox);

      const result = await execute(
        { PAPERCLIP_API_KEY: DUMMY_API_KEY, UID: "dummy-uid-bla3978", PROBE_READ_STDIN: "1", PROBE_EXIT: "7" },
        { stdin: "first\nsecond line\n" },
      );

      expect(result?.exitCode).toBe(7);
      const out = JSON.parse(result!.stdout);
      expect(out.key).toBe(DUMMY_API_KEY);
      expect(out.uid).toBe("dummy-uid-bla3978");
      expect(out.stdin).toBe("first\nsecond line\n");
      expect(out.aliases).toEqual([]);
      expectNoSecretIn(fake.commandTexts, [DUMMY_API_KEY]);
      expect(fs.readdirSync(root).filter((n) => n.startsWith("paperclip-"))).toEqual([]);
    });

    it("fails loudly without leaking values when no env -S or interpreter helper exists", async () => {
      onlyHelpers([]);
      const fake = createRealShellSandbox({ binSh: BASH_AS_SH });
      mockConnect.mockResolvedValue(fake.sandbox);

      const result = await execute({ PAPERCLIP_API_KEY: DUMMY_API_KEY, UID: "dummy-uid-bla3978" });

      expect(result?.exitCode).toBe(126);
      expect(result?.stderr).toContain("no env -S, perl or python3 is available");
      expectNoSecretIn([result?.stdout, result?.stderr], [DUMMY_API_KEY, "dummy-uid-bla3978"]);
      expectNoSecretIn(fake.commandTexts, [DUMMY_API_KEY]);
      expect(fs.readdirSync(root).filter((n) => n.startsWith("paperclip-"))).toEqual([]);
    });
  });
});
