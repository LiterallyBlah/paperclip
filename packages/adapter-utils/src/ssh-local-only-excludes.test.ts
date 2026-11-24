import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  prepareWorkspaceForSshExecution,
  pruneSshRunCopies,
  restoreWorkspaceFromSshExecution,
  type SshRemoteExecutionSpec,
} from "./ssh.js";
import { prepareRemoteManagedRuntime } from "./remote-managed-runtime.js";

const execFileAsync = promisify(execFile);

// BLA-4495: SSH workspace sync must never carry `.scratch-*` or `node_modules`
// (any depth), restore must leave the local copies untouched, and old run
// copies under `.paperclip-runtime/runs` are pruned after 48 h.
//
// No sshd is needed: a fake `ssh` on PATH runs the remote command locally, so
// the real tar pipes, find and restore code paths run against a temp "remote".

let root: string;
let savedPath: string | undefined;
let savedHome: string | undefined;

function spec(remoteCwd: string): SshRemoteExecutionSpec {
  return {
    host: "fake-host", port: 22, username: "fixture", remoteCwd,
    privateKey: null, knownHosts: null, strictHostKeyChecking: false,
  } as unknown as SshRemoteExecutionSpec;
}

async function exists(target: string): Promise<boolean> {
  return stat(target).then(() => true, () => false);
}

async function git(cwd: string, args: string[]) {
  await execFileAsync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", ...args], { cwd });
}

async function seedWorkspace(dir: string) {
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, "src", "a.txt"), "normal\n");
  await writeFile(path.join(dir, "README.md"), "readme\n");
  await mkdir(path.join(dir, ".scratch-x", "deep"), { recursive: true });
  await writeFile(path.join(dir, ".scratch-x", "deep", "big.bin"), "scratch\n");
  await mkdir(path.join(dir, "node_modules", "dep"), { recursive: true });
  await writeFile(path.join(dir, "node_modules", "dep", "index.js"), "top\n");
  await mkdir(path.join(dir, "pkg", "node_modules", "m"), { recursive: true });
  await writeFile(path.join(dir, "pkg", "node_modules", "m", "i.js"), "nested\n");
  await writeFile(path.join(dir, "pkg", "keep.ts"), "keep\n");
  await mkdir(path.join(dir, "pkg", ".scratch-y"), { recursive: true });
  await writeFile(path.join(dir, "pkg", ".scratch-y", "n.txt"), "nested scratch\n");
}

async function expectLocalOnlyIntact(dir: string) {
  expect(await readFile(path.join(dir, ".scratch-x", "deep", "big.bin"), "utf8")).toBe("scratch\n");
  expect(await readFile(path.join(dir, "node_modules", "dep", "index.js"), "utf8")).toBe("top\n");
  expect(await readFile(path.join(dir, "pkg", "node_modules", "m", "i.js"), "utf8")).toBe("nested\n");
  expect(await readFile(path.join(dir, "pkg", ".scratch-y", "n.txt"), "utf8")).toBe("nested scratch\n");
}

async function expectUploadedWithoutLocalOnly(remote: string) {
  expect(await readFile(path.join(remote, "src", "a.txt"), "utf8")).toBe("normal\n");
  expect(await readFile(path.join(remote, "pkg", "keep.ts"), "utf8")).toBe("keep\n");
  expect(await exists(path.join(remote, ".scratch-x"))).toBe(false);
  expect(await exists(path.join(remote, "node_modules"))).toBe(false);
  expect(await exists(path.join(remote, "pkg", "node_modules"))).toBe(false);
  expect(await exists(path.join(remote, "pkg", ".scratch-y"))).toBe(false);
}

