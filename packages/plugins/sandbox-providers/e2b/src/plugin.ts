import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  CommandExitError,
  Sandbox,
  SandboxNotFoundError,
  TimeoutError,
} from "e2b";
import { definePlugin } from "@paperclipai/plugin-sdk";
import type {
  PluginEnvironmentAcquireLeaseParams,
  PluginEnvironmentDestroyLeaseParams,
  PluginEnvironmentExecuteParams,
  PluginEnvironmentExecuteResult,
  PluginEnvironmentLease,
  PluginEnvironmentProbeParams,
  PluginEnvironmentProbeResult,
  PluginEnvironmentRealizeWorkspaceParams,
  PluginEnvironmentRealizeWorkspaceResult,
  PluginEnvironmentReleaseLeaseParams,
  PluginEnvironmentResumeLeaseParams,
  PluginEnvironmentValidateConfigParams,
  PluginEnvironmentValidationResult,
} from "@paperclipai/plugin-sdk";

interface E2bDriverConfig {
  template: string;
  apiKey: string | null;
  timeoutMs: number;
  reuseLease: boolean;
}

function parseDriverConfig(raw: Record<string, unknown>): E2bDriverConfig {
  const template = typeof raw.template === "string" && raw.template.trim().length > 0
    ? raw.template.trim()
    : "base";
  const timeoutMs = Number(raw.timeoutMs ?? 3_600_000);
  return {
    template,
    apiKey: typeof raw.apiKey === "string" && raw.apiKey.trim().length > 0 ? raw.apiKey.trim() : null,
    timeoutMs: Number.isFinite(timeoutMs) ? Math.trunc(timeoutMs) : 3_600_000,
    reuseLease: raw.reuseLease === true,
  };
}

function resolveApiKey(config: E2bDriverConfig): string {
  if (config.apiKey) {
    return config.apiKey;
  }
  const envApiKey = process.env.E2B_API_KEY?.trim() ?? "";
  if (!envApiKey) {
    throw new Error("E2B sandbox environments require an API key in config or E2B_API_KEY.");
  }
  return envApiKey;
}

