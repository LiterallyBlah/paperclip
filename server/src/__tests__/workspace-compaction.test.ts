import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  WORKSPACE_COMPACTION_TRASH_DIR,
  deleteWorkspaceCompactionTrash,
  findRegenerableWorkspaceDirs,
  findTaskDirectoryRegenerableDirs,
  isLinkedGitWorktree,
  moveWorkspaceDirsToTrash,
  purgeStaleWorkspaceCompactionTrash,
  restoreWorkspaceDirsFromTrash,
} from "../services/workspace-compaction.ts";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function git(cwd: string, args: string[]) {
  return (await execFileAsync("git", ["-C", cwd, ...args], { cwd })).stdout.trim();
}

async function write(filePath: string, contents = "x\n") {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
}

async function createRepoWithWorktree(gitignore: string[]) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-compaction-unit-")));
  tempDirs.push(root);
  const repoRoot = path.join(root, "repo");
  await fs.mkdir(repoRoot);
  await git(repoRoot, ["init", "-b", "main"]);
  await git(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await git(repoRoot, ["config", "user.email", "test@paperclip.local"]);
  await write(path.join(repoRoot, ".gitignore"), `${gitignore.join("\n")}\n`);
  await git(repoRoot, ["add", ".gitignore"]);
  await git(repoRoot, ["commit", "-m", "Initial commit"]);
  const worktreePath = path.join(root, "worktrees", "PAP-1-task");
  await git(repoRoot, ["worktree", "add", "-b", "PAP-1-task", worktreePath, "main"]);
  return { root, repoRoot, worktreePath };
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("findRegenerableWorkspaceDirs", () => {
  it("returns only ignored, untracked directories with a regenerable name", async () => {
    const { worktreePath } = await createRepoWithWorktree([
      "node_modules/", "dist/", ".turbo/", ".env", "local-data/", ".paperclip/", "coverage/",
    ]);
    await write(path.join(worktreePath, "node_modules/a/index.js"));
    await write(path.join(worktreePath, "packages/ui/node_modules/b/index.js"));
    await write(path.join(worktreePath, "packages/ui/dist/ui.js"));
    await write(path.join(worktreePath, ".turbo/cache"));
    // Ignored, but not a regenerable name: data and secrets stay.
    await write(path.join(worktreePath, ".env"));
    await write(path.join(worktreePath, "local-data/state.json"));
    // A regenerable name that Git does not ignore is source.
    await write(path.join(worktreePath, "build/keep.txt"));
    // The worktree instance data is never scanned.
    await write(path.join(worktreePath, ".paperclip/node_modules/c/index.js"));
    // An ignored directory with a force-added tracked file is source.
    await write(path.join(worktreePath, "coverage/baseline.json"));
    await git(worktreePath, ["add", "-f", "coverage/baseline.json"]);

    expect((await findRegenerableWorkspaceDirs(worktreePath)).sort()).toEqual([
      ".turbo",
      "node_modules",
      "packages/ui/dist",
      "packages/ui/node_modules",
    ]);
  });

  it("does not follow or return a symlinked directory", async () => {
    const { root, worktreePath } = await createRepoWithWorktree(["node_modules"]);
    const outside = path.join(root, "shared-store");
    await write(path.join(outside, "node_modules/pkg/index.js"));
    await fs.symlink(path.join(outside, "node_modules"), path.join(worktreePath, "node_modules"));
    await fs.symlink(outside, path.join(worktreePath, "linked"));

    expect(await findRegenerableWorkspaceDirs(worktreePath)).toEqual([]);
  });

  it("searches inside a regenerable-named directory that is source", async () => {
    const { worktreePath } = await createRepoWithWorktree(["node_modules/"]);
    // `build/` holds tracked source, so it stays, but its ignored dependencies go.
    await write(path.join(worktreePath, "build/scripts/release.ts"));
    await git(worktreePath, ["add", "build/scripts/release.ts"]);
    await write(path.join(worktreePath, "build/node_modules/tool/index.js"));
    // An untracked, not-ignored `dist/` is work in progress; its ignored
    // dependencies still go.
    await write(path.join(worktreePath, "dist/notes.md"));
    await write(path.join(worktreePath, "dist/node_modules/dep/index.js"));

    expect((await findRegenerableWorkspaceDirs(worktreePath)).sort()).toEqual([
      "build/node_modules",
      "dist/node_modules",
    ]);
  });

  it("finds dependencies below an ignored parent directory", async () => {
    const { worktreePath } = await createRepoWithWorktree(["vendor/", "node_modules/"]);
    await write(path.join(worktreePath, "vendor/tool/source.c"));
    await write(path.join(worktreePath, "vendor/tool/node_modules/dep/index.js"));
    // A single nested candidate once made `ls-files --directory` fail.
    expect(await findRegenerableWorkspaceDirs(worktreePath)).toEqual(["vendor/tool/node_modules"]);

    await write(path.join(worktreePath, "node_modules/a/index.js"));
    expect((await findRegenerableWorkspaceDirs(worktreePath)).sort())
      .toEqual(["node_modules", "vendor/tool/node_modules"]);
  });

  it("keeps a directory that a negated pattern unignores", async () => {
    const { worktreePath } = await createRepoWithWorktree(["build/", "!build/", "dist/", "node_modules/"]);
    // Untracked work in an explicitly unignored directory is not regenerable.
    await write(path.join(worktreePath, "build/release-notes.md"));
    await write(path.join(worktreePath, "dist/bundle.js"));

    expect(await findRegenerableWorkspaceDirs(worktreePath)).toEqual(["dist"]);
    await expect(fs.access(path.join(worktreePath, "build/release-notes.md"))).resolves.toBeUndefined();
  });

  it("handles directory names with glob characters in the tracked-file check", async () => {
    const { worktreePath } = await createRepoWithWorktree(["node_modules/"]);
    await write(path.join(worktreePath, "pkg[1]/node_modules/vendored/index.js"));
    await git(worktreePath, ["add", "-f", "pkg[1]/node_modules/vendored/index.js"]);
    await write(path.join(worktreePath, "pkg1/node_modules/dep/index.js"));

    expect(await findRegenerableWorkspaceDirs(worktreePath)).toEqual(["pkg1/node_modules"]);
  });

  it("ignores global and repository-local exclude files", async () => {
    const { root, repoRoot, worktreePath } = await createRepoWithWorktree(["dist/"]);
    const globalExcludes = path.join(root, "global-gitignore");
    await write(globalExcludes, "build/\n");
    await git(repoRoot, ["config", "core.excludesFile", globalExcludes]);
    await write(path.join(repoRoot, ".git/info/exclude"), "coverage/\n");
    await write(path.join(worktreePath, "build/draft.md"));
    await write(path.join(worktreePath, "coverage/report.html"));
    await write(path.join(worktreePath, "dist/bundle.js"));

    expect(await findRegenerableWorkspaceDirs(worktreePath)).toEqual(["dist"]);
  });

  it("stops when the sweep is aborted", async () => {
    const { worktreePath } = await createRepoWithWorktree(["node_modules/"]);
    await write(path.join(worktreePath, "node_modules/a/index.js"));
    const controller = new AbortController();
    controller.abort();
    await expect(findRegenerableWorkspaceDirs(worktreePath, { signal: controller.signal })).rejects.toThrow();
  });

  it("returns nothing when no directory qualifies", async () => {
    const { worktreePath } = await createRepoWithWorktree(["node_modules/"]);
    await write(path.join(worktreePath, "src/index.ts"));
    expect(await findRegenerableWorkspaceDirs(worktreePath)).toEqual([]);
  });
});

describe("isLinkedGitWorktree", () => {
  it("accepts a linked worktree and rejects a main checkout", async () => {
    const { repoRoot, worktreePath } = await createRepoWithWorktree([]);
    expect(await isLinkedGitWorktree(worktreePath)).toBe(true);
    expect(await isLinkedGitWorktree(repoRoot)).toBe(false);
  });
});

describe("compaction trash", () => {
  it("moves directories beside the worktree and restores them unchanged", async () => {
    const { worktreePath } = await createRepoWithWorktree(["node_modules/", "dist/"]);
    await write(path.join(worktreePath, "node_modules/a/index.js"), "dependency\n");
    await write(path.join(worktreePath, "packages/ui/dist/ui.js"), "bundle\n");

    const move = await moveWorkspaceDirsToTrash(worktreePath, ["node_modules", "packages/ui/dist", "missing"]);
    expect(move.moved.map((entry) => entry.relativePath)).toEqual(["node_modules", "packages/ui/dist"]);
    expect(path.dirname(path.dirname(move.trashDir))).toBe(path.dirname(worktreePath));
    expect(path.basename(path.dirname(move.trashDir))).toBe(WORKSPACE_COMPACTION_TRASH_DIR);
    await expect(fs.access(path.join(worktreePath, "node_modules"))).rejects.toThrow();

    await restoreWorkspaceDirsFromTrash(worktreePath, move);
    expect(await fs.readFile(path.join(worktreePath, "node_modules/a/index.js"), "utf8")).toBe("dependency\n");
    expect(await fs.readFile(path.join(worktreePath, "packages/ui/dist/ui.js"), "utf8")).toBe("bundle\n");
    await deleteWorkspaceCompactionTrash(move.trashDir);
    await expect(fs.access(move.trashDir)).rejects.toThrow();
  });

  it("keeps a directory something recreated instead of overwriting it on restore", async () => {
    const { worktreePath } = await createRepoWithWorktree(["node_modules/"]);
    await write(path.join(worktreePath, "node_modules/a/index.js"), "old\n");
    const move = await moveWorkspaceDirsToTrash(worktreePath, ["node_modules"]);
    await write(path.join(worktreePath, "node_modules/a/index.js"), "reinstalled\n");

    await restoreWorkspaceDirsFromTrash(worktreePath, move);
    expect(await fs.readFile(path.join(worktreePath, "node_modules/a/index.js"), "utf8")).toBe("reinstalled\n");
  });

  it("purges only trash older than the threshold", async () => {
    const { worktreePath } = await createRepoWithWorktree([]);
    const parent = path.dirname(worktreePath);
    const stale = path.join(parent, WORKSPACE_COMPACTION_TRASH_DIR, "stale");
    const fresh = path.join(parent, WORKSPACE_COMPACTION_TRASH_DIR, "fresh");
    await write(path.join(stale, "0/file"));
    await write(path.join(fresh, "0/file"));
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(stale, twoHoursAgo, twoHoursAgo);

    await purgeStaleWorkspaceCompactionTrash(parent, 60 * 60 * 1000);
    await expect(fs.access(stale)).rejects.toThrow();
    await expect(fs.access(fresh)).resolves.toBeUndefined();
  });
});

// The agent controls a checkout and the Git config its `.git` entry leads to.
// A Git read by the server must not run a program that config names.
describe("compaction Git reads over an agent-controlled checkout", () => {
  async function agentCheckouts() {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-compaction-config-")));
    tempDirs.push(root);
    const taskDirectory = path.join(root, "task");
    // A checkout with a `.git` directory.
    const plain = path.join(taskDirectory, "plain");
    // A checkout whose `.git` file points at a Git directory the agent chose.
    const gitFile = path.join(taskDirectory, "gitfile");
    const agentGitDir = path.join(root, "agent-chosen-gitdir");
    await fs.mkdir(plain, { recursive: true });
    await git(plain, ["init", "-b", "main"]);
    await fs.mkdir(gitFile, { recursive: true });
    await git(gitFile, ["init", "-b", "main", "--separate-git-dir", agentGitDir]);
    for (const checkout of [plain, gitFile]) {
      await git(checkout, ["config", "user.name", "Paperclip Test"]);
      await git(checkout, ["config", "user.email", "test@paperclip.local"]);
      await write(path.join(checkout, ".gitignore"), "node_modules/\n");
      await git(checkout, ["add", ".gitignore"]);
      await git(checkout, ["commit", "-m", "Initial commit"]);
      await write(path.join(checkout, "node_modules/dep/index.js"));
    }
    return { root, taskDirectory, plain, gitFile };
  }

  const exists = (target: string) => fs.lstat(target).then(() => true, () => false);

  it("does not run a core.fsmonitor command from repository config", async () => {
    const { root, taskDirectory, plain, gitFile } = await agentCheckouts();
    expect(await isLinkedGitWorktree(gitFile)).toBe(true);
    const marker = path.join(root, "fsmonitor-ran");
    // Set last: the fixture's own Git calls would run it too.
    for (const checkout of [plain, gitFile]) {
      await git(checkout, ["config", "core.fsmonitor", `touch '${marker}'; exit 1`]);
    }

    expect(await findRegenerableWorkspaceDirs(gitFile)).toEqual(["node_modules"]);
    expect(await findRegenerableWorkspaceDirs(plain)).toEqual(["node_modules"]);
    expect(await findTaskDirectoryRegenerableDirs(taskDirectory)).toEqual(["gitfile/node_modules", "plain/node_modules"]);
    expect(await exists(marker)).toBe(false);
  });

  it("does not run a promisor remote's transport to fetch a missing object", async () => {
    const { root, taskDirectory, plain, gitFile } = await agentCheckouts();
    const marker = path.join(root, "lazy-fetch-ran");
    for (const checkout of [plain, gitFile]) {
      // Git reads a skip-worktree `.gitignore` from the index blob. With the
      // blob missing in a partial clone, Git fetches it from the promisor remote.
      const blob = await git(checkout, ["rev-parse", "HEAD:.gitignore"]);
      await git(checkout, ["update-index", "--skip-worktree", ".gitignore"]);
      await fs.rm(path.join(checkout, ".gitignore"));
      const objects = await git(checkout, ["rev-parse", "--git-path", "objects"]);
      await fs.rm(path.resolve(checkout, objects, blob.slice(0, 2), blob.slice(2)));
      await git(checkout, ["config", "core.repositoryformatversion", "1"]);
      await git(checkout, ["config", "extensions.partialClone", "origin"]);
      await git(checkout, ["config", "remote.origin.promisor", "true"]);
      await git(checkout, ["config", "remote.origin.url", `ext::sh -c touch% ${marker}`]);
      await git(checkout, ["config", "protocol.ext.allow", "always"]);
    }

    // The blob stays missing, so nothing proves `node_modules` is ignored.
    expect(await findRegenerableWorkspaceDirs(gitFile)).toEqual([]);
    expect(await findRegenerableWorkspaceDirs(plain)).toEqual([]);
    expect(await findTaskDirectoryRegenerableDirs(taskDirectory)).toEqual([]);
    expect(await exists(marker)).toBe(false);
  });
});
