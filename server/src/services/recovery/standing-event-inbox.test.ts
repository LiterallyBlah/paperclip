import { describe, expect, it } from "vitest";
import { normalizeIssueExecutionPolicy } from "../issue-execution-policy.js";
import { decideRunLivenessContinuation } from "./run-liveness-continuations.js";
import { decideSuccessfulRunHandoff } from "./successful-run-handoff.js";
import {
  hasStandingEventInboxMarker,
  isStandingEventInbox,
  isStandingEventInboxQuietRun,
  isStandingEventInboxQuietWait,
} from "./standing-event-inbox.js";

const marker = { mode: "normal", commentRequired: true, stages: [], standingEventInbox: true };

const issue = (overrides: Record<string, unknown> = {}) => ({
  id: "issue-1",
  companyId: "company-1",
  identifier: "PAP-1",
  title: "Synthetic inbox",
  description: "Synthetic fixture.",
  originKind: "manual",
  status: "in_progress",
  assigneeAgentId: "agent-1",
  assigneeUserId: null,
  executionState: null,
  executionPolicy: marker,
  projectId: null,
  ...overrides,
}) as any;

const run = (overrides: Record<string, unknown> = {}) => ({
  id: "run-1",
  companyId: "company-1",
  agentId: "agent-1",
  status: "succeeded",
  runtimeMode: "native",
  nativePhase: null,
  completionContractId: null,
  continuationAttempt: 0,
  contextSnapshot: { issueId: "issue-1" },
  ...overrides,
}) as any;

const agent = { id: "agent-1", companyId: "company-1", status: "idle" } as any;

describe("standing event inbox marker", () => {
  it("is explicit and never inferred from text or origin", () => {
    expect(hasStandingEventInboxMarker(issue())).toBe(true);
    expect(hasStandingEventInboxMarker(issue({ executionPolicy: null, title: "standing event inbox", description: "standingEventInbox: true" }))).toBe(false);
    expect(hasStandingEventInboxMarker(issue({ executionPolicy: { ...marker, standingEventInbox: "true" } }))).toBe(false);
    expect(hasStandingEventInboxMarker(issue({ executionPolicy: null, originKind: "plugin:notifier" }))).toBe(false);
  });

  it("applies only to agent-owned todo/in_progress issues", () => {
    expect(isStandingEventInbox(issue())).toBe(true);
    expect(isStandingEventInbox(issue({ status: "todo" }))).toBe(true);
    for (const status of ["backlog", "blocked", "in_review", "done", "cancelled"]) {
      expect(isStandingEventInbox(issue({ status }))).toBe(false);
    }
    expect(isStandingEventInbox(issue({ assigneeAgentId: null }))).toBe(false);
    expect(isStandingEventInbox(issue({ assigneeUserId: "user-1" }))).toBe(false);
  });

  it("treats only successful runs and system cancellations as quiet", () => {
    expect(isStandingEventInboxQuietRun({ status: "succeeded" })).toBe(true);
    expect(isStandingEventInboxQuietRun({ status: "cancelled", errorCode: "issue_continuation_waiting_on_review" })).toBe(true);
    expect(isStandingEventInboxQuietRun({ status: "cancelled", errorCode: "legacy_disposition_repair_suppressed" })).toBe(true);
    for (const failed of [
      { status: "failed", errorCode: "adapter_failed" },
      { status: "timed_out", errorCode: "timeout" },
      { status: "interrupted", errorCode: null },
      { status: "cancelled", errorCode: "cancelled" },
      { status: "cancelled", errorCode: null },
      { status: "running" },
      { status: "queued" },
    ]) {
      expect(isStandingEventInboxQuietRun(failed)).toBe(false);
      expect(isStandingEventInboxQuietWait(issue(), failed)).toBe(false);
    }
    expect(isStandingEventInboxQuietRun(null)).toBe(false);
  });

  it("survives policy normalization and is dropped when not set", () => {
    expect(normalizeIssueExecutionPolicy({ standingEventInbox: true })).toMatchObject({ standingEventInbox: true, stages: [] });
    expect(normalizeIssueExecutionPolicy({ standingEventInbox: false })).toBeNull();
    expect(normalizeIssueExecutionPolicy({})).toBeNull();
    const withMonitor = normalizeIssueExecutionPolicy({
      standingEventInbox: true,
      monitor: { nextCheckAt: new Date(Date.now() + 3_600_000).toISOString(), notes: "daily" },
    });
    expect(withMonitor).toMatchObject({ standingEventInbox: true, monitor: { notes: "daily" } });
  });
});

describe("native run-liveness continuation", () => {
  const decide = (overrides: Partial<Parameters<typeof decideRunLivenessContinuation>[0]> = {}) =>
    decideRunLivenessContinuation({
      run: run(),
      issue: issue(),
      agent,
      livenessState: "plan_only",
      livenessReason: "Nothing to do",
      nextAction: null,
      budgetBlocked: false,
      idempotentWakeExists: false,
      ...overrides,
    });

  it("skips a quiet successful run on a marked inbox", () => {
    expect(decide()).toEqual({ kind: "skip", reason: "standing event inbox waits for delivered events" });
  });

  it("still continues unmarked issues and failed runs on marked inboxes", () => {
    expect(decide({ issue: issue({ executionPolicy: null }) }).kind).toBe("enqueue");
    expect(decide({ run: run({ status: "failed", errorCode: "adapter_failed" }) }).kind).toBe("enqueue");
  });
});

describe("successful-run handoff", () => {
  const decide = (overrides: Partial<Parameters<typeof decideSuccessfulRunHandoff>[0]> = {}) =>
    decideSuccessfulRunHandoff({
      run: run({ runtimeMode: "legacy" }),
      issue: issue(),
      agent,
      livenessState: "advanced",
      detectedProgressSummary: "Run produced concrete action evidence: 1 issue comment(s)",
      finalReport: "Handled the notice.",
      nextAction: null,
      taskKey: "issue-1",
      hasActiveExecutionPath: false,
      hasQueuedWake: false,
      hasPendingInteractionOrApproval: false,
      hasPersistedMonitor: false,
      hasExplicitBlockerPath: false,
      hasOpenRecoveryIssue: false,
      hasPauseHold: false,
      hasActiveRoutineContinuation: false,
      budgetBlocked: false,
      idempotentWakeExists: false,
      ...overrides,
    });

  it("skips a marked inbox and still queues an unmarked issue", () => {
    expect(decide()).toEqual({ kind: "skip", reason: "standing event inbox waits for delivered events" });
    expect(decide({ issue: issue({ executionPolicy: null }) }).kind).toBe("enqueue");
  });
});
