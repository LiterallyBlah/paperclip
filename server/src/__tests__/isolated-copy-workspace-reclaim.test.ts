import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { executionWorkspaceService } from "../services/execution-workspaces.ts";
import {
  decideIsolatedCopyReclaim,
  inspectIsolatedCopyDir,
  isIsolatedCopyWorkspace,
  planIsolatedCopyCloneReclaim,
} from "../services/isolated-copy-workspace-reclaim.ts";

const execFileAsync = promisify(execFile);
const HOUR_MS = 60 * 60 * 1000;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function git(cwd: string, args: string[]) {
  const output = await execFileAsync("git", ["-C", cwd, ...args], { cwd });
  return output.stdout.trim();
}

async function exists(filePath: string) {
  return fs.lstat(filePath).then(() => true, () => false);
}

async function writeFile(filePath: string, contents: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
}

const tempRoots = new Set<string>();

async function tempRoot() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-isolated-copy-")));
  tempRoots.add(root);
  return root;
}

// A clone with a remote. `state` controls what the task left in it.
async function cloneInto(copyDir: string, name: string, state: "pushed" | "dirty" | "unpushed" | "no_remote") {
  const root = path.dirname(path.dirname(path.dirname(copyDir)));
  const origin = path.join(root, `origin-${name}.git`);
  await fs.mkdir(copyDir, { recursive: true });
  const repo = path.join(copyDir, name);
  if (state === "no_remote") {
    await fs.mkdir(repo, { recursive: true });
    await git(repo, ["init", "-b", "main"]);
  } else {
    await execFileAsync("git", ["init", "--bare", "-b", "main", origin]);
    await execFileAsync("git", ["clone", origin, repo]);
  }
  await git(repo, ["config", "user.name", "Paperclip Test"]);
  await git(repo, ["config", "user.email", "test@paperclip.local"]);
  await git(repo, ["checkout", "-B", "main"]);
  await writeFile(path.join(repo, ".gitignore"), "node_modules/\ndist/\n");
  await writeFile(path.join(repo, "README.md"), "# repo\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "init"]);
  if (state !== "no_remote") await git(repo, ["push", "-u", "origin", "main"]);
  await writeFile(path.join(repo, "node_modules/dep/index.js"), "module.exports = 1;\n");
  await writeFile(path.join(repo, "dist/app.js"), "built\n");
  if (state === "dirty") await fs.appendFile(path.join(repo, "README.md"), "uncommitted\n");
  if (state === "unpushed") {
    await writeFile(path.join(repo, "src/work.ts"), "export const x = 1;\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "local only"]);
  }
  return repo;
}

// Sets every modification time below `dir` back by `agoMs`.
async function age(dir: string, agoMs: number) {
  const when = new Date(Date.now() - agoMs);
  async function visit(target: string) {
    const stat = await fs.lstat(target);
    if (stat.isDirectory()) {
      for (const entry of await fs.readdir(target)) await visit(path.join(target, entry));
    }
    await fs.lutimes(target, when, when);
  }
  await visit(dir);
}

afterAll(async () => {
  for (const root of tempRoots) await fs.rm(root, { recursive: true, force: true });
});

describe("isolated copy workspace inspection", () => {
  it("recognises only the isolated-workspaces/<company>/<issue> layout", () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const cwd = `/srv/instance/isolated-workspaces/${companyId}/${issueId}`;
    expect(isIsolatedCopyWorkspace({ providerType: "local_fs", companyId, sourceIssueId: issueId, cwd })).toBe(true);
    expect(isIsolatedCopyWorkspace({ providerType: "git_worktree", companyId, sourceIssueId: issueId, cwd })).toBe(false);
    expect(isIsolatedCopyWorkspace({ providerType: "local_fs", companyId, sourceIssueId: randomUUID(), cwd })).toBe(false);
    expect(isIsolatedCopyWorkspace({ providerType: "local_fs", companyId, sourceIssueId: issueId, cwd: "/srv/repo" })).toBe(false);
  });

  it("archives only a clean, pushed copy with no protected files", async () => {
    const root = await tempRoot();
    const copy = path.join(root, "isolated-workspaces", "c", "i");
    await cloneInto(copy, "a", "pushed");
    expect(decideIsolatedCopyReclaim(await inspectIsolatedCopyDir(copy)).action).toBe("archive");
    await writeFile(path.join(copy, "a", "data", "state.sqlite"), "db");
    await git(path.join(copy, "a"), ["add", "."]);
    await git(path.join(copy, "a"), ["commit", "-m", "db"]);
    await git(path.join(copy, "a"), ["push"]);
    const decision = decideIsolatedCopyReclaim(await inspectIsolatedCopyDir(copy));
    expect(decision.action).toBe("compact");
    expect(decision.reasons).toContain("database");
  });

  it.each([
    ["dirty", "dirty"],
    ["unpushed", "unpushed"],
    ["no_remote", "no_remote"],
  ] as const)("compacts but keeps a %s copy", async (state, reason) => {
    const root = await tempRoot();
    const copy = path.join(root, "isolated-workspaces", "c", "i");
    await cloneInto(copy, "a", "pushed");
    await cloneInto(copy, "b", state);
    const inspection = await inspectIsolatedCopyDir(copy);
    const decision = decideIsolatedCopyReclaim(inspection);
    expect(decision.action).toBe("compact");
    expect(decision.reasons).toContain(reason);
    expect(inspection.regenerableDirs.sort()).toEqual(["a/dist", "a/node_modules", "b/dist", "b/node_modules"]);
  });

  it("keeps mail and files outside any repository", async () => {
    const root = await tempRoot();
    const copy = path.join(root, "isolated-workspaces", "c", "i");
    await cloneInto(copy, "a", "pushed");
    await writeFile(path.join(copy, "inbox", "message.eml"), "From: x\n");
    const decision = decideIsolatedCopyReclaim(await inspectIsolatedCopyDir(copy));
    expect(decision.reasons).toEqual(expect.arrayContaining(["mail", "files_outside_repositories"]));
    expect(decision.action).toBe("compact");
  });

  it("does not archive a regenerable-named directory outside any repository", async () => {
    const root = await tempRoot();
    const copy = path.join(root, "isolated-workspaces", "c", "i");
    await cloneInto(copy, "a", "pushed");
    await writeFile(path.join(copy, "target", "x.pcap"), "capture");
    const inspection = await inspectIsolatedCopyDir(copy);
    const decision = decideIsolatedCopyReclaim(inspection);
    expect(decision.action).not.toBe("archive");
    expect(decision.reasons).toContain("files_outside_repositories");
    expect(inspection.regenerableDirs).not.toContain("target");
  });

  it("does not archive an in-repo directory ignored only by .git/info/exclude", async () => {
    const root = await tempRoot();
    const copy = path.join(root, "isolated-workspaces", "c", "i");
    const repo = await cloneInto(copy, "a", "pushed");
    await fs.appendFile(path.join(repo, ".git", "info", "exclude"), "build/\n");
    await writeFile(path.join(repo, "build", "report.txt"), "findings");
    const inspection = await inspectIsolatedCopyDir(copy);
    const decision = decideIsolatedCopyReclaim(inspection);
    expect(decision.action).not.toBe("archive");
    expect(decision.reasons).toContain("ignored_files");
    expect(inspection.regenerableDirs.sort()).toEqual(["a/dist", "a/node_modules"]);
  });
});

describe("isolated copy per-clone reclaim plan", () => {
  it("removes a clean, pushed clone and records its HEAD and remote ref", async () => {
    const root = await tempRoot();
    const copy = path.join(root, "isolated-workspaces", "c", "i");
    const repo = await cloneInto(copy, "a", "pushed");
    const plan = planIsolatedCopyCloneReclaim(copy, await inspectIsolatedCopyDir(copy));
    expect(plan.keep).toEqual([]);
    expect(plan.remove).toEqual([{
      relativePath: "a",
      kind: "clone",
      mainRepoPath: repo,
      head: await git(repo, ["rev-parse", "HEAD"]),
      remoteRef: "origin/main",
      remoteUrl: path.join(root, "origin-a.git"),
    }]);
  });

  it.each([
    ["dirty", "dirty"],
    ["unpushed", "unpushed"],
    ["no_remote", "no_remote"],
  ] as const)("keeps a %s clone", async (state, reason) => {
    const root = await tempRoot();
    const copy = path.join(root, "isolated-workspaces", "c", "i");
    await cloneInto(copy, "a", "pushed");
    await cloneInto(copy, "b", state);
    const plan = planIsolatedCopyCloneReclaim(copy, await inspectIsolatedCopyDir(copy));
    expect(plan.remove.map((entry) => entry.relativePath)).toEqual(["a"]);
    expect(plan.keep).toEqual([{ relativePath: "b", reasons: expect.arrayContaining([reason]) }]);
  });

  it("keeps a clone with an untracked file, a stash or an unpushed side branch", async () => {
    const root = await tempRoot();
    const copy = path.join(root, "isolated-workspaces", "c", "i");
    const untracked = await cloneInto(copy, "untracked", "pushed");
    await writeFile(path.join(untracked, "notes.md"), "draft\n");
    const stashed = await cloneInto(copy, "stashed", "pushed");
    await fs.appendFile(path.join(stashed, "README.md"), "wip\n");
    await git(stashed, ["stash"]);
    const branched = await cloneInto(copy, "branched", "pushed");
    await git(branched, ["checkout", "-b", "side"]);
    await writeFile(path.join(branched, "side.txt"), "side\n");
    await git(branched, ["add", "."]);
    await git(branched, ["commit", "-m", "side"]);
    await git(branched, ["checkout", "main"]);
    const plan = planIsolatedCopyCloneReclaim(copy, await inspectIsolatedCopyDir(copy));
    expect(plan.remove).toEqual([]);
    expect(Object.fromEntries(plan.keep.map((entry) => [entry.relativePath, entry.reasons]))).toEqual({
      untracked: ["dirty"],
      stashed: ["dirty"],
      branched: ["unpushed"],
    });
  });

  it("removes a clean worktree before its main repository and keeps a main with a dirty worktree", async () => {
    const root = await tempRoot();
    const copy = path.join(root, "isolated-workspaces", "c", "i");
    const main = await cloneInto(copy, "main", "pushed");
    await git(main, ["worktree", "add", "--detach", path.join(copy, "wt"), "HEAD"]);
    let plan = planIsolatedCopyCloneReclaim(copy, await inspectIsolatedCopyDir(copy));
    expect(plan.remove.map((entry) => [entry.relativePath, entry.kind])).toEqual([["wt", "worktree"], ["main", "clone"]]);
    await writeFile(path.join(copy, "wt", "change.txt"), "x\n");
    plan = planIsolatedCopyCloneReclaim(copy, await inspectIsolatedCopyDir(copy));
    expect(plan.remove).toEqual([]);
    expect(Object.fromEntries(plan.keep.map((entry) => [entry.relativePath, entry.reasons]))).toEqual({
      main: ["has_linked_worktrees"],
      wt: ["dirty"],
    });
  });

  it("keeps a clone that holds another repository", async () => {
    const root = await tempRoot();
    const copy = path.join(root, "isolated-workspaces", "c", "i");
    const outer = await cloneInto(copy, "outer", "pushed");
    await cloneInto(outer, "inner", "dirty");
    // Git shows the inner repository as untracked, or as ignored when excluded.
    let plan = planIsolatedCopyCloneReclaim(copy, await inspectIsolatedCopyDir(copy));
    expect(plan.remove).toEqual([]);
    expect(plan.keep).toEqual([{ relativePath: "outer", reasons: ["dirty"] }]);
    await fs.appendFile(path.join(outer, ".git", "info", "exclude"), "inner/\n");
    plan = planIsolatedCopyCloneReclaim(copy, await inspectIsolatedCopyDir(copy));
    expect(plan.remove).toEqual([]);
    expect(plan.keep).toEqual([{ relativePath: "outer", reasons: ["ignored_files"] }]);
  });

  it("keeps a worktree whose main repository is outside the copy", async () => {
    const root = await tempRoot();
    const outside = await cloneInto(path.join(root, "elsewhere", "c", "i"), "main", "pushed");
    const copy = path.join(root, "isolated-workspaces", "c", "i");
    await fs.mkdir(copy, { recursive: true });
    await git(outside, ["worktree", "add", "--detach", path.join(copy, "wt"), "HEAD"]);
    const plan = planIsolatedCopyCloneReclaim(copy, await inspectIsolatedCopyDir(copy));
    expect(plan.remove).toEqual([]);
    expect(plan.keep).toEqual([{ relativePath: "wt", reasons: ["worktree_of_external_repo"] }]);
  });

  it("keeps files outside repositories and compacts only outside regenerable directories without protected files", async () => {
    const root = await tempRoot();
    const copy = path.join(root, "isolated-workspaces", "c", "i");
    await cloneInto(copy, "a", "pushed");
    await writeFile(path.join(copy, "evidence", "run.txt"), "result\n");
    await writeFile(path.join(copy, "notes.md"), "review\n");
    await writeFile(path.join(copy, "node_modules", "dep", "index.js"), "x\n");
    await writeFile(path.join(copy, "tool", "build", "out.js"), "x\n");
    await writeFile(path.join(copy, "target", "capture.pcap"), "x\n");
    const inspection = await inspectIsolatedCopyDir(copy);
    const plan = planIsolatedCopyCloneReclaim(copy, inspection);
    expect(plan.remove.map((entry) => entry.relativePath)).toEqual(["a"]);
    expect(plan.compactOutside.sort()).toEqual(["node_modules", "tool/build"]);
    expect(decideIsolatedCopyReclaim(inspection).action).toBe("compact");
  });

  it("reports the newest modification time in the copy", async () => {
    const root = await tempRoot();
    const copy = path.join(root, "isolated-workspaces", "c", "i");
    await cloneInto(copy, "a", "pushed");
    await age(copy, 72 * HOUR_MS);
    expect((await inspectIsolatedCopyDir(copy)).newestMtimeMs).toBeLessThan(Date.now() - 71 * HOUR_MS);
    // Directory changes (compaction moving node_modules out, Git index
    // refresh) do not count as use.
    await fs.rm(path.join(copy, "a", "node_modules"), { recursive: true });
    await fs.mkdir(path.join(copy, "a", ".git", "probe"));
    expect((await inspectIsolatedCopyDir(copy)).newestMtimeMs).toBeLessThan(Date.now() - 71 * HOUR_MS);
    await writeFile(path.join(copy, "a", "src", "new.ts"), "x\n");
    expect((await inspectIsolatedCopyDir(copy)).newestMtimeMs).toBeGreaterThan(Date.now() - HOUR_MS);
  });
});

describeEmbeddedPostgres("isolated copy workspace reclaim sweep", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-isolated-copy-reclaim-");
    db = createDb(tempDb.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.update(issues).set({ checkoutRunId: null, executionRunId: null, parentId: null });
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function service() {
    return executionWorkspaceService(db, {
      resolvePullRequestDetails: async () => ({ state: "unknown", headRef: null, headSha: null }),
      workspaceReaperCooldownDays: 0,
      workspaceCompactionDelayMs: 0,
      isolatedCopyReclaim: { enabled: true },
    });
  }

  async function seed(options: {
    state: "pushed" | "dirty" | "unpushed";
    issueStatus?: "done" | "cancelled" | "in_progress";
    terminalAgoMs?: number;
    lastUsedAgoMs?: number;
  }) {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const root = await tempRoot();
    const copy = path.join(root, "isolated-workspaces", companyId, issueId);
    await cloneInto(copy, "repo", options.state);
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.slice(0, 7).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "copy",
      status: "active",
      cwd: copy,
      providerType: "local_fs",
      ...(options.lastUsedAgoMs ? { lastUsedAt: new Date(Date.now() - options.lastUsedAgoMs) } : {}),
    });
    const status = options.issueStatus ?? "done";
    const terminalAt = new Date(Date.now() - (options.terminalAgoMs ?? 49 * HOUR_MS));
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `X-${Math.floor(Math.random() * 100000)}`,
      title: "Task",
      status,
      priority: "medium",
      completedAt: status === "done" ? terminalAt : null,
      cancelledAt: status === "cancelled" ? terminalAt : null,
      executionWorkspaceId,
    });
    await db.update(executionWorkspaces).set({ sourceIssueId: issueId }).where(eq(executionWorkspaces.id, executionWorkspaceId));
    return { copy, executionWorkspaceId, issueId };
  }

  async function status(id: string) {
    const [row] = await db.select({ status: executionWorkspaces.status }).from(executionWorkspaces).where(eq(executionWorkspaces.id, id));
    return row?.status;
  }

  it("archives and removes a clean, pushed copy idle for more than 48 hours", async () => {
    const seeded = await seed({ state: "pushed", issueStatus: "cancelled" });
    const result = await service().sweepTerminalWorkspaces();
    expect(result.archived).toBe(1);
    expect(await exists(seeded.copy)).toBe(false);
    expect(await status(seeded.executionWorkspaceId)).toBe("archived");
    const [issue] = await db.select({ ws: issues.executionWorkspaceId }).from(issues).where(eq(issues.id, seeded.issueId));
    expect(issue?.ws).toBeNull();
  });

  it.each(["dirty", "unpushed"] as const)("keeps a %s copy but removes its regenerable files", async (state) => {
    const seeded = await seed({ state });
    const result = await service().sweepTerminalWorkspaces();
    expect(result.compacted).toBe(1);
    expect(result.archived).toBe(0);
    expect(await status(seeded.executionWorkspaceId)).toBe("active");
    expect(await exists(path.join(seeded.copy, "repo", "README.md"))).toBe(true);
    expect(await exists(path.join(seeded.copy, "repo", "node_modules"))).toBe(false);
    expect(await exists(path.join(seeded.copy, "repo", "dist"))).toBe(false);
    if (state === "dirty") {
      expect(await fs.readFile(path.join(seeded.copy, "repo", "README.md"), "utf8")).toContain("uncommitted");
    } else {
      expect(await exists(path.join(seeded.copy, "repo", "src", "work.ts"))).toBe(true);
    }
  });

  it("does not touch a copy finished less than 48 hours ago", async () => {
    const seeded = await seed({ state: "pushed", terminalAgoMs: 47 * HOUR_MS });
    await service().sweepTerminalWorkspaces();
    expect(await status(seeded.executionWorkspaceId)).toBe("active");
    expect(await exists(path.join(seeded.copy, "repo", "node_modules"))).toBe(true);
  });

  it("does not touch a copy of an open task", async () => {
    const seeded = await seed({ state: "pushed", issueStatus: "in_progress" });
    await service().sweepTerminalWorkspaces();
    expect(await status(seeded.executionWorkspaceId)).toBe("active");
    expect(await exists(path.join(seeded.copy, "repo", "node_modules"))).toBe(true);
  });

  it("keeps a clean, pushed copy that holds a database file", async () => {
    const seeded = await seed({ state: "pushed" });
    await writeFile(path.join(seeded.copy, "repo", "state.db"), "db");
    await git(path.join(seeded.copy, "repo"), ["add", "."]);
    await git(path.join(seeded.copy, "repo"), ["commit", "-m", "db"]);
    await git(path.join(seeded.copy, "repo"), ["push"]);
    const result = await service().sweepTerminalWorkspaces();
    expect(result.archived).toBe(0);
    expect(await status(seeded.executionWorkspaceId)).toBe("active");
    expect(await exists(path.join(seeded.copy, "repo", "state.db"))).toBe(true);
    expect(await exists(path.join(seeded.copy, "repo", "node_modules"))).toBe(false);
  });

  it("keeps the copy while another active row for the same directory belongs to an open task", async () => {
    const seeded = await seed({ state: "pushed" });
    const [row] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));
    const otherIssueId = randomUUID();
    const otherWorkspaceId = randomUUID();
    await db.insert(issues).values({
      id: otherIssueId,
      companyId: row!.companyId,
      identifier: `Y-${Math.floor(Math.random() * 100000)}`,
      title: "Open",
      status: "in_progress",
      priority: "medium",
    });
    await db.insert(executionWorkspaces).values({
      id: otherWorkspaceId,
      companyId: row!.companyId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "copy-2",
      status: "active",
      cwd: seeded.copy,
      providerType: "local_fs",
      sourceIssueId: otherIssueId,
    });
    await service().sweepTerminalWorkspaces();
    expect(await exists(path.join(seeded.copy, "repo", "node_modules"))).toBe(true);
    expect(await status(seeded.executionWorkspaceId)).toBe("active");
  });

  // An idle copy: unused and unchanged for 49 hours. `repo` is dirty, so the
  // copy cannot be archived; `clean` is a pushed clone; notes sit outside.
  async function seedIdleCopy(options: { issueStatus?: "done" | "in_progress"; openChild?: boolean }) {
    const seeded = await seed({ state: "dirty", issueStatus: options.issueStatus, lastUsedAgoMs: 49 * HOUR_MS });
    const clean = await cloneInto(seeded.copy, "clean", "pushed");
    await writeFile(path.join(seeded.copy, "notes.md"), "review notes\n");
    await writeFile(path.join(seeded.copy, "node_modules", "dep", "index.js"), "x\n");
    if (options.openChild) {
      const [row] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));
      await db.insert(issues).values({
        id: randomUUID(),
        companyId: row!.companyId,
        identifier: `Z-${Math.floor(Math.random() * 100000)}`,
        title: "Child",
        status: "in_progress",
        priority: "medium",
        parentId: seeded.issueId,
      });
    }
    const head = await git(clean, ["rev-parse", "HEAD"]);
    await age(seeded.copy, 49 * HOUR_MS);
    return { ...seeded, clean, head };
  }

  it("removes a clean, pushed clone from an idle copy and keeps everything else", async () => {
    const seeded = await seedIdleCopy({});
    const result = await service().sweepTerminalWorkspaces();
    expect(result.archived).toBe(0);
    expect(await status(seeded.executionWorkspaceId)).toBe("active");
    expect(await exists(seeded.clean)).toBe(false);
    expect(await exists(path.join(seeded.copy, "node_modules"))).toBe(false);
    expect(await fs.readFile(path.join(seeded.copy, "repo", "README.md"), "utf8")).toContain("uncommitted");
    expect(await exists(path.join(seeded.copy, "notes.md"))).toBe(true);
    const events = await db.select().from(activityLog).where(eq(activityLog.action, "execution_workspace.isolated_copy_clones_removed"));
    expect(events).toHaveLength(1);
    expect(events[0]!.details).toMatchObject({
      removedClones: [{ relativePath: "clean", kind: "clone", head: seeded.head, remoteRef: "origin/main" }],
      compactedOutside: ["node_modules"],
    });
  });

  it("removes clean clones from an idle copy whose task tree is still open", async () => {
    const seeded = await seedIdleCopy({ openChild: true });
    await service().sweepTerminalWorkspaces();
    expect(await exists(seeded.clean)).toBe(false);
    expect(await exists(path.join(seeded.copy, "repo", "README.md"))).toBe(true);
    expect(await exists(path.join(seeded.copy, "notes.md"))).toBe(true);
  });

  it("does not remove clones while an open task uses the copy", async () => {
    const seeded = await seedIdleCopy({ issueStatus: "in_progress" });
    await service().sweepTerminalWorkspaces();
    expect(await exists(seeded.clean)).toBe(true);
    expect(await exists(path.join(seeded.copy, "node_modules"))).toBe(true);
  });

  it("does not remove clones from a copy changed in the last 48 hours", async () => {
    const seeded = await seedIdleCopy({});
    await writeFile(path.join(seeded.copy, "repo", "fresh.txt"), "x\n");
    await service().sweepTerminalWorkspaces();
    expect(await exists(seeded.clean)).toBe(true);
    expect(await exists(path.join(seeded.copy, "notes.md"))).toBe(true);
  });

  it("does not remove clones from a copy used in the last 48 hours", async () => {
    const seeded = await seedIdleCopy({});
    await db.update(executionWorkspaces).set({ lastUsedAt: new Date() }).where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));
    await service().sweepTerminalWorkspaces();
    expect(await exists(seeded.clean)).toBe(true);
  });

  it("removes a clean worktree through Git and keeps its dirty main repository", async () => {
    const seeded = await seed({ state: "dirty", lastUsedAgoMs: 49 * HOUR_MS });
    const main = path.join(seeded.copy, "repo");
    const worktree = path.join(seeded.copy, "wt");
    await git(main, ["worktree", "add", "--detach", worktree, "HEAD"]);
    await age(seeded.copy, 49 * HOUR_MS);
    await service().sweepTerminalWorkspaces();
    expect(await exists(worktree)).toBe(false);
    expect(await fs.readFile(path.join(main, "README.md"), "utf8")).toContain("uncommitted");
    expect(await git(main, ["worktree", "list", "--porcelain"])).not.toContain(worktree);
  });
});
