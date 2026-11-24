// BLA-3999: caller env (the agent's PAPERCLIP_API_KEY and other secrets) must
// never appear in the command text handed to CreateOS (the process `args`, which
// the provider may log) or in any argv, and must still reach the target process
// env. The fake API below runs the exact process `cmd`/`args` locally, mapping
// the sandbox's /tmp staging paths into a private test directory. Only the
// file-upload body may hold a value: that is the file channel itself.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreateosClient } from "./client.js";
import { execute } from "./execute.js";

vi.mock("./request-pacer.js", () => ({ waitForRequest: vi.fn().mockResolvedValue(undefined) }));

const DUMMY_API_KEY = "pcp-dummy-api-key-bla3999-createos";
const DUMMY_OTHER = "dummy-other-secret-bla3999-createos";

// Prints env, argv, stdin and any leftover staged env files as JSON.
const PROBE = [
  "const fs=require('fs');",
  "const dir=process.env.PROBE_DIR;",
  "const stdin=process.env.PROBE_READ_STDIN?fs.readFileSync(0,'utf8'):null;",
  "const leftovers=fs.readdirSync(dir).filter((n)=>n.startsWith('paperclip-env-'));",
  "process.stdout.write(JSON.stringify({key:process.env.PAPERCLIP_API_KEY??null,other:process.env.OTHER_SECRET??null,",
  "multi:process.env.MULTI??null,uid:process.env.UID??null,profileOnly:process.env.PROFILE_ONLY??null,",
  "aliases:Object.keys(process.env).filter((k)=>k.startsWith('__paperclip_env')),",
  "argv:process.argv,stdin,leftovers}));",
  "process.exit(Number(process.env.PROBE_EXIT??0));",
].join("");

const config = { apiUrl: "https://createos.example.test", apiKey: "test-secret", shape: "test-shape", rootfs: null, region: null, timeoutMs: 30_000, reuseLease: false };
const success = (data: unknown = {}) => Response.json({ status: "success", data });
const failure = (status: number) => Response.json({ status: "fail", data: "x" }, { status });

let root: string;

