import { describe, expect, it } from "vitest";
import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import {
  buildRecentContinuationWindow,
  continuationHistoryModeForAdapter,
  deliveredContinuationCommentIds,
} from "./execution-continuation.js";

type Message = ExecutionContinuationEnvelope["messages"][number];

const AGENT = "oracle-agent";
const at = (index: number) => new Date(Date.UTC(2026, 10, 1, 0, index)).toISOString();
const message = (index: number, overrides: Partial<Message> = {}): Message => ({
  id: `comment-${String(index).padStart(3, "0")}`,
  authorType: "agent",
  authorId: AGENT,
  createdByRunId: `run-${index}`,
  body: `Monitor tick ${index}: ${"status detail ".repeat(110)}`,
  createdAt: at(index),
  updatedAt: at(index),
  deleted: false,
  sourceTrust: "agent",
  ...overrides,
});
const human = (index: number, body: string): Partial<Message> => ({
  authorType: "user", authorId: "board-user", createdByRunId: null, body, sourceTrust: "human",
});

/** 207 messages, shaped like the BLA-707 monitor thread: long agent ticks with sparse human direction. */
function monitorThread() {
  return Array.from({ length: 207 }, (_, index) => {
    if (index === 4) return message(index, human(index, `ORIGIN request: ${"keep the recovery anchor open ".repeat(200)}`));
    if (index === 90) return message(index, human(index, "Older answered direction."));
    if (index === 203) return message(index, human(index, "LATEST request: stop the patrol and report the mailbox count."));
    return message(index);
  });
}

const envelope = (messages: Message[], extra: Partial<ExecutionContinuationEnvelope> = {}): ExecutionContinuationEnvelope => ({
  version: 1,
  companyId: "company",
  issueId: "issue",
  trigger: { reason: "issue_monitor_due", interactionId: null, sourceRunId: null },
  originCommentIds: ["comment-004"],
  objective: messages.findLast((m) => m.authorType === "user")?.body ?? "Task",
  objectiveSource: { kind: "comment", id: "comment-203", revision: at(203) },
  messages,
  humanResponses: [],
  interactionOutcomes: [],
  completedWork: null,
  unresolvedInteractionIds: [],
  coverage: { kind: "full_task_history", throughCommentId: messages.at(-1)?.id ?? null, summaryThroughCommentId: null },
  ...extra,
});

const render = (continuation: ExecutionContinuationEnvelope, resumedSession = false) =>
  renderPaperclipWakePrompt({
    reason: "issue_monitor_due",
    issue: { id: "issue", identifier: "BLA-707", title: "Monitor", description: null },
    executionContinuation: continuation,
  }, { resumedSession });

function requestContext(prompt: string) {
  const match = /## Current request and continuation context[\s\S]*?\n(`{3,})text\n([\s\S]*?)\n\1/.exec(prompt);
  if (!match) throw new Error("request context block not found");
  return JSON.parse(match[2]!) as ExecutionContinuationEnvelope;
}

