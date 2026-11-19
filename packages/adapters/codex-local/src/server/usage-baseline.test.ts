import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCodexJsonl } from "./parse.js";
import { readCodexThreadUsageTotals, resolveCodexExecutionUsage, type CodexThreadUsageTotals } from "./usage-baseline.js";

const THREAD = "thread-aaaa";

// Thread totals observed on one resumed Codex thread (counts only): each
// execution was a single short turn, yet the terminal counters kept growing.
const T1: CodexThreadUsageTotals = { inputTokens: 353_684, cachedInputTokens: 314_112, outputTokens: 1_944 };
const T2: CodexThreadUsageTotals = { inputTokens: 687_976, cachedInputTokens: 625_920, outputTokens: 3_170 };
const T3: CodexThreadUsageTotals = { inputTokens: 1_078_404, cachedInputTokens: 1_005_824, outputTokens: 4_422 };

function stdoutFor(threadId: string, totals: CodexThreadUsageTotals | null) {
  return [
    JSON.stringify({ type: "thread.started", thread_id: threadId }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }),
    JSON.stringify(
      totals
        ? {
            type: "turn.completed",
            usage: { input_tokens: totals.inputTokens, cached_input_tokens: totals.cachedInputTokens, output_tokens: totals.outputTokens },
          }
        : { type: "turn.completed" },
    ),
  ].join("\n");
}

describe("resolveCodexExecutionUsage", () => {
  it("fresh execution: thread totals are this execution's usage, cache split out once", () => {
    const resolved = resolveCodexExecutionUsage(parseCodexJsonl(stdoutFor(THREAD, T1)), { kind: "fresh" });
    expect(resolved).toEqual({
      usage: { inputTokens: 39_572, cachedInputTokens: 314_112, outputTokens: 1_944 },
      usageComplete: true,
      unknownReason: null,
    });
  });

  it("two resumes in a row: each execution gets only its own delta, with no double subtraction", () => {
    const second = resolveCodexExecutionUsage(parseCodexJsonl(stdoutFor(THREAD, T2)), {
      kind: "resumed", sessionId: THREAD, totals: T1,
    });
    const third = resolveCodexExecutionUsage(parseCodexJsonl(stdoutFor(THREAD, T3)), {
      kind: "resumed", sessionId: THREAD, totals: T2,
    });
    // input delta 334,292 minus cached delta 311,808 = 22,484 uncached.
    expect(second.usage).toEqual({ inputTokens: 22_484, cachedInputTokens: 311_808, outputTokens: 1_226 });
    expect(third.usage).toEqual({ inputTokens: 10_524, cachedInputTokens: 379_904, outputTokens: 1_252 });
    expect(second.usageComplete && third.usageComplete).toBe(true);

    // The three executions add up to the thread's final totals exactly once.
    const first = resolveCodexExecutionUsage(parseCodexJsonl(stdoutFor(THREAD, T1)), { kind: "fresh" }).usage!;
    const sum = [first, second.usage!, third.usage!].reduce((acc, u) => ({
      inputTokens: acc.inputTokens + u.inputTokens,
      cachedInputTokens: acc.cachedInputTokens + u.cachedInputTokens,
      outputTokens: acc.outputTokens + u.outputTokens,
    }));
    expect(sum).toEqual({
      inputTokens: T3.inputTokens - T3.cachedInputTokens,
      cachedInputTokens: T3.cachedInputTokens,
      outputTokens: T3.outputTokens,
    });
  });

  it("rotation: Codex started a different thread, so its counters start from zero", () => {
    const resolved = resolveCodexExecutionUsage(parseCodexJsonl(stdoutFor("thread-bbbb", T1)), {
      kind: "resumed", sessionId: THREAD, totals: T3,
    });
    expect(resolved.usage).toEqual({ inputTokens: 39_572, cachedInputTokens: 314_112, outputTokens: 1_944 });
    expect(resolved.unknownReason).toBeNull();
  });

  it("reset on the same thread (counters went down): unknown, never negative", () => {
    const resolved = resolveCodexExecutionUsage(parseCodexJsonl(stdoutFor(THREAD, T1)), {
      kind: "resumed", sessionId: THREAD, totals: T2,
    });
    expect(resolved).toEqual({ usage: undefined, usageComplete: false, unknownReason: "counters_decreased" });
  });

  it("uncached input going backwards is also a reset, even when input and cached grew", () => {
    const resolved = resolveCodexExecutionUsage(
      parseCodexJsonl(stdoutFor(THREAD, { inputTokens: 700_000, cachedInputTokens: 690_000, outputTokens: 3_200 })),
      { kind: "resumed", sessionId: THREAD, totals: T2 },
    );
    expect(resolved.unknownReason).toBe("counters_decreased");
    expect(resolved.usage).toBeUndefined();
  });

  it("resume without a readable baseline: unknown rather than the thread total", () => {
    const resolved = resolveCodexExecutionUsage(parseCodexJsonl(stdoutFor(THREAD, T3)), {
      kind: "resumed", sessionId: THREAD, totals: null,
    });
    expect(resolved).toEqual({ usage: undefined, usageComplete: false, unknownReason: "missing_baseline" });
  });

  it("resume whose stream never names the thread keeps the resumed baseline", () => {
    const stdout = JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: T2.inputTokens, cached_input_tokens: T2.cachedInputTokens, output_tokens: T2.outputTokens },
    });
    const resolved = resolveCodexExecutionUsage(parseCodexJsonl(stdout), { kind: "resumed", sessionId: THREAD, totals: T1 });
    expect(resolved.usage).toEqual({ inputTokens: 22_484, cachedInputTokens: 311_808, outputTokens: 1_226 });
  });

  it("missing or incomplete usage stays unreported and incomplete", () => {
    expect(resolveCodexExecutionUsage(parseCodexJsonl(stdoutFor(THREAD, null)), { kind: "fresh" })).toEqual({
      usage: undefined, usageComplete: false, unknownReason: null,
    });
    const incomplete = [
      JSON.stringify({ type: "thread.started", thread_id: THREAD }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 1 } }),
      JSON.stringify({ type: "turn.started" }),
    ].join("\n");
    const resolved = resolveCodexExecutionUsage(parseCodexJsonl(incomplete), { kind: "fresh" });
    expect(resolved.usageComplete).toBe(false);
    expect(resolved.usage).toEqual({ inputTokens: 10, cachedInputTokens: 0, outputTokens: 1 });
  });
});