// `binSh` emulates an image whose /bin/sh is another shell (for example bash).
function fakeCreateos(options: { binSh?: string; failUploadOf?: "env" | "stdin" } = {}) {
  const toLocal = (remote: string) => remote.replace(/^\/tmp\//, `${root}/`);
  // Everything sent to CreateOS except upload bodies: URLs, process and exec bodies.
  const commandTexts: string[] = [];
  const uploads: string[] = [];
  let result: { status: number; stdout: string; stderr: string } | null = null;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    const parsed = new URL(String(url));
    const method = init.method ?? "GET";
    const raw = typeof init.body === "string" ? init.body : "";
    commandTexts.push(`${method} ${parsed.pathname}${parsed.search}`);
    if (parsed.pathname.endsWith("/files") && method === "PUT") {
      const remote = parsed.searchParams.get("path")!;
      uploads.push(remote);
      if (options.failUploadOf && remote.includes(`paperclip-${options.failUploadOf}-`)) return failure(503);
      fs.writeFileSync(toLocal(remote), raw);
      return success();
    }
    commandTexts.push(raw);
    const body = raw ? JSON.parse(raw) : {};
    if (parsed.pathname.endsWith("/processes") && method === "POST") {
      let args = (body.args as string[]).map((arg) => arg.replace(/'\/tmp\/paperclip-/g, () => `'${root}/paperclip-`));
      if (options.binSh) args = args.map((arg) => arg.replace("exec /bin/sh -c ", () => `exec ${options.binSh} -c `));
      const res = spawnSync(body.cmd, args, {
        cwd: root,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, PROBE_DIR: root },
        encoding: "utf8",
      });
      result = { status: res.status ?? 1, stdout: res.stdout, stderr: res.stderr };
      return success({ process_id: "proc_env" });
    }
    if (parsed.pathname.endsWith("/stdin/close")) return success();
    if (parsed.pathname.endsWith("/connect")) {
      const frames: unknown[] = [];
      let seq = 0;
      for (const stream of ["stdout", "stderr"] as const) {
        if (result![stream]) frames.push({ type: "data", seq: ++seq, stream, data_base64: Buffer.from(result![stream]).toString("base64") });
      }
      frames.push({ type: "exit", exit_code: result!.status });
      return new Response(frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n");
    }
    if (parsed.pathname.endsWith("/exec") && method === "POST") {
      spawnSync(body.cmd, (body.args as string[]).map((arg) => (arg.startsWith("/tmp/") ? toLocal(arg) : arg)));
      return success({ result: { exit_code: 0, stdout: "", stderr: "" } });
    }
    throw new Error(`Unhandled fixture request ${method} ${parsed.pathname}`);
  }));
  return { commandTexts, uploads };
}

async function run(env: Record<string, string>, extra: { stdin?: string } = {}) {
  return await execute(
    new CreateosClient(config),
    {
      driverKey: "createos",
      companyId: "company-a",
      environmentId: "env-a",
      config,
      lease: { providerLeaseId: "sb_env" },
      command: process.execPath,
      args: ["-e", PROBE],
      cwd: root,
      env,
      stdin: extra.stdin,
      timeoutMs: 30_000,
    },
    AbortSignal.timeout(30_000),
  );
}

function expectNoSecretIn(texts: unknown[], secrets: string[]) {
  const haystack = JSON.stringify(texts);
  for (const secret of secrets) expect(haystack).not.toContain(secret);
}

const staged = () => fs.readdirSync(root).filter((n) => n.startsWith("paperclip-"));

describe("CreateOS execute keeps env secrets out of command text and argv (BLA-3999)", () => {
  beforeEach(() => {
    vi.stubEnv("CREATEOS_API_KEY", "");
    root = fs.mkdtempSync(path.join(os.tmpdir(), "createos-env-"));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("delivers PAPERCLIP_API_KEY and another secret without putting them in the process command text", async () => {
    const fake = fakeCreateos();

    const result = await run({ PAPERCLIP_API_KEY: DUMMY_API_KEY, OTHER_SECRET: DUMMY_OTHER });

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.key).toBe(DUMMY_API_KEY);
    expect(out.other).toBe(DUMMY_OTHER);
    expect(out.aliases).toEqual([]);
    // Removed before exec, not only in cleanup.
    expect(out.leftovers).toEqual([]);
    expectNoSecretIn(out.argv, [DUMMY_API_KEY, DUMMY_OTHER]);
    expectNoSecretIn(fake.commandTexts, [DUMMY_API_KEY, DUMMY_OTHER]);
    expect(fake.commandTexts.join("\n")).not.toMatch(/\benv [A-Z_]+=/);
    expect(fake.uploads).toEqual([expect.stringMatching(/^\/tmp\/paperclip-env-/)]);
    expect(staged()).toEqual([]);
  });

  it("preserves quoted and multiline values exactly", async () => {
    const fake = fakeCreateos();
    const multi = "line one\nit's \"quoted\" $HOME `x` \\ end\n\nlast";

    const result = await run({ PAPERCLIP_API_KEY: DUMMY_API_KEY, MULTI: multi });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).multi).toBe(multi);
    expectNoSecretIn(fake.commandTexts, [DUMMY_API_KEY, "line one", "quoted"]);
  });

  it("delivers stdin up to EOF alongside staged env", async () => {
    const fake = fakeCreateos();
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
    fakeCreateos();

    const result = await run({ PAPERCLIP_API_KEY: DUMMY_API_KEY, PROBE_EXIT: "7" }, { stdin: "x" });

    expect(result.exitCode).toBe(7);
    expect(staged()).toEqual([]);
  });

  it("removes the staged env file when staging stdin fails", async () => {
    const fake = fakeCreateos({ failUploadOf: "stdin" });

    await expect(run({ PAPERCLIP_API_KEY: DUMMY_API_KEY }, { stdin: "x" })).rejects.toThrow("HTTP 503");

    expect(fake.uploads).toHaveLength(2);
    expect(staged()).toEqual([]);
    expect(fake.commandTexts.some((text) => text.includes("/processes"))).toBe(false);
  });

  it("keeps caller env over a value and readonly flag set by the login profile", async () => {
    fakeCreateos();
    fs.writeFileSync(
      path.join(root, ".bash_profile"),
      "PAPERCLIP_API_KEY=from-profile; export PAPERCLIP_API_KEY; readonly PAPERCLIP_API_KEY; PROFILE_ONLY=yes; export PROFILE_ONLY\n",
    );

    const result = await run({ PAPERCLIP_API_KEY: DUMMY_API_KEY });

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.key).toBe(DUMMY_API_KEY);
    expect(out.profileOnly).toBe("yes");
  });

  it("keeps a bash-readonly name (UID) when /bin/sh is bash, without values in argv", async () => {
    const fake = fakeCreateos({ binSh: "/bin/bash" });

    const result = await run({ PAPERCLIP_API_KEY: DUMMY_API_KEY, UID: "dummy-uid-bla3999" });

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.uid).toBe("dummy-uid-bla3999");
    expect(out.key).toBe(DUMMY_API_KEY);
    expect(out.aliases).toEqual([]);
    expectNoSecretIn([out.argv, fake.commandTexts], [DUMMY_API_KEY, "dummy-uid-bla3999"]);
  });

  it("stages nothing and runs the command directly when there is no caller env", async () => {
    const fake = fakeCreateos();

    const result = await run({});

    expect(result.exitCode).toBe(0);
    expect(fake.uploads).toEqual([]);
    expect(fake.commandTexts.join("\n")).not.toContain("__paperclip_env_run");
  });
});
