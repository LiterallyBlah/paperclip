import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { findRegenerableWorkspaceDirs, REGENERABLE_WORKSPACE_DIR_NAMES } from "./workspace-compaction.js";

// Per-task copy realizations live at `<instance>/isolated-workspaces/<companyId>/<issueId>`.
// Their rows are `local_fs` rows, and the directory is not one Git worktree: an
// agent clones any number of repositories inside it. The Git-worktree reaper
// therefore never compacts or archives them. This module inspects such a
// directory and decides, for a finished task tree, whether to keep it, remove
// only its regenerable files, or remove the whole directory.

// A finished tree must stay idle longer than this before anything is touched.
export const ISOLATED_COPY_RECLAIM_MIN_IDLE_MS = 48 * 60 * 60 * 1000;

const REPO_SEARCH_DEPTH = 4;
const PROTECTED_SEARCH_DEPTH = 10;
const MAX_INSPECTED_ENTRIES = 250_000;
const GIT_TIMEOUT_MS = 60_000;

const DATABASE_FILE_SUFFIXES = [".db", ".sqlite", ".sqlite3", ".db3", ".duckdb", ".db-wal", ".sqlite-wal"];
const DATABASE_FILE_NAMES = new Set(["PG_VERSION"]);
const MAIL_FILE_SUFFIXES = [".eml", ".mbox", ".msg"];
const MAIL_DIR_NAMES = new Set(["maildir"]);
const EVIDENCE_FILE_SUFFIXES = [".pcap", ".pcapng"];
const EVIDENCE_DIR_NAMES = new Set(["evidence", ".evidence"]);

export type IsolatedCopyRepoState = {
  relativePath: string;
  dirty: boolean;
  hasRemote: boolean;
  unpushed: boolean;
  ignoredNonRegenerable: boolean;
  inspectionFailed: boolean;
};

export type IsolatedCopyInspection = {
  repos: IsolatedCopyRepoState[];
  protectedFiles: { kind: "database" | "mail" | "evidence"; relativePath: string }[];
  unversionedPaths: string[];
  regenerableDirs: string[];
  truncated: boolean;
};

export type IsolatedCopyDecision =
  | { action: "archive"; reasons: string[] }
  | { action: "compact"; reasons: string[] }
  | { action: "keep"; reasons: string[] };

function pathSegments(value: string) {
  return path.resolve(value).split(path.sep).filter(Boolean);
}

// True only for `<...>/isolated-workspaces/<companyId>/<sourceIssueId>` local
// copy rows. The exact layout keeps shared project checkouts, Git worktrees and
// any other directory out of this path.
export function isIsolatedCopyWorkspace(workspace: {
  providerType: string;
  companyId: string;
  sourceIssueId: string | null;
  cwd: string | null;
  providerRef?: string | null;
}): boolean {
  if (workspace.providerType !== "local_fs" || !workspace.sourceIssueId || !workspace.cwd) return false;
  if (workspace.providerRef && path.resolve(workspace.providerRef) !== path.resolve(workspace.cwd)) return false;
  if (!path.isAbsolute(workspace.cwd)) return false;
  const segments = pathSegments(workspace.cwd);
  const n = segments.length;
  return n >= 3
    && segments[n - 3] === "isolated-workspaces"
    && segments[n - 2] === workspace.companyId
    && segments[n - 1] === workspace.sourceIssueId;
}

async function git(repoPath: string, args: string[], signal?: AbortSignal): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      ["-C", repoPath, ...args],
      { cwd: repoPath, timeout: GIT_TIMEOUT_MS, signal, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end();
  });
}

