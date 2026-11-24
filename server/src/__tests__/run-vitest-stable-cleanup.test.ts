import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { removeTestHome } from "./remove-test-home.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const runner = path.join(repoRoot, "scripts", "run-vitest-stable.mjs");

// A stand-in for `pnpm exec vitest run`: it leaves the tree a native session
// leaves in a worker home (a runtime-context bundle whose directories are
// 0555, see makeDirectoriesReadOnly), records where it ran, then exits with
// the requested outcome or waits to be signalled.
const fakePnpm = `#!/bin/sh
bundle="$TMPDIR/paperclip-vitest-home-x/instances/vt-1/runtime-context-assets/bundles/0123abcd"
mkdir -p "$bundle/skills/assigned"
printf '# skill\\n' > "$bundle/skills/assigned/SKILL.md"
chmod 0444 "$bundle/skills/assigned/SKILL.md"
chmod 0555 "$bundle/skills/assigned" "$bundle/skills" "$bundle"
printf '%s' "$TMPDIR" > "$PV_CLEANUP_MARKER"
case "$PV_CLEANUP_OUTCOME" in
  pass) exit 0 ;;
  fail) exit 1 ;;
  *) exec sleep 30 ;;
esac
`;

const scratch: string[] = [];
const roots: string[] = [];

afterEach(() => {
  // On a runner that leaks its root, still leave nothing behind.
  for (const root of roots.splice(0)) {
    if (fs.existsSync(root)) removeTestHome(root);
  }
  for (const dir of scratch.splice(0)) removeTestHome(dir);
});

function runRunner(outcome: "pass" | "fail" | "signal") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-vitest-stable-cleanup-"));
  scratch.push(dir);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "pnpm"), fakePnpm, { mode: 0o755 });
  const marker = path.join(dir, "tmpdir");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    PV_CLEANUP_MARKER: marker,
    PV_CLEANUP_OUTCOME: outcome,
  };
  delete env.PAPERCLIP_CI_PROFILE;
  delete env.GITHUB_WORKFLOW;
  const child = spawn(process.execPath, [runner, "--mode", "general", "--group", "general-server-native-runner"], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const root = async () => {
    for (let attempt = 0; attempt < 200 && !fs.existsSync(marker); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const recorded = path.dirname(fs.readFileSync(marker, "utf8"));
    roots.push(recorded);
    return recorded;
  };
  return { child, closed, root, output: () => output };
}

function bundleIn(root: string): string {
  return path.join(root, "t", "paperclip-vitest-home-x", "instances", "vt-1", "runtime-context-assets", "bundles", "0123abcd");
}

describe.skipIf(process.platform === "win32")("run-vitest-stable temporary roots", () => {
  it("removes its pv root, read-only bundle included, after a passing invocation", async () => {
    const run = runRunner("pass");
    const result = await run.closed;
    const root = await run.root();
    expect(result.code, run.output()).toBe(0);
    expect(path.basename(root)).toMatch(/^pv-/);
    expect(fs.existsSync(root)).toBe(false);
  });

  it("removes its pv root, read-only bundle included, after a failing invocation", async () => {
    const run = runRunner("fail");
    const result = await run.closed;
    const root = await run.root();
    expect(result.code, run.output()).toBe(1);
    expect(fs.existsSync(root)).toBe(false);
  });

  it("forwards SIGTERM to the child, removes its pv root and exits non-zero", async () => {
    const run = runRunner("signal");
    const root = await run.root();
    expect(fs.existsSync(bundleIn(root))).toBe(true);
    run.child.kill("SIGTERM");
    const result = await run.closed;
    expect(result.code, run.output()).toBe(143);
    expect(fs.existsSync(root)).toBe(false);
  });
});
