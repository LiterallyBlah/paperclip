// BLA-3978: caller env (the agent's PAPERCLIP_API_KEY and other secrets) must
// never appear in the argv handed to Modal's `sandbox.exec` (including the
// `sh -c` script) and must still reach the target process env. The fake SDK
// below runs every exec argv locally, mapping the sandbox's /tmp staging paths
// into a private test directory.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSandboxesFromId = vi.hoisted(() => vi.fn());

vi.mock("modal", () => ({
  ModalClient: class MockModalClient {
    apps = { fromName: vi.fn() };
    images = { fromRegistry: vi.fn() };
    sandboxes = { create: vi.fn(), fromId: mockSandboxesFromId };
    close = vi.fn();
    constructor(_params?: unknown) {}
  },
  NotFoundError: class extends Error {},
  TimeoutError: class extends Error {},
  SandboxTimeoutError: class extends Error {},
}));

import plugin from "./plugin.js";

const DUMMY_API_KEY = "pcp-dummy-api-key-bla3978-modal";
const DUMMY_OTHER = "dummy-other-secret-bla3978-modal";

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

function createRealShellSandbox(options: { failOpen?: (remotePath: string) => boolean } = {}) {
  const toLocal = (text: string) => text.split("/tmp/paperclip-").join(`${root}/paperclip-`);
  const execArgvs: string[][] = [];
  const execParams: unknown[] = [];
  const sandbox = {
    sandboxId: "sb-env",
    exec: vi.fn(async (argv: string[], params?: unknown) => {
      execArgvs.push(argv);
      execParams.push(params);
      const [file, ...rest] = argv.map(toLocal);
      const res = spawnSync(file!, rest, {
        cwd: root,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, PROBE_DIR: root },
        encoding: "utf8",
      });
      return {
        stdout: { readText: async () => res.stdout },
        stderr: { readText: async () => res.stderr },
        wait: async () => res.status ?? 1,
      };
    }),
    open: vi.fn(async (remotePath: string, _mode: string) => {
      if (options.failOpen?.(remotePath)) throw new Error("open failed");
      const local = toLocal(remotePath);
      return {
        write: async (data: Uint8Array) => {
          fs.writeFileSync(local, data);
        },
        flush: async () => undefined,
        close: async () => undefined,
      };
    }),
  };
  return { sandbox, execArgvs, execParams };
}

async function execute(env: Record<string, string>, extra: { stdin?: string } = {}) {
  return await plugin.definition.onEnvironmentExecute?.({
    driverKey: "modal",
    companyId: "c-1",
    environmentId: "e-1",
    config: {
      appName: "paperclip-app",
      image: "node:20",
      sandboxTimeoutMs: 3_600_000,
      execTimeoutMs: 30_000,
      reuseLease: false,
      tokenId: "config-id",
      tokenSecret: "config-secret",
    },
    lease: { providerLeaseId: "sb-env", metadata: {} },
    command: process.execPath,
    args: ["-e", PROBE],
    cwd: root,
    env,
    stdin: extra.stdin,
    timeoutMs: 30_000,
  });
}

function expectNoSecretIn(values: unknown[], secrets: string[]) {
  const haystack = JSON.stringify(values);
  for (const secret of secrets) expect(haystack).not.toContain(secret);
}

function stagedLeftovers() {
  return fs.readdirSync(root).filter((n) => n.startsWith("paperclip-"));
}

describe("Modal execute keeps env secrets out of exec argv (BLA-3978)", () => {
  beforeEach(() => {
    mockSandboxesFromId.mockReset();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "modal-env-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("delivers PAPERCLIP_API_KEY and another secret without putting them in the exec argv", async () => {
    const fake = createRealShellSandbox();
    mockSandboxesFromId.mockResolvedValue(fake.sandbox);

    const result = await execute({ PAPERCLIP_API_KEY: DUMMY_API_KEY, OTHER_SECRET: DUMMY_OTHER });

    expect(result?.exitCode).toBe(0);
    const out = JSON.parse(result!.stdout);
    expect(out.key).toBe(DUMMY_API_KEY);
    expect(out.other).toBe(DUMMY_OTHER);
    expect(out.leftovers).toEqual([]);
    expectNoSecretIn(out.argv, [DUMMY_API_KEY, DUMMY_OTHER]);
    expectNoSecretIn(fake.execArgvs, [DUMMY_API_KEY, DUMMY_OTHER]);
    expectNoSecretIn(fake.execParams, [DUMMY_API_KEY, DUMMY_OTHER]);
    expect(fake.execArgvs.flat().join("\n")).not.toMatch(/\benv [A-Z_]+=/);
    expect(stagedLeftovers()).toEqual([]);
  });

  it("preserves quoted and multiline values exactly", async () => {
    const fake = createRealShellSandbox();
    mockSandboxesFromId.mockResolvedValue(fake.sandbox);
    const multi = `line one\nit's "quoted" $HOME \`not run\` \\ back\n\ttab'`;

    const result = await execute({ PAPERCLIP_API_KEY: DUMMY_API_KEY, MULTI: multi });

    const out = JSON.parse(result!.stdout);
    expect(out.multi).toBe(multi);
    expect(out.key).toBe(DUMMY_API_KEY);
    expectNoSecretIn(fake.execArgvs, [DUMMY_API_KEY, "not run"]);
  });

  it("delivers stdin up to EOF alongside staged env", async () => {
    const fake = createRealShellSandbox();
    mockSandboxesFromId.mockResolvedValue(fake.sandbox);

    const result = await execute(
      { PAPERCLIP_API_KEY: DUMMY_API_KEY, OTHER_SECRET: DUMMY_OTHER, PROBE_READ_STDIN: "1" },
      { stdin: "first\nsecond line\n" },
    );

    const out = JSON.parse(result!.stdout);
    expect(out.stdin).toBe("first\nsecond line\n");
    expect(out.key).toBe(DUMMY_API_KEY);
    expectNoSecretIn(fake.execArgvs, [DUMMY_API_KEY, DUMMY_OTHER]);
    expect(stagedLeftovers()).toEqual([]);
  });

  it("returns the command's exit code and still removes staged files on failure", async () => {
    const fake = createRealShellSandbox();
    mockSandboxesFromId.mockResolvedValue(fake.sandbox);

    const result = await execute({ PAPERCLIP_API_KEY: DUMMY_API_KEY, PROBE_EXIT: "7" }, { stdin: "x" });

    expect(result?.exitCode).toBe(7);
    expect(result?.timedOut).toBe(false);
    expectNoSecretIn(fake.execArgvs, [DUMMY_API_KEY]);
    expect(stagedLeftovers()).toEqual([]);
  });

  it("removes the staged env file when staging stdin fails", async () => {
    const fake = createRealShellSandbox({ failOpen: (p) => p.includes("paperclip-stdin-") });
    mockSandboxesFromId.mockResolvedValue(fake.sandbox);

    await expect(execute({ PAPERCLIP_API_KEY: DUMMY_API_KEY }, { stdin: "x" })).rejects.toThrow("open failed");
    expectNoSecretIn(fake.execArgvs, [DUMMY_API_KEY]);
    expect(fake.execArgvs.some((argv) => /rm -f '\/tmp\/paperclip-env-/.test(argv.join(" ")))).toBe(true);
    expect(stagedLeftovers()).toEqual([]);
  });
});