describe("readCodexThreadUsageTotals", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
  });

  async function home() {
    const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-usage-baseline-"));
    dirs.push(dir);
    return dir;
  }

  const tokenCount = (totals: CodexThreadUsageTotals | null) =>
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: totals
          ? {
              total_token_usage: {
                input_tokens: totals.inputTokens,
                cached_input_tokens: totals.cachedInputTokens,
                output_tokens: totals.outputTokens,
                total_tokens: totals.inputTokens + totals.outputTokens,
              },
              last_token_usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
            }
          : null,
      },
    });

  async function writeRollout(codexHome: string, day: string, threadId: string, lines: string[]) {
    const dir = path.join(codexHome, "sessions", "2026", "11", day);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `rollout-2026-11-${day}T05-02-17-${threadId}.jsonl`), `${lines.join("\n")}\n`);
  }

  it("returns the newest persisted thread totals, skipping rate-limit-only token_count events", async () => {
    const codexHome = await home();
    await writeRollout(codexHome, "19", THREAD, [
      JSON.stringify({ type: "session_meta", payload: { id: THREAD } }),
      tokenCount(T1),
      tokenCount(T2),
      tokenCount(null),
      JSON.stringify({ type: "response_item", payload: { type: "message" } }),
    ]);
    await writeRollout(codexHome, "19", "thread-other", [tokenCount(T3)]);
    expect(await readCodexThreadUsageTotals(codexHome, THREAD)).toEqual(T2);
  });

  it("returns null when the thread has no rollout, no totals, malformed totals, or more than one rollout", async () => {
    const codexHome = await home();
    expect(await readCodexThreadUsageTotals(codexHome, THREAD)).toBeNull();

    await writeRollout(codexHome, "18", "thread-empty", [JSON.stringify({ type: "session_meta" }), tokenCount(null)]);
    expect(await readCodexThreadUsageTotals(codexHome, "thread-empty")).toBeNull();

    await writeRollout(codexHome, "18", "thread-bad", [
      tokenCount(T1),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 5, cached_input_tokens: 9, output_tokens: 1 } } } }),
    ]);
    expect(await readCodexThreadUsageTotals(codexHome, "thread-bad")).toBeNull();

    await writeRollout(codexHome, "18", THREAD, [tokenCount(T1)]);
    await writeRollout(codexHome, "19", THREAD, [tokenCount(T2)]);
    expect(await readCodexThreadUsageTotals(codexHome, THREAD)).toBeNull();
  });
});
