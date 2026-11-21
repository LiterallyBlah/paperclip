import { describe, expect, it } from "vitest";
import { statusCardRefreshPolicySchema } from "@paperclipai/shared";
import {
  chooseStatusCardUpdateKind,
  diffStatusCardFingerprint,
  evaluateStatusCardPolicy,
  extractIssueMentions,
  filterStatusCardChanges,
  isWithinStatusCardActiveHours,
  nextStatusCardEvaluationAt,
  STATUS_CARD_REACTIVE_MIN_SPACING_SECONDS,
  statusCardChangesHash,
  statusCardReactiveSpacingSeconds,
} from "../services/status-card-update-engine.js";

describe("status card update engine", () => {
  const defaultPolicy = statusCardRefreshPolicySchema.parse({ mode: "interval", intervalMinutes: 15 });

  it("retains non-terminal and terminal status transitions plus membership changes", () => {
    const changes = diffStatusCardFingerprint({
      churn: { status: "todo", updatedAt: "2026-07-23T10:00:00.000Z", identifier: "PAP-1", title: "Churn" },
      done: { status: "in_progress", updatedAt: "2026-07-23T10:00:00.000Z", identifier: "PAP-2", title: "Done" },
      removed: { status: "blocked", updatedAt: "2026-07-23T10:00:00.000Z", identifier: "PAP-3", title: "Removed" },
    }, {
      churn: { status: "in_progress", updatedAt: "2026-07-23T10:01:00.000Z", identifier: "PAP-1", title: "Churn" },
      done: { status: "done", updatedAt: "2026-07-23T10:01:00.000Z", identifier: "PAP-2", title: "Done" },
      added: { status: "todo", updatedAt: "2026-07-23T10:01:00.000Z", identifier: "PAP-4", title: "Added" },
    });

    expect(filterStatusCardChanges(changes, defaultPolicy).map((change) => [change.identifier, change.changeKind])).toEqual([
      ["PAP-1", "status"],
      ["PAP-2", "status"],
      ["PAP-4", "new"],
      ["PAP-3", "removed"],
    ]);
  });

  it("tracks human comments independently from generic issue updates", () => {
    const previous = {
      issue: { status: "in_progress", updatedAt: "2026-07-23T10:00:00.000Z", latestHumanCommentAt: null, identifier: "PAP-5", title: "Commented" },
    };
    const current = {
      issue: { status: "done", updatedAt: "2026-07-23T10:01:00.000Z", latestHumanCommentAt: "2026-07-23T10:01:00.000Z", identifier: "PAP-5", title: "Commented" },
    };
    const changes = diffStatusCardFingerprint(previous, current);
    expect(changes.map((change) => change.changeKind)).toEqual(["status", "human_comment"]);
    const commentOnlyPolicy = statusCardRefreshPolicySchema.parse({
      mode: "interval",
      intervalMinutes: 15,
      triggers: { statusTransitions: false, assigneeChanges: false, humanComments: true, membershipChanges: false, anyUpdate: false },
    });
    expect(filterStatusCardChanges(changes, commentOnlyPolicy)).toMatchObject([{ identifier: "PAP-5", changeKind: "human_comment" }]);
  });

  it("changes the pending signature when equal-sized change sets are replaced", () => {
    const first = [{ issueId: "one", identifier: "PAP-1", title: "One", from: "todo", to: "done", changeKind: "status" as const }];
    const second = [{ issueId: "two", identifier: "PAP-2", title: "Two", from: "todo", to: "done", changeKind: "status" as const }];
    expect(statusCardChangesHash(first)).not.toBe(statusCardChangesHash(second));
  });

  it("does not schedule background evaluation for manual cards", () => {
    const now = new Date("2026-07-23T14:00:00.000Z");
    const manual = statusCardRefreshPolicySchema.parse({ mode: "manual" });
    const interval = statusCardRefreshPolicySchema.parse({ mode: "interval", intervalMinutes: 15 });
    expect(nextStatusCardEvaluationAt(manual, now)).toBeNull();
    expect(nextStatusCardEvaluationAt(interval, now)).toEqual(new Date("2026-07-23T14:15:00.000Z"));
  });

  it("enforces debounce, hourly rate cap, active hours, and daily token cap", () => {
    const now = new Date("2026-07-23T14:00:30.000Z");
    const reactive = statusCardRefreshPolicySchema.parse({ mode: "reactive", debounceSeconds: 60, maxUpdatesPerHour: 6 });
    expect(evaluateStatusCardPolicy({ policy: reactive, now, lastChangeAt: new Date("2026-07-23T14:00:00.000Z"), updatesLastHour: 0, tokensToday: 0, manual: false }).action).toBe("wait");
    expect(evaluateStatusCardPolicy({ policy: reactive, now, lastChangeAt: new Date("2026-07-23T13:59:00.000Z"), updatesLastHour: 6, tokensToday: 0, manual: false }).action).toBe("wait");
    expect(evaluateStatusCardPolicy({ policy: reactive, now, lastChangeAt: new Date("2026-07-23T13:59:00.000Z"), updatesLastHour: 0, tokensToday: 100_000, manual: false }).action).toBe("pause_budget");
    expect(evaluateStatusCardPolicy({ policy: reactive, now, lastChangeAt: null, updatesLastHour: 99, tokensToday: 999_999, manual: true }).action).toBe("run");

    const hours = statusCardRefreshPolicySchema.parse({ mode: "interval", intervalMinutes: 15, activeHours: { start: "09:00", end: "17:00", timezone: "UTC" } });
    expect(isWithinStatusCardActiveHours(hours, new Date("2026-07-23T16:59:00.000Z"))).toBe(true);
    expect(isWithinStatusCardActiveHours(hours, new Date("2026-07-23T17:00:00.000Z"))).toBe(false);
    expect(evaluateStatusCardPolicy({ policy: hours, now: new Date("2026-07-23T18:00:00.000Z"), lastChangeAt: null, updatesLastHour: 0, tokensToday: 0, manual: false }).action).toBe("pause_hours");
  });

  it("selects full rebuilds for bounded drift rules and incremental otherwise", () => {
    const base = { hasDocument: true, changeCount: 2, queryVersion: 3, lastUpdateQueryVersion: 3, incrementalCount: 2, configurationChanged: false };
    expect(chooseStatusCardUpdateKind(base)).toBe("incremental");
    expect(chooseStatusCardUpdateKind({ ...base, changeCount: 11 })).toBe("full");
    expect(chooseStatusCardUpdateKind({ ...base, queryVersion: 4 })).toBe("full");
    expect(chooseStatusCardUpdateKind({ ...base, incrementalCount: 9 })).toBe("full");
    expect(chooseStatusCardUpdateKind({ ...base, configurationChanged: true })).toBe("full");
    expect(chooseStatusCardUpdateKind({ ...base, explicitFull: true })).toBe("full");
    expect(chooseStatusCardUpdateKind({ ...base, restoreRefresh: true })).toBe("full");
  });

  it("extracts identifier and issue-link mentions from summary markdown", () => {
    const markdown = [
      "**Decide:** [PAP-15357](/issues/PAP-15357) is blocked; PAP-15357 and pap-99 (lowercase) plus SC2-4 moved.",
      "See [the launch issue](/issues/0F5A2C71-9F5C-4B6C-8A9E-1B2C3D4E5F60#comment-1) and /issues/not-a-uuid.",
    ].join("\n");

    expect(extractIssueMentions(markdown)).toEqual({
      identifiers: ["PAP-15357", "SC2-4"],
      issueIds: ["0f5a2c71-9f5c-4b6c-8a9e-1b2c3d4e5f60"],
    });
    expect(extractIssueMentions("No references here.")).toEqual({ identifiers: [], issueIds: [] });
  });
  it("keeps a minimum gap between reactive generations and leaves manual and interval runs alone", () => {
    const reactive = statusCardRefreshPolicySchema.parse({ mode: "reactive", debounceSeconds: 60, maxUpdatesPerHour: 6 });
    expect(STATUS_CARD_REACTIVE_MIN_SPACING_SECONDS).toBe(20 * 60);
    // 3600 / 6 = 10 min is below the 20 min floor; a slower card keeps its own spread.
    expect(statusCardReactiveSpacingSeconds(reactive)).toBe(20 * 60);
    expect(statusCardReactiveSpacingSeconds({ ...reactive, maxUpdatesPerHour: 2 })).toBe(30 * 60);
    expect(statusCardReactiveSpacingSeconds({ ...reactive, maxUpdatesPerHour: undefined })).toBe(20 * 60);

    const lastGeneratedAt = new Date("2026-07-23T14:00:00.000Z");
    const base = { policy: reactive, updatesLastHour: 1, tokensToday: 0, manual: false, lastGeneratedAt };
    // Debounced but inside the spacing window: wait until the window closes.
    expect(evaluateStatusCardPolicy({ ...base, now: new Date("2026-07-23T14:05:00.000Z"), lastChangeAt: new Date("2026-07-23T14:02:00.000Z") }))
      .toEqual({ action: "wait", dueAt: new Date("2026-07-23T14:20:00.000Z") });
    // Window closed but the change set is still settling: the debounce wins.
    expect(evaluateStatusCardPolicy({ ...base, now: new Date("2026-07-23T14:20:30.000Z"), lastChangeAt: new Date("2026-07-23T14:20:00.000Z") }))
      .toEqual({ action: "wait", dueAt: new Date("2026-07-23T14:21:00.000Z") });
    expect(evaluateStatusCardPolicy({ ...base, now: new Date("2026-07-23T14:21:00.000Z"), lastChangeAt: new Date("2026-07-23T14:20:00.000Z") }).action).toBe("run");
    // Never generated: only the debounce applies.
    expect(evaluateStatusCardPolicy({ ...base, lastGeneratedAt: null, now: new Date("2026-07-23T14:01:00.000Z"), lastChangeAt: new Date("2026-07-23T14:00:00.000Z") }).action).toBe("run");
    // Manual refresh and interval cards ignore the spacing.
    expect(evaluateStatusCardPolicy({ ...base, manual: true, now: new Date("2026-07-23T14:01:00.000Z"), lastChangeAt: null }).action).toBe("run");
    const interval = statusCardRefreshPolicySchema.parse({ mode: "interval", intervalMinutes: 15 });
    expect(evaluateStatusCardPolicy({ ...base, policy: interval, now: new Date("2026-07-23T14:01:00.000Z"), lastChangeAt: null }).action).toBe("run");
  });
});
