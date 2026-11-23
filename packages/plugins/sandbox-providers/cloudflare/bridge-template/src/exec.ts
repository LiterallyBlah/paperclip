import type { Sandbox as CloudflareSandbox } from "@cloudflare/sandbox";
import { buildCallerEnvScript, CALLER_ENV_FILE_EXEC } from "./caller-env.js";
import { shellQuote } from "./helpers.js";
import { isTimeoutError } from "./sandboxes.js";
import { cleanupTimedOutExecution, resolveExecutionTarget, type SessionStrategy } from "./sessions.js";

export interface BridgeExecuteParams {
  sandbox: CloudflareSandbox;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string | null;
  timeoutMs?: number;
  sessionStrategy: SessionStrategy;
  sessionId?: string;
  onOutput?: (stream: "stdout" | "stderr", data: string) => void | Promise<void>;
}

function isValidShellEnvKey(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function randomToken(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (typeof uuid === "string" && uuid.length > 0) return uuid.replace(/[^a-zA-Z0-9-]/g, "");
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Validate caller env and render it as the staged env script, or null when
// there is nothing to send. Caller env carries the agent's PAPERCLIP_API_KEY,
// so it travels only through the sandbox file API, never the command text or
// any argv (BLA-4139).
export function buildBridgeCallerEnvScript(env: Record<string, string> | undefined): string | null {
  const entries = Object.entries(env ?? {});
  for (const [key] of entries) {
    if (!isValidShellEnvKey(key)) {
      throw new Error(`Invalid sandbox environment variable key: ${key}`);
    }
  }
  return buildCallerEnvScript(
    entries.filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

export function buildLoginShellScript(input: {
  command: string;
  args: string[];
  cwd?: string;
  envFile?: string | null;
  stdinFile?: string | null;
}): string {
  const commandParts = [shellQuote(input.command), ...input.args.map(shellQuote)].join(" ");
  const stdinRedirect = input.stdinFile ? ` < ${shellQuote(input.stdinFile)}` : "";
  // Source the common login profiles before exec so the command runs with the
  // interactive-shell PATH. The wrapper sources no `nvm.sh`; the sandbox image
  // supplies node on the PATH. Caller env is applied after the profiles, in a
  // fresh `/bin/sh` that sources none (CALLER_ENV_FILE_EXEC), so it still wins
  // over anything a profile exports or marks readonly. Only the env file path
  // is in the command text; the fresh shell removes the file before exec.
  const lines = [
    'if [ -f /etc/profile ]; then . /etc/profile >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile" >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile" >/dev/null 2>&1 || true; elif [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc" >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.zprofile" ]; then . "$HOME/.zprofile" >/dev/null 2>&1 || true; fi',
  ];
  if (input.cwd) {
    lines.push(`cd ${shellQuote(input.cwd)}`);
  }
  const execLine = input.envFile
    ? `exec /bin/sh -c ${shellQuote(CALLER_ENV_FILE_EXEC)} paperclip-env ${shellQuote(input.envFile)} ${commandParts}${stdinRedirect}`
    : `exec ${commandParts}${stdinRedirect}`;
  lines.push(execLine);
  return lines.join(" && ");
}

function coerceExecuteResult(result: {
  success?: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
}) {
  return {
    exitCode:
      typeof result.exitCode === "number" || result.exitCode === null
        ? result.exitCode
        : result.success === false
          ? 1
          : 0,
    signal: null,
    timedOut: false,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export async function executeInSandbox(params: BridgeExecuteParams) {
  // The @cloudflare/sandbox SDK's exec() takes a single command string and a
  // narrow option set ({ cwd, env, timeout, ... }) — it does not accept `args`
  // or `stdin`. We compose the full shell command ourselves and stage stdin
  // through a temp file in the sandbox when the caller provides one.
  const stdinPayload = typeof params.stdin === "string" && params.stdin.length > 0
    ? params.stdin
    : null;
  const stdinFile = stdinPayload ? `/tmp/.paperclip-bridge-stdin-${randomToken()}` : null;
  // Validate and render caller env before anything is staged.
  const envScript = buildBridgeCallerEnvScript(params.env);
  const envFile = envScript != null ? `/tmp/.paperclip-bridge-env-${randomToken()}` : null;

  try {
    if (envFile && envScript != null) {
      await params.sandbox.writeFile(envFile, envScript, { encoding: "utf8" });
    }
    if (stdinFile && stdinPayload) {
      await params.sandbox.writeFile(stdinFile, stdinPayload, { encoding: "utf8" });
    }
    const target = await resolveExecutionTarget(params.sandbox, {
      sessionStrategy: params.sessionStrategy,
      sessionId: params.sessionId,
      cwd: params.cwd,
      env: params.env,
      timeoutMs: params.timeoutMs,
    });
    const script = buildLoginShellScript({
      command: params.command,
      args: params.args ?? [],
      cwd: params.cwd,
      envFile,
      stdinFile,
    });
    const fullCommand = `sh -lc ${shellQuote(script)}`;
    const result = await target.exec(fullCommand, {
      cwd: "/",
      timeout: params.timeoutMs,
      ...(typeof params.onOutput === "function"
        ? {
            stream: true,
            onOutput: params.onOutput,
          }
        : {}),
    });
    return coerceExecuteResult(result);
  } catch (error) {
    if (isTimeoutError(error)) {
      await cleanupTimedOutExecution(params.sandbox, {
        sessionStrategy: params.sessionStrategy,
        sessionId: params.sessionId,
      });
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        stdout: typeof (error as { stdout?: unknown }).stdout === "string" ? (error as { stdout: string }).stdout : "",
        stderr: `${error instanceof Error ? error.message : String(error)}\n`,
      };
    }
    throw error;
  } finally {
    if (stdinFile) {
      await params.sandbox.deleteFile?.(stdinFile).catch(() => undefined);
    }
    // The fresh shell removes the env file before exec; this covers a failed
    // stdin write, a failed exec or a timeout.
    if (envFile) {
      try {
        await params.sandbox.deleteFile?.(envFile);
      } catch {
        // Best effort, as for the stdin file.
      }
    }
  }
}
