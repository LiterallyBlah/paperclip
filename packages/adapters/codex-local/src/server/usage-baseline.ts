import fs from "node:fs/promises";
import path from "node:path";

/**
 * Codex thread usage totals in Codex's own convention: `inputTokens`
 * includes cache hits (`cachedInputTokens` is a subset of it).
 */
export interface CodexThreadUsageTotals {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/**
 * What the thread had already consumed before this execution started.
 * - `fresh`: a new Codex thread; its counters start at zero.
 * - `resumed`: `totals` are the thread totals Codex had persisted when this
 *   execution resumed `sessionId`, or `null` when they could not be read.
 */
export type CodexUsageBaseline =
  | { kind: "fresh" }
  | { kind: "resumed"; sessionId: string; totals: CodexThreadUsageTotals | null };

export type CodexExecutionUsage = {
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number } | undefined;
  usageComplete: boolean;
  /** Set when reported counters were discarded because no defensible baseline exists. */
  unknownReason: "missing_baseline" | "counters_decreased" | null;
};

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function readTotals(value: unknown): CodexThreadUsageTotals | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const cached = record.cached_input_tokens ?? 0;
  if (!isCount(record.input_tokens) || !isCount(record.output_tokens) || !isCount(cached)) return null;
  if (cached > record.input_tokens) return null;
  return { inputTokens: record.input_tokens, cachedInputTokens: cached, outputTokens: record.output_tokens };
}

/**
 * Codex `exec --json` reports `turn.completed.usage` from the thread's
 * cumulative `total_token_usage`, which survives `exec resume`. The same
 * totals are persisted as `token_count` events in the thread's rollout file
 * under `$CODEX_HOME/sessions`. Return the last persisted totals for
 * `threadId`, or `null` when they cannot be determined unambiguously.
 */
export async function readCodexThreadUsageTotals(
  codexHome: string,
  threadId: string,
): Promise<CodexThreadUsageTotals | null> {
  if (!threadId.trim()) return null;
  const suffix = `-${threadId}.jsonl`;
  const matches: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 4) await walk(full, depth + 1);
      else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(suffix)) matches.push(full);
    }
  };
  await walk(path.join(codexHome, "sessions"), 0);
  if (matches.length !== 1) return null;

  let text: string;
  try {
    text = await fs.readFile(matches[0]!, "utf8");
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trim();
    if (!line.includes("token_count")) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = (record as { payload?: { type?: unknown; info?: { total_token_usage?: unknown } | null } } | null)?.payload;
    if (payload?.type !== "token_count" || !payload.info) continue;
    // The newest totals decide: if they are malformed there is no defensible baseline.
    return readTotals(payload.info.total_token_usage);
  }
  return null;
}

/**
 * Convert Codex's terminal (thread-cumulative) counters into this execution's
 * usage. Subtraction happens once, on Codex's raw counters, before cache hits
 * are split out of input. When the execution resumed a thread whose prior
 * totals are unknown, or any counter went backwards, the usage is unknown.
 */
export function resolveCodexExecutionUsage(
  parsed: {
    sessionId: string | null;
    usageComplete: boolean;
    rawUsage: CodexThreadUsageTotals | null;
  },
  baseline: CodexUsageBaseline,
): CodexExecutionUsage {
  const current = parsed.rawUsage;
  if (!current) return { usage: undefined, usageComplete: false, unknownReason: null };

  const zero: CodexThreadUsageTotals = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  const startedNewThread =
    baseline.kind === "fresh" || (parsed.sessionId !== null && parsed.sessionId !== baseline.sessionId);
  const prior = startedNewThread ? zero : baseline.totals;
  if (!prior) return { usage: undefined, usageComplete: false, unknownReason: "missing_baseline" };

  const input = current.inputTokens - prior.inputTokens;
  const cached = current.cachedInputTokens - prior.cachedInputTokens;
  const output = current.outputTokens - prior.outputTokens;
  const uncached = input - cached;
  if (input < 0 || cached < 0 || output < 0 || uncached < 0) {
    return { usage: undefined, usageComplete: false, unknownReason: "counters_decreased" };
  }
  return {
    usage: { inputTokens: uncached, cachedInputTokens: cached, outputTokens: output },
    usageComplete: parsed.usageComplete,
    unknownReason: null,
  };
}
