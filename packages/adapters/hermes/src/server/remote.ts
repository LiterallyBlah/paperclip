import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import {
  readAdapterExecutionTarget,
  runAdapterExecutionTargetShellCommand,
} from "@paperclipai/adapter-utils/execution-target";
import { syncDirectoryToSsh, shellQuote } from "@paperclipai/adapter-utils/ssh";

export function hermesExecutionTarget(ctx: { executionTarget?: AdapterExecutionTarget | null; remoteExecution?: unknown }, config: Record<string, unknown>) {
  const target = readAdapterExecutionTarget({ executionTarget: ctx.executionTarget, legacyRemoteExecution: ctx.remoteExecution ?? config.remoteExecution });
  if (target?.kind === "remote" && target.transport !== "ssh") throw new Error("Hermes supports local and SSH execution only");
  return target;
}

// Never import the controller's database, signing keys, HOME or temp paths.
// Remote profiles own provider authentication; configured env is explicit.
export function hermesRemoteEnv(config: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries((config.env ?? {}) as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

export async function remoteHermesShell(target: AdapterExecutionTarget, command: string, env: Record<string, string> = {}) {
  const result = await runAdapterExecutionTargetShellCommand("hermes-materialize", target, command, {
    cwd: process.cwd(), env, timeoutSec: 30, graceSec: 5,
  });
  if (result.exitCode !== 0 || result.timedOut) throw new Error("Hermes remote materialisation/probe failed");
  return result.stdout;
}

export async function materializeHermesInstructions(target: AdapterExecutionTarget, localPath: string, runId: string) {
  if (target.kind !== "remote" || target.transport !== "ssh") throw new Error("Expected SSH target");
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("Invalid Hermes run ID");
  // Managed bundles include sibling files referenced by the entrypoint.
  const remoteDir = path.posix.join(target.remoteCwd, ".paperclip-runtime", "hermes", "instructions", runId);
  await fs.access(localPath);
  try {
    await syncDirectoryToSsh({ spec: target.spec, localDir: path.dirname(localPath), remoteDir, followSymlinks: true });
  } catch (error) {
    await remoteHermesShell(target, `rm -rf -- ${shellQuote(remoteDir)}`).catch(() => {});
    throw error;
  }
  return {
    path: path.posix.join(remoteDir, path.basename(localPath)),
    cleanup: () => remoteHermesShell(target, `rm -rf -- ${shellQuote(remoteDir)}`).then(() => {}),
  };
}

async function remoteHermesHome(target: AdapterExecutionTarget, env: Record<string, string>): Promise<string> {
  const home = env.HERMES_HOME || (env.HOME ? path.posix.join(env.HOME, ".hermes") :
    (await remoteHermesShell(target, 'printf %s "$HOME/.hermes"')).trim());
  if (!path.posix.isAbsolute(home)) throw new Error("Remote Hermes home must be absolute");
  return home;
}

export async function removeHermesManagedSkill(target: AdapterExecutionTarget, env: Record<string, string>, name: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("Invalid Hermes skill runtime name");
  const home = await remoteHermesHome(target, env);
  const staged = path.posix.join(home, ".paperclip", "skills", name);
  const link = path.posix.join(home, "skills", name);
  await remoteHermesShell(target, `if [ -L ${shellQuote(link)} ] && [ "$(readlink ${shellQuote(link)})" = ${shellQuote(staged)} ]; then rm -- ${shellQuote(link)} && rm -rf -- ${shellQuote(staged)}; fi`, env);
}

export async function materializeHermesSkill(target: AdapterExecutionTarget, env: Record<string, string>, source: string, name: string) {
  if (target.kind !== "remote" || target.transport !== "ssh") throw new Error("Expected SSH target");
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("Invalid Hermes skill runtime name");
  const home = await remoteHermesHome(target, env);
  const staged = path.posix.join(home, ".paperclip", "skills", name);
  const link = path.posix.join(home, "skills", name);
  // Refuse to replace an operator-owned skill or follow an unexpected link.
  await remoteHermesShell(target,
    `mkdir -p ${shellQuote(path.posix.dirname(link))}; if [ -e ${shellQuote(link)} ] || [ -L ${shellQuote(link)} ]; then [ -L ${shellQuote(link)} ] && [ "$(readlink ${shellQuote(link)})" = ${shellQuote(staged)} ]; fi`, env);
  // Replace only our own backing directory so removed skill files do not linger.
  await remoteHermesShell(target, `rm -rf -- ${shellQuote(staged)}`, env);
  await syncDirectoryToSsh({ spec: target.spec, localDir: source, remoteDir: staged, followSymlinks: true });
  await remoteHermesShell(target, `ln -sfn ${shellQuote(staged)} ${shellQuote(link)}`, env);
}