describe("recent-window continuation for fresh sessions", () => {
  it("is on by default for hermes_gateway only", () => {
    expect(continuationHistoryModeForAdapter("hermes_gateway")).toBe("recent_window");
    for (const adapter of ["hermes_local", "claude_local", "codex_local", null, undefined])
      expect(continuationHistoryModeForAdapter(adapter)).toBe("full");
  });

  it("bounds a 207-message thread and tells the agent to fetch the rest", () => {
    const messages = monitorThread();
    const fullPrompt = render(envelope(messages));
    const continuation = envelope(messages, {
      recentWindow: buildRecentContinuationWindow(messages, { originCommentIds: ["comment-004"], agentId: AGENT }),
    });
    const prompt = render(continuation);
    const context = requestContext(prompt);

    const bodyChars = context.messages.reduce((sum, m) => sum + m.body.length, 0);
    expect(bodyChars).toBeLessThanOrEqual(12_000);
    expect(context.messages.every((m) => m.body.length <= 4_000)).toBe(true);
    const ids = context.messages.map((m) => m.id);
    expect(ids).toContain("comment-004");
    expect(ids).toContain("comment-203");
    expect(ids).toEqual([...ids].sort());
    expect(prompt).toContain("LATEST request: stop the patrol");
    expect(prompt).toContain("ORIGIN request:");
    expect(context.coverage).toEqual({
      kind: "recent_window",
      throughCommentId: "comment-206",
      summaryThroughCommentId: null,
      omittedCount: 207 - ids.length,
    });
    expect(context).not.toHaveProperty("recentWindow");
    expect(prompt).toContain(`${207 - ids.length} older message(s) omitted`);
    expect(prompt).toContain("- fallback fetch needed: yes");
    // The full envelope still carries every message for resume deltas and audits.
    expect(continuation.messages).toHaveLength(207);
    expect(fullPrompt.length).toBeGreaterThan(300_000);
    expect(prompt.length).toBeLessThan(20_000);
  });

  it("gives origin and unanswered human messages the budget before the newest messages", () => {
    const messages = [
      message(0, human(0, "x".repeat(5_000))),
      message(1),
      message(2, human(2, "Unanswered ask A")),
      ...Array.from({ length: 12 }, (_, i) => message(3 + i, { authorId: "other-agent", body: "y".repeat(3_000) })),
    ];
    const window = buildRecentContinuationWindow(messages, { originCommentIds: ["comment-000"], agentId: AGENT });
    const byId = new Map(window.messages.map((m) => [m.id, m]));
    expect(byId.get("comment-000")).toMatchObject({ bodyTruncated: true });
    expect(byId.get("comment-000")!.body).toHaveLength(4_000);
    expect(byId.get("comment-002")!.body).toBe("Unanswered ask A");
    expect(byId.has("comment-001")).toBe(false);
    expect(window.messages.reduce((sum, m) => sum + m.body.length, 0)).toBe(12_000);
    expect(window.omittedCount).toBe(messages.length - window.messages.length);
    expect(window.truncatedCount).toBeGreaterThanOrEqual(1);
  });

  it("does not treat run-authored or answered user comments as unanswered direction", () => {
    const messages = [
      message(0, human(0, "Answered")),
      message(1),
      message(2, { ...human(2, "Run-authored"), createdByRunId: "run-2" }),
      ...Array.from({ length: 10 }, (_, i) => message(3 + i, { authorId: "other-agent", body: "z" })),
    ];
    const ids = buildRecentContinuationWindow(messages, { originCommentIds: [], agentId: AGENT }).messages.map((m) => m.id);
    expect(ids).toEqual(messages.slice(-8).map((m) => m.id));
  });

  it("reports complete history when nothing was omitted or truncated", () => {
    const messages = [message(0, human(0, "Do the thing")), message(1)];
    const prompt = render(envelope(messages, {
      originCommentIds: [],
      recentWindow: buildRecentContinuationWindow(messages, { originCommentIds: [], agentId: AGENT }),
    }));
    expect(requestContext(prompt).coverage).toMatchObject({ kind: "recent_window", omittedCount: 0 });
    expect(prompt).toContain("History is complete through the coverage cursor.");
    expect(prompt).toContain("- fallback fetch needed: no");
  });

  it("keeps a resumed session's delta unchanged", () => {
    const messages = monitorThread();
    const resumeDelta = { baseRunId: "run-prior", messages: messages.slice(-2) };
    const without = render(envelope(messages, { resumeDelta }), true);
    const withWindow = render(envelope(messages, {
      resumeDelta,
      recentWindow: buildRecentContinuationWindow(messages, { originCommentIds: ["comment-004"], agentId: AGENT }),
    }), true);
    expect(withWindow).toBe(without);
    const context = requestContext(withWindow);
    expect(context.coverage).toMatchObject({ kind: "task_history_delta", baseRunId: "run-prior" });
    expect(context.messages.map((m) => m.id)).toEqual(["comment-205", "comment-206"]);
    expect(withWindow).toContain("- fallback fetch needed: no");
  });

  it("uses the window when a resumed adapter session has no matching delta", () => {
    const messages = monitorThread();
    const prompt = render(envelope(messages, {
      recentWindow: buildRecentContinuationWindow(messages, { originCommentIds: ["comment-004"], agentId: AGENT }),
    }), true);
    expect(requestContext(prompt).coverage.kind).toBe("recent_window");
  });

  it("counts only window messages as delivered", () => {
    const messages = monitorThread();
    const recentWindow = buildRecentContinuationWindow(messages, { originCommentIds: ["comment-004"], agentId: AGENT });
    const delivered = deliveredContinuationCommentIds({ executionContinuation: envelope(messages, { recentWindow }) });
    expect(delivered.known).toBe(true);
    expect([...delivered.ids].sort()).toEqual(recentWindow.messages.map((m) => m.id).sort());
    expect(deliveredContinuationCommentIds({ executionContinuation: envelope(messages) }).ids.size).toBe(207);
  });
});