function classifyProtected(name: string, isDirectory: boolean): "database" | "mail" | "evidence" | null {
  const lower = name.toLowerCase();
  if (isDirectory) {
    if (MAIL_DIR_NAMES.has(lower)) return "mail";
    if (EVIDENCE_DIR_NAMES.has(lower)) return "evidence";
    return null;
  }
  if (DATABASE_FILE_NAMES.has(name) || DATABASE_FILE_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return "database";
  if (MAIL_FILE_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return "mail";
  if (EVIDENCE_FILE_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return "evidence";
  return null;
}

function isRegenerablePath(relativePath: string) {
  return relativePath.split("/").some((segment) => REGENERABLE_WORKSPACE_DIR_NAMES.has(segment));
}

async function inspectRepo(root: string, relativePath: string, signal?: AbortSignal): Promise<IsolatedCopyRepoState> {
  const repoPath = path.join(root, relativePath);
  const state: IsolatedCopyRepoState = {
    relativePath,
    dirty: false,
    hasRemote: false,
    unpushed: false,
    ignoredNonRegenerable: false,
    inspectionFailed: false,
  };
  try {
    const status = await git(repoPath, ["status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=all"], signal);
    for (const entry of status.split("\0").filter(Boolean)) {
      const code = entry.slice(0, 2);
      const file = entry.slice(3);
      if (code === "!!") {
        if (!isRegenerablePath(file)) state.ignoredNonRegenerable = true;
      } else if (!/^[RC]/.test(code) || file) {
        state.dirty = true;
      }
    }
    const stash = await git(repoPath, ["stash", "list"], signal);
    if (stash.trim()) state.dirty = true;
    state.hasRemote = (await git(repoPath, ["remote"], signal)).trim().length > 0;
    // Any commit on a local branch or HEAD that no remote-tracking ref holds.
    const unpushed = await git(repoPath, ["rev-list", "-n", "1", "HEAD", "--branches", "--not", "--remotes"], signal)
      .catch(async (error) => {
        // An unborn HEAD has no commits; then only branches count.
        const branches = (await git(repoPath, ["for-each-ref", "--format=%(refname)", "refs/heads"], signal)).trim();
        if (branches) throw error;
        return "";
      });
    state.unpushed = unpushed.trim().length > 0;
  } catch {
    state.inspectionFailed = true;
  }
  return state;
}

// Walks the directory without following symlinks. It finds nested Git
// repositories, protected files (databases, mail, evidence) and files that no
// repository holds. Regenerable directories are not searched.
export async function inspectIsolatedCopyDir(root: string, options: { signal?: AbortSignal } = {}): Promise<IsolatedCopyInspection> {
  const result: IsolatedCopyInspection = { repos: [], protectedFiles: [], unversionedPaths: [], regenerableDirs: [], truncated: false };
  const repoPaths: string[] = [];
  let visited = 0;

  async function walk(relativeDir: string, depth: number, insideRepo: boolean): Promise<void> {
    options.signal?.throwIfAborted();
    if (result.truncated) return;
    const absoluteDir = relativeDir ? path.join(root, relativeDir) : root;
    const entries = await fs.readdir(absoluteDir, { withFileTypes: true }).catch(() => null);
    if (!entries) {
      result.truncated = true;
      return;
    }
    let repoHere = insideRepo;
    if (!insideRepo && depth <= REPO_SEARCH_DEPTH && entries.some((entry) => entry.name === ".git")) {
      repoHere = true;
      repoPaths.push(relativeDir);
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_INSPECTED_ENTRIES) {
        result.truncated = true;
        return;
      }
      const relativePath = relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name;
      if (entry.name === ".git") continue;
      const isDirectory = entry.isDirectory();
      const kind = classifyProtected(entry.name, isDirectory);
      if (kind) result.protectedFiles.push({ kind, relativePath });
      if (isDirectory && REGENERABLE_WORKSPACE_DIR_NAMES.has(entry.name)) continue;
      if (!repoHere && !isDirectory) result.unversionedPaths.push(relativePath);
      if (isDirectory && depth < PROTECTED_SEARCH_DEPTH) await walk(relativePath, depth + 1, repoHere);
      else if (isDirectory && !repoHere) result.unversionedPaths.push(relativePath);
    }
  }

  await walk("", 0, false);
  for (const repoPath of repoPaths) {
    const repo = await inspectRepo(root, repoPath, options.signal);
    result.repos.push(repo);
    if (repo.inspectionFailed) continue;
    const dirs = await findRegenerableWorkspaceDirs(path.join(root, repoPath), { signal: options.signal }).catch(() => []);
    result.regenerableDirs.push(...dirs.map((dir) => (repoPath ? path.posix.join(repoPath, dir) : dir)));
  }
  return result;
}

// Archive (remove the directory) only when nothing in it would be lost: every
// repository is clean, has a remote and has no unpushed commit, no file sits
// outside a repository, and no database, mail or evidence file exists.
// Otherwise remove only regenerable files and keep the directory.
export function decideIsolatedCopyReclaim(inspection: IsolatedCopyInspection): IsolatedCopyDecision {
  const reasons = new Set<string>();
  if (inspection.truncated) reasons.add("not_fully_inspected");
  for (const kind of new Set(inspection.protectedFiles.map((file) => file.kind))) reasons.add(kind);
  if (inspection.unversionedPaths.length > 0) reasons.add("files_outside_repositories");
  for (const repo of inspection.repos) {
    if (repo.inspectionFailed) reasons.add("git_inspection_failed");
    if (repo.dirty) reasons.add("dirty");
    if (!repo.inspectionFailed && !repo.hasRemote) reasons.add("no_remote");
    if (repo.unpushed) reasons.add("unpushed");
    if (repo.ignoredNonRegenerable) reasons.add("ignored_files");
  }
  if (reasons.size === 0) return { action: "archive", reasons: ["clean_pushed"] };
  if (inspection.regenerableDirs.length > 0) return { action: "compact", reasons: [...reasons] };
  return { action: "keep", reasons: [...reasons] };
}
