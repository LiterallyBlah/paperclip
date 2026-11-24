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
});