async function createSandbox(config: E2bDriverConfig): Promise<Sandbox> {
  const options = {
    apiKey: resolveApiKey(config),
    timeoutMs: config.timeoutMs,
    metadata: {
      paperclipProvider: "e2b",
    },
  };
  return await Sandbox.create(config.template, options);
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readTimeoutStream(error: TimeoutError, key: "stdout" | "stderr"): string {
  const record = error as unknown as Record<string, unknown>;
  const direct = record[key];
  if (typeof direct === "string" && direct.length > 0) return direct;
  const nested = (record as { result?: Record<string, unknown> }).result?.[key];
  if (typeof nested === "string") return nested;
  return typeof direct === "string" ? direct : "";
}

function buildTimeoutExecuteResult(error: TimeoutError): PluginEnvironmentExecuteResult {
  const stdout = readTimeoutStream(error, "stdout");
  const stderrOutput = readTimeoutStream(error, "stderr");
  const message = error.message.trim();
  const stderr = stderrOutput.length > 0
    ? message.length > 0 && !stderrOutput.includes(message)
      ? `${stderrOutput}${stderrOutput.endsWith("\n") ? "" : "\n"}${message}\n`
      : stderrOutput
    : message.length > 0
      ? `${message}\n`
      : "";
  return {
    exitCode: null,
    timedOut: true,
    stdout,
    stderr,
  };
}

async function ensureSandboxWorkspace(sandbox: Sandbox, remoteCwd: string): Promise<void> {
  await sandbox.commands.run(`mkdir -p ${shellQuote(remoteCwd)}`);
}

async function resolveSandboxWorkingDirectory(sandbox: Sandbox): Promise<string> {
  const result = await sandbox.commands.run("pwd");
  const cwd = result.stdout.trim();
  const remoteCwd = path.posix.join(cwd.length > 0 ? cwd : "/", "paperclip-workspace");
  await ensureSandboxWorkspace(sandbox, remoteCwd);
  return remoteCwd;
}

async function connectSandbox(config: E2bDriverConfig, providerLeaseId: string): Promise<Sandbox> {
  return await Sandbox.connect(providerLeaseId, {
    apiKey: resolveApiKey(config),
    timeoutMs: config.timeoutMs,
  });
}

async function connectForCleanup(config: E2bDriverConfig, providerLeaseId: string): Promise<Sandbox | null> {
  try {
    return await connectSandbox(config, providerLeaseId);
  } catch (error) {
    if (error instanceof SandboxNotFoundError) return null;
    throw error;
  }
}

function leaseMetadata(input: {
  config: E2bDriverConfig;
  sandbox: Sandbox;
  remoteCwd: string;
  resumedLease: boolean;
}) {
  return {
    provider: "e2b",
    shellCommand: "bash",
    template: input.config.template,
    timeoutMs: input.config.timeoutMs,
    reuseLease: input.config.reuseLease,
    sandboxId: input.sandbox.sandboxId,
    sandboxDomain: input.sandbox.sandboxDomain,
    remoteCwd: input.remoteCwd,
    resumedLease: input.resumedLease,
  };
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function isValidShellEnvKey(value: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

// Render caller env as a POSIX `export` script. The script is staged into the
// sandbox through the provider file API and sourced by the wrapper, so no env
// value ever appears in the command text handed to the SDK, in the remote
// shell's argv, or in an `env` helper's argv (BLA-3978). Values keep their
// exact bytes: single-quoting preserves quotes, newlines and `$`.
function buildEnvExportScript(env: Record<string, string> | undefined): string | null {
  const entries = Object.entries(env ?? {});
  for (const [key] of entries) {
    if (!isValidShellEnvKey(key)) {
      throw new Error(`Invalid sandbox environment variable key: ${key}`);
    }
  }
  const lines = entries
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`);
  return lines.length > 0 ? `${lines.join("\n")}\n` : null;
}

// Applies the staged caller env in a fresh `/bin/sh` that has not sourced any
// profile, then execs the target. Profile shells can mark names readonly (or,
// for bash, own builtin readonly names such as UID); assigning caller env
// there would fail, where `exec env K=v` used to override them for the child.
// The fresh shell inherits only the profile's exported values, not its
// readonly attributes, so caller env still wins. `$1` is the env file path; it
// is removed before exec, and only the path is ever in argv (BLA-3978).
const CALLER_ENV_EXEC_SCRIPT = '. "$1" && { rm -f "$1" || true; } && shift && exec "$@"';

// Source the user's login profiles before exec so commands run with the same
// PATH the user sees in an interactive shell. e2b's `sandbox.commands.run`
// otherwise spawns a non-login, non-interactive shell whose PATH does not
// include npm-globals or anything else the template installs via
// .profile/.bashrc — which makes the hello probe fail with
// `exec: <cli>: not found` even when the binary is on disk. The wrapper no
// longer sources `nvm.sh`; the sandbox image supplies `node` on the PATH.
// Caller env is applied from the staged env file after the profiles, in a
// fresh shell (see CALLER_ENV_EXEC_SCRIPT), so it still wins over anything the
// profiles export. Only the file path is in the command text.
function buildLoginShellScript(input: {
  command: string;
  args: string[];
  envPath?: string;
}): string {
  const commandParts = [shellQuote(input.command), ...input.args.map(shellQuote)].join(" ");
  const steps = [
    'if [ -f /etc/profile ]; then . /etc/profile >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile" >/dev/null 2>&1 || true; fi',
    // .bash_profile typically sources .bashrc itself; only source .bashrc
    // directly when no .bash_profile exists to avoid re-running idempotency-
    // sensitive setup (nvm, PATH prepends) twice on templates that wire
    // .bash_profile -> .bashrc.
    'if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile" >/dev/null 2>&1 || true; elif [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc" >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.zprofile" ]; then . "$HOME/.zprofile" >/dev/null 2>&1 || true; fi',
  ];
  steps.push(
    input.envPath
      ? `exec /bin/sh -c ${shellQuote(CALLER_ENV_EXEC_SCRIPT)} paperclip-env ${shellQuote(input.envPath)} ${commandParts}`
      : `exec ${commandParts}`,
  );
  return steps.join(" && ");
}

async function killSandboxBestEffort(sandbox: Sandbox, reason: string): Promise<void> {
  await sandbox.kill().catch((error) => {
    console.warn(`Failed to kill E2B sandbox during ${reason}: ${formatErrorMessage(error)}`);
  });
}

async function releaseSandboxBestEffort(sandbox: Sandbox, reuseLease: boolean): Promise<void> {
  if (!reuseLease) {
    await killSandboxBestEffort(sandbox, "lease release");
    return;
  }

  try {
    await sandbox.pause();
  } catch (error) {
    console.warn(
      `Failed to pause E2B sandbox during lease release: ${formatErrorMessage(error)}. Attempting kill instead.`,
    );
    await killSandboxBestEffort(sandbox, "lease release fallback cleanup");
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("E2B sandbox provider plugin ready");
  },

  async onHealth() {
    return { status: "ok", message: "E2B sandbox provider plugin healthy" };
  },

  async onEnvironmentValidateConfig(
    params: PluginEnvironmentValidateConfigParams,
  ): Promise<PluginEnvironmentValidationResult> {
    const config = parseDriverConfig(params.config);
    const errors: string[] = [];

    if (typeof params.config.template === "string" && params.config.template.trim().length === 0) {
      errors.push("E2B sandbox environments require a template.");
    }
    if (config.timeoutMs < 1 || config.timeoutMs > 86_400_000) {
      errors.push("timeoutMs must be between 1 and 86400000.");
    }

    if (errors.length > 0) {
      return { ok: false, errors };
    }

    return {
      ok: true,
      normalizedConfig: { ...config },
    };
  },

  async onEnvironmentProbe(
    params: PluginEnvironmentProbeParams,
  ): Promise<PluginEnvironmentProbeResult> {
    const config = parseDriverConfig(params.config);
    try {
      const sandbox = await createSandbox(config);
      try {
        await sandbox.setTimeout(config.timeoutMs);
        const remoteCwd = await resolveSandboxWorkingDirectory(sandbox);
        return {
          ok: true,
          summary: `Connected to E2B sandbox template ${config.template}.`,
          metadata: {
            provider: "e2b",
            template: config.template,
            timeoutMs: config.timeoutMs,
            reuseLease: config.reuseLease,
            sandboxId: sandbox.sandboxId,
            sandboxDomain: sandbox.sandboxDomain,
            remoteCwd,
          },
        };
      } finally {
        await sandbox.kill().catch(() => undefined);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        summary: `E2B sandbox probe failed for template ${config.template}.`,
        metadata: {
          provider: "e2b",
          template: config.template,
          timeoutMs: config.timeoutMs,
          reuseLease: config.reuseLease,
          error: message,
        },
      };
    }
  },

  async onEnvironmentAcquireLease(
    params: PluginEnvironmentAcquireLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const config = parseDriverConfig(params.config);
    const sandbox = await createSandbox(config);
    try {
      await sandbox.setTimeout(config.timeoutMs);
      const remoteCwd = await resolveSandboxWorkingDirectory(sandbox);

      return {
        providerLeaseId: sandbox.sandboxId,
        metadata: leaseMetadata({ config, sandbox, remoteCwd, resumedLease: false }),
      };
    } catch (error) {
      await sandbox.kill().catch(() => undefined);
      throw error;
    }
  },

  async onEnvironmentResumeLease(
    params: PluginEnvironmentResumeLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const config = parseDriverConfig(params.config);
    try {
      const sandbox = await connectSandbox(config, params.providerLeaseId);
      try {
        await sandbox.setTimeout(config.timeoutMs);
        const remoteCwd = await resolveSandboxWorkingDirectory(sandbox);

        return {
          providerLeaseId: sandbox.sandboxId,
          metadata: leaseMetadata({ config, sandbox, remoteCwd, resumedLease: true }),
        };
      } catch (error) {
        await sandbox.kill().catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (error instanceof SandboxNotFoundError) {
        return { providerLeaseId: null, metadata: { expired: true } };
      }
      throw error;
    }
  },

  async onEnvironmentReleaseLease(
    params: PluginEnvironmentReleaseLeaseParams,
  ): Promise<void> {
    if (!params.providerLeaseId) return;
    const config = parseDriverConfig(params.config);
    const sandbox = await connectForCleanup(config, params.providerLeaseId);
    if (!sandbox) return;

    await releaseSandboxBestEffort(sandbox, config.reuseLease);
  },

  async onEnvironmentDestroyLease(
    params: PluginEnvironmentDestroyLeaseParams,
  ): Promise<void> {
    if (!params.providerLeaseId) return;
    const config = parseDriverConfig(params.config);
    const sandbox = await connectForCleanup(config, params.providerLeaseId);
    if (!sandbox) return;
    await killSandboxBestEffort(sandbox, "lease destroy");
  },

  async onEnvironmentRealizeWorkspace(
    params: PluginEnvironmentRealizeWorkspaceParams,
  ): Promise<PluginEnvironmentRealizeWorkspaceResult> {
    const config = parseDriverConfig(params.config);
    const remoteCwd =
      typeof params.lease.metadata?.remoteCwd === "string" &&
      params.lease.metadata.remoteCwd.trim().length > 0
        ? params.lease.metadata.remoteCwd.trim()
        : params.workspace.remotePath ?? params.workspace.localPath ?? "/paperclip-workspace";

    if (params.lease.providerLeaseId) {
      const sandbox = await connectSandbox(config, params.lease.providerLeaseId);
      await ensureSandboxWorkspace(sandbox, remoteCwd);
    }

    return {
      cwd: remoteCwd,
      metadata: {
        provider: "e2b",
        remoteCwd,
      },
    };
  },

  async onEnvironmentExecute(
    params: PluginEnvironmentExecuteParams,
  ): Promise<PluginEnvironmentExecuteResult> {
    if (!params.lease.providerLeaseId) {
      return {
        exitCode: 1,
        timedOut: false,
        stdout: "",
        stderr: "No provider lease ID available for execution.",
      };
    }

    const config = parseDriverConfig(params.config);
    const sandbox = await connectSandbox(config, params.lease.providerLeaseId);
    // Refresh the sandbox death clock on every command. E2B's `timeoutMs` is
    // the absolute sandbox lifetime from create/connect; without this, a run
    // longer than `config.timeoutMs` will have its sandbox killed mid-command
    // and the next call throws "Sandbox is probably not running anymore".
    // The refresh is best-effort: the sandbox is already healthy at this
    // point, so a transient API error on setTimeout should not block the
    // command from running. Worst case the existing lifetime stands.
    try {
      await sandbox.setTimeout(config.timeoutMs);
    } catch {
      // ignore — keep going with the existing sandbox lifetime
    }
    const envScript = buildEnvExportScript(params.env);
    const timeoutMs = params.timeoutMs ?? config.timeoutMs;

    // Caller env (which carries the agent's PAPERCLIP_API_KEY) is staged to a
    // private file through the files API, never interpolated into the command.
    let stagedEnvPath: string | null = null;
    // For commands with stdin, stage the payload to a temp file inside the
    // sandbox and shell-redirect it. Streaming stdin via `sendStdin` raced
    // with fast-failing commands (the process exits before the RPC lands),
    // and the previous code awaited a foreground `run` before sending stdin
    // at all, so the data was never delivered. The staged-file approach
    // keeps execution synchronous, avoids the race, and is unaffected by
    // whether the command exits in microseconds or minutes.
    let stagedStdinPath: string | null = null;
    const removeStaged = async () => {
      for (const stagedPath of [stagedEnvPath, stagedStdinPath]) {
        if (stagedPath) await sandbox.files.remove(stagedPath).catch(() => undefined);
      }
    };
    try {
      if (envScript != null) {
        stagedEnvPath = `/tmp/paperclip-env-${randomUUID()}`;
        await sandbox.files.write(stagedEnvPath, envScript);
      }
      if (params.stdin != null) {
        stagedStdinPath = `/tmp/paperclip-stdin-${randomUUID()}`;
        await sandbox.files.write(stagedStdinPath, params.stdin);
      }
    } catch (error) {
      // Best-effort cleanup in case a write partially succeeded; ignore
      // remove failures so the original error is what propagates.
      await removeStaged();
      throw error;
    }

    const baseCommand = buildLoginShellScript({
      command: params.command,
      args: params.args ?? [],
      envPath: stagedEnvPath ?? undefined,
    });
    const command = stagedStdinPath
      ? `${baseCommand} < ${shellQuote(stagedStdinPath)}`
      : baseCommand;

    try {
      // Env is sourced from the staged file after profile sourcing so
      // user-configured env wins over anything profiles export. `envs:` is
      // not used because profiles would override it.
      const result = await sandbox.commands.run(command, {
        cwd: params.cwd,
        timeoutMs,
      }) as Awaited<ReturnType<Sandbox["commands"]["run"]>> & {
        exitCode: number;
        stdout: string;
        stderr: string;
      };
      return {
        exitCode: result.exitCode,
        timedOut: false,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } catch (error) {
      if (error instanceof CommandExitError) {
        return {
          exitCode: error.exitCode,
          timedOut: false,
          stdout: error.stdout,
          stderr: error.stderr,
        };
      }
      if (error instanceof TimeoutError) {
        return buildTimeoutExecuteResult(error);
      }
      throw error;
    } finally {
      await removeStaged();
    }
  },
});

export default plugin;
