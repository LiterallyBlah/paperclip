import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { buildSshEnvLabFixtureConfig, startSshEnvLabFixture, stopSshEnvLabFixture, type SshEnvLabFixtureState } from "@paperclipai/adapter-utils/ssh";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import { materializeHermesSkill, removeHermesManagedSkill } from "./remote.js";

describe("Hermes native SSH (no provider/model calls)", () => {
  let root: string, state: SshEnvLabFixtureState, ctx: AdapterExecutionContext;
  let spawnedArgv = "";
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-native-ssh-"));
    state = await startSshEnvLabFixture({ statePath: path.join(root, "state.json") });
    const spec = { ...await buildSshEnvLabFixtureConfig(state), remoteCwd: state.workspaceDir };
    const profile = path.join(root, "remote-profile"), bundle = path.join(root, "bundle"), source = path.join(root, "skill-source");
    for (const p of [profile, bundle, source]) await fs.mkdir(p, { recursive: true });
    await fs.writeFile(path.join(bundle, "AGENTS.md"), "Remote managed instructions: read sibling.md");
    await fs.writeFile(path.join(bundle, "sibling.md"), "sibling bundle content");
    await fs.writeFile(path.join(source, "SKILL.md"), "# Runtime skill\n");
    const fake = path.join(root, "fake-hermes");
    await fs.writeFile(fake, `#!/usr/bin/python3
import os,sys,json
if '--version' in sys.argv:
 print('fixture-hermes 1'); sys.exit(0)
keys = ['HOME','HERMES_HOME','PAPERCLIP_API_KEY','PAPERCLIP_RUN_ID','PAPERCLIP_TASK_ID','HERMES_EPHEMERAL_SYSTEM_PROMPT','DATABASE_URL','PAPERCLIP_AGENT_JWT_SECRET','TMPDIR','PAPERCLIP_RUNTIME_TOOLS_TOKEN','PAPERCLIP_RUNTIME_TOOLS_AVAILABLE','HERMES_PROFILE']
assert open(os.path.join(os.getcwd(),'.paperclip-runtime/hermes/instructions/hermes-ssh-test/sibling.md')).read() == 'sibling bundle content'
print(json.dumps({'argv':sys.argv[1:],'env':{k:os.getenv(k) for k in keys},'cwd':os.getcwd(),'skill':open(os.path.join(os.environ['HERMES_HOME'],'skills','paperclip','SKILL.md')).read()}))
print('session_id: fixture-session')
`, { mode: 0o700 });
    ctx = {
      runId: "hermes-ssh-test", agent: { id: "agent-test", companyId: "company-test", name: "Oracle" },
      config: { hermesCommand: fake, model: "gpt-6.1-sol", provider: "openai-codex", instructionsFilePath: path.join(bundle, "AGENTS.md"), env: { HOME: root, HERMES_HOME: profile, HERMES_PROFILE: "oracle", HERMES_EPHEMERAL_SYSTEM_PROMPT: "operator overlay" }, paperclipRuntimeSkills: [{ key: "paperclipai/paperclip/paperclip", runtimeName: "paperclip", source }] },
      executionTarget: { kind: "remote", transport: "ssh", spec, remoteCwd: spec.remoteCwd },
      authToken: "Bearer NATIVE_SSH_RUN_JWT_MARKER", context: { taskId: "task-test" },
      runtimeTools: { version: 1, bearerToken: "runtime-tools-marker", mcpEndpoint: "http://127.0.0.1:3100/mcp", expiresAt: "test-expiry", rest: { connectionsSearch: "test-search", connectionRequest: "test-request" }, tools: ["connections_search"], guidance: "runtime guidance" },
      runtime: { sessionParams: { sessionId: "old-session" } }, onLog: vi.fn(async () => {}),
      onSpawn: async ({ pid }: { pid: number }) => {
        if (process.platform === "linux") {
          spawnedArgv = await fs.readFile(`/proc/${pid}/cmdline`, "utf8");
        }
      },
    } as unknown as AdapterExecutionContext;
  }, 30000);
  afterAll(async () => { vi.unstubAllEnvs(); if (state) await stopSshEnvLabFixture(state); if (root) await fs.rm(root, { recursive: true, force: true }); });

  it("executes on target with run JWT, remote profile, resume, system overlay and whole instruction/skill directories", async () => {
    vi.stubEnv("HERMES_PROFILE", "default"); vi.stubEnv("HERMES_HOME", "/controller-default-profile");
    vi.stubEnv("DATABASE_URL", "database-must-stay-local"); vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "signing-must-stay-local");
    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
    if (process.platform === "linux") {
      expect(spawnedArgv).toContain("ssh");
      expect(spawnedArgv).not.toContain("NATIVE_SSH_RUN_JWT_MARKER");
      expect(spawnedArgv).not.toContain("runtime-tools-marker");
      expect(spawnedArgv).not.toContain("operator overlay");
    }
    const data = JSON.parse((result.resultJson as any).result);
    expect(data.env).toMatchObject({ HOME: root, HERMES_HOME: path.join(root, "remote-profile"), HERMES_PROFILE: "oracle", PAPERCLIP_API_KEY: "Bearer NATIVE_SSH_RUN_JWT_MARKER", PAPERCLIP_RUN_ID: ctx.runId, PAPERCLIP_TASK_ID: "task-test", DATABASE_URL: null, PAPERCLIP_AGENT_JWT_SECRET: null, PAPERCLIP_RUNTIME_TOOLS_TOKEN: "runtime-tools-marker", PAPERCLIP_RUNTIME_TOOLS_AVAILABLE: "connections_search" });
    expect(data.env.TMPDIR).not.toBe(process.env.TMPDIR);
    expect(data.env.HERMES_EPHEMERAL_SYSTEM_PROMPT).toContain("operator overlay");
    expect(data.env.HERMES_EPHEMERAL_SYSTEM_PROMPT).toContain("Remote managed instructions");
    expect(data.env.HERMES_EPHEMERAL_SYSTEM_PROMPT).toContain(path.join(state.workspaceDir, ".paperclip-runtime/hermes/instructions/hermes-ssh-test/AGENTS.md"));
    expect(data.argv).toEqual(expect.arrayContaining(["--resume", "old-session", "--provider", "openai-codex", "-m", "gpt-6.1-sol"]));
    expect(data.cwd).toBe(state.workspaceDir); expect(data.skill).toBe("# Runtime skill\n");
    expect(result.sessionParams).toEqual({ sessionId: "fixture-session" });
    await expect(fs.stat(path.join(state.workspaceDir, ".paperclip-runtime/hermes/instructions/hermes-ssh-test"))).rejects.toThrow();
    expect(await fs.readFile(path.join(root, "remote-profile/skills/paperclip/SKILL.md"), "utf8")).toBe("# Runtime skill\n");
  }, 30000);

  it("refuses occupied physical skill directories and never removes them on deselection", async () => {
    const env = ctx.config.env as Record<string, string>;
    const occupied = path.join(env.HERMES_HOME, "skills", "user-skill");
    await fs.mkdir(occupied, { recursive: true });
    await fs.writeFile(path.join(occupied, "SKILL.md"), "user-owned skill");
    await expect(materializeHermesSkill(ctx.executionTarget!, env, path.join(root, "skill-source"), "user-skill")).rejects.toThrow();
    await removeHermesManagedSkill(ctx.executionTarget!, env, "user-skill");
    expect(await fs.readFile(path.join(occupied, "SKILL.md"), "utf8")).toBe("user-owned skill");
  }, 30000);

  it("updates managed skill contents without stale files and removes only its own links", async () => {
    const env = ctx.config.env as Record<string, string>;
    const source = path.join(root, "skill-source");
    await fs.writeFile(path.join(source, "old.txt"), "obsolete");
    await materializeHermesSkill(ctx.executionTarget!, env, source, "managed-test");
    await fs.unlink(path.join(source, "old.txt"));
    await materializeHermesSkill(ctx.executionTarget!, env, source, "managed-test");
    await expect(fs.stat(path.join(env.HERMES_HOME, "skills/managed-test/old.txt"))).rejects.toThrow();
    await removeHermesManagedSkill(ctx.executionTarget!, env, "managed-test");
    await expect(fs.lstat(path.join(env.HERMES_HOME, "skills/managed-test"))).rejects.toThrow();
  }, 30000);

  it("tests the SSH CLI/profile rather than the controller and honestly leaves auth unverified", async () => {
    const result = await testEnvironment({ config: ctx.config, executionTarget: ctx.executionTarget } as any);
    expect(result.status).toBe("warn");
    expect(result.checks.map(c => c.code)).toEqual(["hermes_remote_cli", "hermes_remote_profile", "hermes_remote_auth_unverified"]);
  }, 30000);
});