describe("SSH workspace local-only excludes and run-copy retention (BLA-4495)", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-local-only-"));
    const bin = path.join(root, "bin");
    const home = path.join(root, "home");
    await mkdir(bin, { recursive: true });
    await mkdir(home, { recursive: true });
    // The remote command is always the last argument; run it locally.
    await writeFile(path.join(bin, "ssh"), '#!/bin/sh\nfor a; do last=$a; done\nexec sh -c "$last"\n');
    await chmod(path.join(bin, "ssh"), 0o755);
    savedPath = process.env.PATH;
    savedHome = process.env.HOME;
    process.env.PATH = `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`;
    process.env.HOME = home;
  });

  afterAll(async () => {
    process.env.PATH = savedPath;
    process.env.HOME = savedHome;
    await rm(root, { recursive: true, force: true });
  });

  it("plain upload omits .scratch-* and node_modules at any depth; normal files arrive", async () => {
    const local = path.join(root, "plain-local");
    const remote = path.join(root, "plain-remote");
    await seedWorkspace(local);
    const result = await prepareWorkspaceForSshExecution({ spec: spec(remote), localDir: local, remoteDir: remote });
    expect(result.gitBacked).toBe(false);
    await expectUploadedWithoutLocalOnly(remote);
    await expectLocalOnlyIntact(local);
  });

  it("workspaceFileMode all also omits them", async () => {
    const local = path.join(root, "all-local");
    const remote = path.join(root, "all-remote");
    await seedWorkspace(local);
    await prepareWorkspaceForSshExecution({
      spec: spec(remote), localDir: local, remoteDir: remote, workspaceFileMode: "all",
    });
    await expectUploadedWithoutLocalOnly(remote);
  });

  it("git-backed upload omits untracked .scratch-* and node_modules at any depth", async () => {
    const local = path.join(root, "git-local");
    const remote = path.join(root, "git-remote");
    await seedWorkspace(local);
    await git(local, ["init", "-q", "-b", "main"]);
    await git(local, ["add", "src", "README.md", "pkg/keep.ts"]);
    await git(local, ["commit", "-q", "-m", "init"]);
    const result = await prepareWorkspaceForSshExecution({ spec: spec(remote), localDir: local, remoteDir: remote });
    expect(result.gitBacked).toBe(true);
    await expectUploadedWithoutLocalOnly(remote);
  });

  it("restore without a baseline keeps local .scratch-* and node_modules and never pulls remote ones", async () => {
    const local = path.join(root, "restore-local");
    const remote = path.join(root, "restore-remote");
    await seedWorkspace(local);
    await prepareWorkspaceForSshExecution({ spec: spec(remote), localDir: local, remoteDir: remote });
    // The remote run edits a file, deletes one, and installs its own deps.
    await writeFile(path.join(remote, "src", "a.txt"), "edited remotely\n");
    await rm(path.join(remote, "README.md"));
    await mkdir(path.join(remote, "pkg", "node_modules", "remote-only"), { recursive: true });
    await writeFile(path.join(remote, "pkg", "node_modules", "remote-only", "x.js"), "remote\n");
    await writeFile(path.join(remote, "node_modules"), "remote file named node_modules\n");

    await restoreWorkspaceFromSshExecution({ spec: spec(remote), localDir: local, remoteDir: remote });

    expect(await readFile(path.join(local, "src", "a.txt"), "utf8")).toBe("edited remotely\n");
    expect(await exists(path.join(local, "README.md"))).toBe(false);
    await expectLocalOnlyIntact(local);
    expect(await exists(path.join(local, "pkg", "node_modules", "remote-only"))).toBe(false);
  });

  it("baseline restore through the managed runtime keeps local entries and prunes only old run copies", async () => {
    const local = path.join(root, "managed-local");
    const remoteCwd = path.join(root, "managed-remote");
    const runs = path.join(remoteCwd, ".paperclip-runtime", "runs");
    await seedWorkspace(local);
    await git(local, ["init", "-q", "-b", "main"]);
    await git(local, ["add", "src", "README.md", "pkg/keep.ts"]);
    await git(local, ["commit", "-q", "-m", "init"]);
    const old = new Date(Date.now() - 72 * 3600_000);
    await mkdir(path.join(runs, "old-run", "workspace"), { recursive: true });
    await utimes(path.join(runs, "old-run"), old, old);

    const prepared = await prepareRemoteManagedRuntime({
      spec: spec(remoteCwd), runId: "current-run", adapterKey: "test", workspaceLocalDir: local,
    });
    expect(prepared.workspaceRemoteDir).toBe(path.join(runs, "current-run", "workspace"));
    await expectUploadedWithoutLocalOnly(prepared.workspaceRemoteDir);
    await writeFile(path.join(prepared.workspaceRemoteDir, "src", "a.txt"), "edited remotely\n");
    await utimes(path.join(runs, "current-run"), old, old);

    await prepared.restoreWorkspace();

    expect(await readFile(path.join(local, "src", "a.txt"), "utf8")).toBe("edited remotely\n");
    await expectLocalOnlyIntact(local);
    expect(await exists(path.join(runs, "old-run"))).toBe(false);
    expect(await exists(path.join(runs, "current-run"))).toBe(true);
  }, 60_000);

  it("retention removes >48 h run dirs only, keeps fresh and current runs, touches nothing outside runs", async () => {
    const remoteCwd = path.join(root, "prune-remote");
    const runtime = path.join(remoteCwd, ".paperclip-runtime");
    const runs = path.join(runtime, "runs");
    const old = new Date(Date.now() - 49 * 3600_000);
    for (const name of ["stale-1", "stale-2", "fresh", "current"]) {
      await mkdir(path.join(runs, name, "workspace"), { recursive: true });
      await writeFile(path.join(runs, name, "workspace", "f"), name);
    }
    for (const name of ["stale-1", "stale-2", "current"]) await utimes(path.join(runs, name), old, old);
    await writeFile(path.join(runs, "old-file"), "not a dir");
    await utimes(path.join(runs, "old-file"), old, old);
    await mkdir(path.join(runtime, "other-old"), { recursive: true });
    await utimes(path.join(runtime, "other-old"), old, old);
    await mkdir(path.join(remoteCwd, "sibling-old"), { recursive: true });
    await utimes(path.join(remoteCwd, "sibling-old"), old, old);

    await pruneSshRunCopies({ spec: spec(remoteCwd), runsDir: runs, currentRunId: "current" });

    expect(await exists(path.join(runs, "stale-1"))).toBe(false);
    expect(await exists(path.join(runs, "stale-2"))).toBe(false);
    expect(await readFile(path.join(runs, "fresh", "workspace", "f"), "utf8")).toBe("fresh");
    expect(await readFile(path.join(runs, "current", "workspace", "f"), "utf8")).toBe("current");
    expect(await exists(path.join(runs, "old-file"))).toBe(true);
    expect(await exists(path.join(runtime, "other-old"))).toBe(true);
    expect(await exists(path.join(remoteCwd, "sibling-old"))).toBe(true);
  });

  it("retention is a no-op when runs is missing and only warns when the remote fails", async () => {
    const remoteCwd = path.join(root, "prune-missing");
    await expect(pruneSshRunCopies({
      spec: spec(remoteCwd), runsDir: path.join(remoteCwd, ".paperclip-runtime", "runs"), currentRunId: "x",
    })).resolves.toBeUndefined();
    const savedPathInner = process.env.PATH;
    process.env.PATH = path.join(root, "no-such-bin");
    try {
      await expect(pruneSshRunCopies({
        spec: spec(remoteCwd), runsDir: path.join(remoteCwd, "runs"), currentRunId: "x",
      })).resolves.toBeUndefined();
    } finally {
      process.env.PATH = savedPathInner;
    }
  });
});
