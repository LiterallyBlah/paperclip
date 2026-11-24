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
  // Per-clone reclaim needs these. A value that Git could not give is null.
  worktree: boolean;
  // Absolute path of the main repository directory (the parent of the common
  // `.git` directory). For a clone this is the clone itself.
  mainRepoPath: string | null;
  // Linked worktrees that a main repository lists, other than itself.
  linkedWorktrees: { path: string; locked: boolean; prunable: boolean }[];
  head: string | null;
  remoteRef: string | null;
  remoteUrl: string | null;
  submodules: boolean;
};

export type IsolatedCopyInspection = {
  repos: IsolatedCopyRepoState[];
  protectedFiles: { kind: "database" | "mail" | "evidence"; relativePath: string }[];
  unversionedPaths: string[];
  regenerableDirs: string[];
  // Regenerable-named directories that no repository holds. They are listed
  // in `unversionedPaths` too, so they never allow an archive.
  outsideRegenerableDirs: string[];
  // Outside regenerable directories that hold a protected file or a Git
  // directory. They are never compacted.
  outsideRegenerableHeld: string[];
  // Newest modification time of any inspected entry, or 0 when nothing was read.
  newestMtimeMs: number;
  truncated: boolean;
};

export type IsolatedCopyCloneRemoval = {
  relativePath: string;
  kind: "clone" | "worktree";
  mainRepoPath: string;
  head: string;
  remoteRef: string;
  remoteUrl: string | null;
};

