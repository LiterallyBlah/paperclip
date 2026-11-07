import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { testMuseAcpEnvironment } from "./acp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterEnvironmentTestContext } from "@paperclipai/adapter-utils";

const runProcessMock = vi.hoisted(() =>
  vi.fn(
    async (
      _runId: string,
      _target: unknown,
      _command: string,
      args: string[],
      _options?: { env?: Record<string, string>; [key: string]: unknown },
    ) => {
      const isVersion = args.includes("--version");
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: isVersion ? "muse 1.0.0\n" : "hello\n",
        stderr: "",
      };
    },
  ),
);

const ensureResolvableMock = vi.hoisted(() =>
  vi.fn(
    async (
      _command: string,
      _target: unknown,
      _cwd: string,
      _env?: Record<string, string>,
    ) => {},
  ),
);

const prepareRuntimeMock = vi.hoisted(() =>
  vi.fn(async () => ({
    workspaceRemoteDir: "/remote/workspace",
    assetDirs: {},
    restoreWorkspace: async () => {},
  })),
);

vi.mock("@paperclipai/adapter-utils/execution-target", () => ({
  readAdapterExecutionTarget: ({ executionTarget }: { executionTarget?: unknown }) =>
    executionTarget ?? { kind: "local" },
  resolveAdapterExecutionTargetCwd: (_target: unknown, rawCwd?: string, fallback?: string) =>
    rawCwd || fallback || "/workspace",
  ensureAdapterExecutionTargetCommandResolvable: ensureResolvableMock,
  runAdapterExecutionTargetProcess: runProcessMock,
  prepareAdapterExecutionTargetRuntime: prepareRuntimeMock,
}));

import { testEnvironment } from "./test.js";

describe("muse_local testEnvironment remote probe isolation", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    runProcessMock.mockClear();
    ensureResolvableMock.mockClear();
    prepareRuntimeMock.mockClear();
    process.env.SENTINEL_SECRET = "super-secret-sentinel";
    process.env.DATABASE_URL = "postgres://secret-user:secret-pass@localhost:5432/paperclip";
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("does not leak host server process.env into remote sandbox probes", async () => {
    const ctx: AdapterEnvironmentTestContext = {
      companyId: "company-123",
      adapterType: "muse_local",
      config: {
        engine: "cli",
        command: "muse",
        model: "muse-wonder-1.0",
        env: {
          META_API_KEY: "meta-api-key-test",
          CUSTOM_VAR: "custom-val",
        },
      },
      executionTarget: {
        kind: "remote",
        transport: "sandbox",
        providerKey: "e2b",
        leaseId: "lease-1",
        remoteCwd: "/workspace",
      },
    };

    const result = await testEnvironment(ctx);
    expect(result.status).toBe("pass");

    // Check ensureAdapterExecutionTargetCommandResolvable
    expect(ensureResolvableMock).toHaveBeenCalledTimes(1);
    const resolvableEnv = ensureResolvableMock.mock.calls[0][3];
    expect(resolvableEnv?.SENTINEL_SECRET).toBeUndefined();
    expect(resolvableEnv?.DATABASE_URL).toBeUndefined();
    expect(resolvableEnv?.CUSTOM_VAR).toBe("custom-val");

    // Check runAdapterExecutionTargetProcess calls
    expect(runProcessMock).toHaveBeenCalledTimes(2);

    // Call 1: version probe
    const versionCallArgs = runProcessMock.mock.calls[0];
    const versionOptions = versionCallArgs[4];
    expect(versionOptions?.env?.SENTINEL_SECRET).toBeUndefined();
    expect(versionOptions?.env?.DATABASE_URL).toBeUndefined();
    expect(versionOptions?.env?.CUSTOM_VAR).toBe("custom-val");

    // Call 2: hello probe
    const probeCallArgs = runProcessMock.mock.calls[1];
    const probeOptions = probeCallArgs[4];
    expect(probeOptions?.env?.SENTINEL_SECRET).toBeUndefined();
    expect(probeOptions?.env?.DATABASE_URL).toBeUndefined();
    expect(probeOptions?.env?.CUSTOM_VAR).toBe("custom-val");
  });
  it.each([true, false, undefined])("checks subscription state %s in both readiness lanes", async (subsActive) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "muse-readiness-"));
    const authPath = path.join(root, "auth.json");
    await fs.writeFile(authPath, JSON.stringify({ providers: { meta: { mechanism: "oauth", access_token: "synthetic-only", subs_active: subsActive } } }));
    try {
      const ctx = {
        companyId: "fixture", adapterType: "muse_local",
        config: { engine: "cli", cwd: root, env: { MUSE_AUTH_PATH: authPath } },
        executionTarget: { kind: "remote", transport: "sandbox", remoteCwd: root },
      } as AdapterEnvironmentTestContext;
      const cli = await testEnvironment(ctx);
      expect(cli.checks.some(check => check.code === "muse_auth_configured")).toBe(subsActive === true);
      expect(runProcessMock.mock.calls.some(call => call[3].includes("exec"))).toBe(subsActive === true);
      const acp = await testMuseAcpEnvironment(ctx);
      expect(acp.checks.some(check => check.code === "muse_acp_credentials_detected")).toBe(subsActive === true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

});