export type IsolatedCopyClonePlan = {
  remove: IsolatedCopyCloneRemoval[];
  keep: { relativePath: string; reasons: string[] }[];
  compactOutside: string[];
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
      {
        cwd: repoPath,
        timeout: GIT_TIMEOUT_MS,
        signal,
        maxBuffer: 32 * 1024 * 1024,
        // A read must not refresh the index: that would change the copy's
        // modification time, which decides whether the copy is idle.
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      },
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

// True when `relativePath` is one of `dirs` or lies below one of them.
function isWithinDirs(relativePath: string, dirs: string[]) {
  const value = relativePath.replace(/\/+$/, "");
  return dirs.some((dir) => value === dir || value.startsWith(`${dir}/`));
}

// Returns the repository state and every path Git reports as ignored. The
// caller checks the ignored paths against the regenerable directories that
// `findRegenerableWorkspaceDirs` vouches for; a name alone is not evidence.
async function inspectRepo(
  root: string,
  relativePath: string,
  signal?: AbortSignal,
): Promise<{ state: IsolatedCopyRepoState; ignoredPaths: string[] }> {
  const ignoredPaths: string[] = [];
  const repoPath = path.join(root, relativePath);
  const state: IsolatedCopyRepoState = {
    relativePath,
    dirty: false,
    hasRemote: false,
    unpushed: false,
    ignoredNonRegenerable: false,
    inspectionFailed: false,
    worktree: false,
    mainRepoPath: null,
    linkedWorktrees: [],
    head: null,
    remoteRef: null,
    remoteUrl: null,
    submodules: false,
  };
  try {
    const status = await git(repoPath, ["status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=all"], signal);
    for (const entry of status.split("\0").filter(Boolean)) {
      const code = entry.slice(0, 2);
      const file = entry.slice(3);
      if (code === "!!") {
        ignoredPaths.push(file);
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
    return { state, ignoredPaths };
  }
  // Facts for per-clone reclaim. A failure leaves the value null, which keeps the clone.
  const optional = (args: string[]) => git(repoPath, args, signal).then((out) => out.trim(), () => null);
  state.worktree = await fs.lstat(path.join(repoPath, ".git")).then((stat) => stat.isFile(), () => false);
  const commonDir = await optional(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (commonDir) state.mainRepoPath = path.basename(commonDir) === ".git" ? path.dirname(commonDir) : null;
  state.head = (await optional(["rev-parse", "--verify", "-q", "HEAD"])) || null;
  state.submodules = await fs.lstat(path.join(repoPath, ".gitmodules")).then(() => true, () => false);
  if (state.head) {
    const ref = await optional(["for-each-ref", "--contains", "HEAD", "--count=1", "--format=%(refname)", "refs/remotes"]);
    if (ref) {
      state.remoteRef = ref.replace(/^refs\/remotes\//, "");
      const remotes = ((await optional(["remote"])) ?? "").split("\n").filter(Boolean)
        .sort((a, b) => b.length - a.length);
      const remote = remotes.find((name) => state.remoteRef!.startsWith(`${name}/`));
      const url = remote ? await optional(["remote", "get-url", remote]) : null;
      state.remoteUrl = url ? redactRemoteUrl(url) : null;
    }
  }
  if (!state.worktree) {
    const list = await optional(["worktree", "list", "--porcelain"]);
    if (list === null) state.mainRepoPath = null;
    else {
      for (const block of list.split(/\n\s*\n/)) {
        const lines = block.split("\n");
        const worktreePath = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
        if (!worktreePath || path.resolve(worktreePath) === path.resolve(repoPath)) continue;
        state.linkedWorktrees.push({
          path: path.resolve(worktreePath),
          locked: lines.some((line) => line === "locked" || line.startsWith("locked ")),
          prunable: lines.some((line) => line === "prunable" || line.startsWith("prunable ")),
        });
      }
    }
  }
  return { state, ignoredPaths };
}

// Drops the records of worktrees whose directory is gone.
export async function pruneGitWorktrees(mainRepoPath: string, signal?: AbortSignal) {
  await git(mainRepoPath, ["worktree", "prune"], signal);
}

// The undo record names the remote, but never a credential in its URL.
function redactRemoteUrl(url: string) {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, "$1");
}

// Walks the directory without following symlinks. It finds nested Git
// repositories, protected files (databases, mail, evidence) and files that no
// repository holds. Inside a repository, regenerable-named directories are not
// searched; Git status and `findRegenerableWorkspaceDirs` decide whether they
// are really regenerable. Outside any repository nothing vouches for them, so
// they count as unversioned files.
export async function inspectIsolatedCopyDir(root: string, options: { signal?: AbortSignal } = {}): Promise<IsolatedCopyInspection> {
  const result: IsolatedCopyInspection = {
    repos: [],
    protectedFiles: [],
    unversionedPaths: [],
    regenerableDirs: [],
    outsideRegenerableDirs: [],
    outsideRegenerableHeld: [],
    newestMtimeMs: 0,
    truncated: false,
  };
  const repoPaths: string[] = [];
  let visited = 0;
  const rootStat = await fs.lstat(root).catch(() => null);
  if (rootStat) result.newestMtimeMs = rootStat.mtimeMs;

  // `outsideRoot` is set while searching an outside regenerable directory.
  async function walk(relativeDir: string, depth: number, insideRepo: boolean, outsideRoot: string | null = null): Promise<void> {
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
      const stat = await fs.lstat(path.join(absoluteDir, entry.name)).catch(() => null);
      if (stat) result.newestMtimeMs = Math.max(result.newestMtimeMs, stat.mtimeMs);
      const isDirectory = entry.isDirectory();
      const kind = entry.name === ".git" ? null : classifyProtected(entry.name, isDirectory);
      if (kind) result.protectedFiles.push({ kind, relativePath });
      if (outsideRoot && (kind || entry.name === ".git") && !result.outsideRegenerableHeld.includes(outsideRoot)) {
        result.outsideRegenerableHeld.push(outsideRoot);
      }
      if (entry.name === ".git") continue;
      if (isDirectory && REGENERABLE_WORKSPACE_DIR_NAMES.has(entry.name)) {
        if (outsideRoot) continue;
        if (!repoHere) {
          result.unversionedPaths.push(relativePath);
          result.outsideRegenerableDirs.push(relativePath);
          // Outside a repository, look inside build output for protected
          // files before it can be compacted. Dependencies are not searched.
          if (entry.name !== "node_modules" && depth < PROTECTED_SEARCH_DEPTH) await walk(relativePath, depth + 1, true, relativePath);
        }
        continue;
      }
      if (!repoHere && !isDirectory) result.unversionedPaths.push(relativePath);
      if (isDirectory && depth < PROTECTED_SEARCH_DEPTH) await walk(relativePath, depth + 1, repoHere, outsideRoot);
      else if (isDirectory && !repoHere) result.unversionedPaths.push(relativePath);
    }
  }

  await walk("", 0, false);
  for (const repoPath of repoPaths) {
    const { state: repo, ignoredPaths } = await inspectRepo(root, repoPath, options.signal);
    result.repos.push(repo);
    if (repo.inspectionFailed) continue;
    const dirs = await findRegenerableWorkspaceDirs(path.join(root, repoPath), { signal: options.signal }).catch(() => []);
    // An ignored path that compaction would not remove (for example one that
    // only `.git/info/exclude` ignores) would be lost by an archive.
    if (ignoredPaths.some((ignored) => !isWithinDirs(ignored, dirs))) repo.ignoredNonRegenerable = true;
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

// For a copy that has been idle long enough, chooses which nested clones and
// worktrees can go and which outside regenerable directories can be compacted.
// A clone goes only when Git shows nothing that a fresh clone would lack: no
// change, untracked or unvouched ignored file, stash or submodule, and HEAD and
// every local branch on a remote-tracking ref. A worktree goes only when its
// main repository is in the same copy; a main repository goes only together
// with all of its linked worktrees. The caller re-checks idleness and use.
export function planIsolatedCopyCloneReclaim(root: string, inspection: IsolatedCopyInspection): IsolatedCopyClonePlan {
  const plan: IsolatedCopyClonePlan = { remove: [], keep: [], compactOutside: [] };
  if (inspection.truncated) {
    plan.keep.push({ relativePath: "", reasons: ["not_fully_inspected"] });
    return plan;
  }
  const absolute = (relativePath: string) => path.resolve(root, relativePath);
  const isWithin = (child: string, parent: string) => child === parent || child.startsWith(`${parent}${path.sep}`);
  const reposByPath = new Map(inspection.repos.map((repo) => [absolute(repo.relativePath), repo]));
  const ownReasons = new Map<IsolatedCopyRepoState, string[]>();
  for (const repo of inspection.repos) {
    const reasons: string[] = [];
    if (repo.inspectionFailed) reasons.push("git_inspection_failed");
    if (repo.dirty) reasons.push("dirty");
    if (!repo.inspectionFailed && !repo.hasRemote) reasons.push("no_remote");
    if (repo.unpushed) reasons.push("unpushed");
    if (repo.ignoredNonRegenerable) reasons.push("ignored_files");
    if (repo.submodules) reasons.push("submodules");
    if (!repo.inspectionFailed && (!repo.head || !repo.remoteRef)) reasons.push("head_not_on_remote");
    if (!repo.inspectionFailed && !repo.mainRepoPath) reasons.push("git_inspection_failed");
    if (repo.relativePath === "") reasons.push("copy_root_is_repository");
    const repoAbs = absolute(repo.relativePath);
    for (const kind of new Set(inspection.protectedFiles
      .filter((file) => isWithin(absolute(file.relativePath), repoAbs)).map((file) => file.kind))) reasons.push(kind);
    if (repo.worktree && repo.mainRepoPath) {
      const main = reposByPath.get(path.resolve(repo.mainRepoPath));
      if (!main || main.worktree) reasons.push("worktree_of_external_repo");
      else if (main.linkedWorktrees.some((entry) => entry.path === repoAbs && entry.locked)) reasons.push("locked_worktree");
      else if (!main.linkedWorktrees.some((entry) => entry.path === repoAbs)) reasons.push("worktree_not_listed");
    }
    ownReasons.set(repo, reasons);
  }
  const removable = new Set(inspection.repos.filter((repo) => repo.worktree && ownReasons.get(repo)!.length === 0)
    .map((repo) => absolute(repo.relativePath)));
  for (const repo of inspection.repos) {
    if (repo.worktree) continue;
    const reasons = ownReasons.get(repo)!;
    const live = repo.linkedWorktrees.filter((entry) => !entry.prunable);
    if (live.some((entry) => !removable.has(entry.path))) reasons.push("has_linked_worktrees");
  }
  for (const repo of inspection.repos) {
    const reasons = ownReasons.get(repo)!;
    if (reasons.length > 0) {
      plan.keep.push({ relativePath: repo.relativePath, reasons });
      continue;
    }
    plan.remove.push({
      relativePath: repo.relativePath,
      kind: repo.worktree ? "worktree" : "clone",
      mainRepoPath: repo.mainRepoPath!,
      head: repo.head!,
      remoteRef: repo.remoteRef!,
      remoteUrl: repo.remoteUrl,
    });
  }
  // Worktrees first, so each main repository is still there to prune them.
  plan.remove.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "worktree" ? -1 : 1));
  const held = new Set(inspection.outsideRegenerableHeld);
  plan.compactOutside = inspection.outsideRegenerableDirs.filter((dir) => !held.has(dir));
  return plan;
}
