import type { ActivityEvent } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import {
  assigneeValueFromSelection,
  currentUserAssigneeOption,
  formatAssigneeUserLabel,
  formatUserLabel,
  parseAssigneeValue,
  suggestedCommentAssigneeValue,
} from "./assignees";

describe("assignee selection helpers", () => {
  it("encodes and parses agent assignees", () => {
    const value = assigneeValueFromSelection({ assigneeAgentId: "agent-123" });

    expect(value).toBe("agent:agent-123");
    expect(parseAssigneeValue(value)).toEqual({
      assigneeAgentId: "agent-123",
      assigneeUserId: null,
    });
  });

  it("encodes and parses current-user assignees", () => {
    const [option] = currentUserAssigneeOption("local-board");

    expect(option).toEqual({
      id: "user:local-board",
      label: "Me",
      searchText: "me board human local-board",
    });
    expect(parseAssigneeValue(option.id)).toEqual({
      assigneeAgentId: null,
      assigneeUserId: "local-board",
    });
  });

  it("treats an empty selection as no assignee", () => {
    expect(parseAssigneeValue("")).toEqual({
      assigneeAgentId: null,
      assigneeUserId: null,
    });
  });

  it("keeps backward compatibility for raw agent ids in saved drafts", () => {
    expect(parseAssigneeValue("legacy-agent-id")).toEqual({
      assigneeAgentId: "legacy-agent-id",
      assigneeUserId: null,
    });
  });

  it("formats current and board user labels consistently", () => {
    expect(formatAssigneeUserLabel("user-1", "user-1")).toBe("You");
    expect(formatAssigneeUserLabel("local-board", "someone-else")).toBe("Board");
    expect(formatAssigneeUserLabel("user-abcdef", "someone-else")).toBe("user-");
  });

  it("formats actual user labels without current-user substitution", () => {
    expect(formatUserLabel("user-1", new Map([["user-1", "Dotta"]]))).toBe("Dotta");
    expect(formatUserLabel("user-1", new Map([["user-2", "Someone Else"]]))).toBe("user-");
    expect(formatUserLabel("local-board")).toBe("Board");
  });

  it("suggests the last non-me commenter without changing the actual assignee encoding", () => {
    expect(
      suggestedCommentAssigneeValue(
        { assigneeUserId: "board-user" },
        [
          { authorUserId: "board-user" },
          { authorAgentId: "agent-123" },
        ],
        "board-user",
      ),
    ).toBe("agent:agent-123");
  });

  it("leaves the recipient empty instead of defaulting to the current human", () => {
    expect(
      suggestedCommentAssigneeValue(
        { assigneeUserId: "board-user" },
        [{ authorUserId: "board-user" }],
        "board-user",
      ),
    ).toBe("");
  });

  it("skips the current agent when choosing a suggested commenter assignee", () => {
    expect(
      suggestedCommentAssigneeValue(
        { assigneeUserId: "board-user" },
        [
          { authorUserId: "board-user" },
          { authorAgentId: "agent-self" },
          { authorAgentId: "agent-123" },
        ],
        null,
        "agent-self",
      ),
    ).toBe("agent:agent-123");
  });
});


describe("assignment history suggestions", () => {
  const assignment = (actorId: string, date: string, details: Record<string, unknown> = {}): ActivityEvent => ({
    companyId: "company", entityType: "issue", entityId: "task", agentId: actorId, runId: null,
    id: actorId, actorType: "agent", actorId, action: "issue.updated",
    createdAt: new Date(date), details: { assigneeUserId: "me", _previous: { assigneeUserId: null }, ...details },
  });
  const suggest = (activity: ActivityEvent[]) => suggestedCommentAssigneeValue(
    { assigneeUserId: "me" }, [{ authorAgentId: "commenter" }], "me", undefined, activity,
  );

  it("uses the latest assigning actor in either history order, ahead of commenters", () => {
    const older = assignment("first", "2026-01-01");
    const newer = assignment("last", "2026-02-01");
    expect(suggest([older, newer])).toBe("agent:last");
    expect(suggest([newer, older])).toBe("agent:last");
  });

  it("ignores other recipients, human actors, non-assignment events and unchanged fields", () => {
    const valid = assignment("assigner", "2026-01-01");
    const invalid = assignment("other", "2026-02-01");
    expect(suggest([
      valid,
      { ...invalid, actorType: "user" },
      { ...invalid, action: "issue.comment_added" },
      assignment("other-user", "2026-02-01", { assigneeUserId: "someone-else" }),
      assignment("no-op", "2026-02-01", { _previous: { assigneeUserId: "me" } }),
      assignment("resent", "2026-02-01", { _previous: { status: "todo" } }),
    ])).toBe("agent:assigner");
  });

  it("includes the agent that created a task assigned to the human", () => {
    expect(suggest([{ ...assignment("creator", "2026-01-01"), action: "issue.created" }])).toBe("agent:creator");
  });

  it("keeps the existing commenter fallback and other task defaults", () => {
    expect(suggest([])).toBe("agent:commenter");
    expect(suggestedCommentAssigneeValue({ assigneeAgentId: "owner" }, [], "me")).toBe("agent:owner");
    expect(suggestedCommentAssigneeValue({ assigneeUserId: "someone-else" }, [], "me")).toBe("user:someone-else");
  });
});


it("prefers a newer native reassignment over a REST assignment and ignores native no-ops", () => {
  const event = (actorId: string, action: string, createdAt: string, details: Record<string, unknown>): ActivityEvent => ({
    id: actorId, companyId: "company", entityType: "issue", entityId: "task", agentId: actorId, runId: null,
    actorType: "agent", actorId, action, createdAt: new Date(createdAt), details,
  });
  const history = [
    event("alpha", "issue.updated", "2026-01-01", { assigneeUserId: "me", _previous: { assigneeUserId: null } }),
    event("beta", "issue.reassigned", "2026-02-01", { assigneeUserId: "me", previousAssigneeUserId: null, changed: true }),
    event("no-op", "issue.reassigned", "2026-03-01", { assigneeUserId: "me", previousAssigneeUserId: "me", changed: false }),
  ];
  expect(suggestedCommentAssigneeValue({ assigneeUserId: "me" }, [], "me", undefined, history)).toBe("agent:beta");
});


it.each(["issue.created", "issue.child_created"])("uses a REST %s receipt assigned to the current human", (action) => {
  const event: ActivityEvent = {
    id: "creation", companyId: "company", entityType: "issue", entityId: "task",
    agentId: "creator", runId: null, actorType: "agent", actorId: "creator", action,
    createdAt: new Date("2026-02-01"),
    details: { title: "Task", identifier: "PAP-1", status: "todo", assigneeAgentId: null, assigneeUserId: "me" },
  };
  expect(suggestedCommentAssigneeValue({ assigneeUserId: "me" }, [{ authorAgentId: "commenter" }], "me", undefined, [event])).toBe("agent:creator");
  expect(suggestedCommentAssigneeValue({ assigneeUserId: "other" }, [], "other", undefined, [event])).toBe("");
});

describe("pending native review stage held by the viewer", () => {
  // Shape of a review-cap escalation: the reviewer agent requested changes and
  // the stage was handed to the responsible human.
  const escalatedBy = (actorId: string): ActivityEvent => ({
    id: "escalation", companyId: "company", entityType: "issue", entityId: "task",
    agentId: actorId, runId: null, actorType: "agent", actorId, action: "issue.updated",
    createdAt: new Date("2026-11-11T01:55:36Z"),
    details: { assigneeUserId: "me", _previous: { assigneeUserId: null } },
  });
  const held = {
    status: "in_review",
    assigneeUserId: "me",
    executionState: { status: "pending", currentParticipant: { type: "user", userId: "me" } },
  };

  it("does not default an ordinary reply to reassigning the stage back to the reviewer agent", () => {
    // At 6f18750d this suggested "agent:reviewer", so plain Send re-pended the
    // stage on the agent (the H3 participant move).
    expect(suggestedCommentAssigneeValue(held, [{ authorAgentId: "reviewer" }], "me", undefined, [escalatedBy("reviewer")]))
      .toBe("user:me");
  });

  it("keeps a drifted agent assignee unchanged while the viewer holds the stage", () => {
    expect(suggestedCommentAssigneeValue(
      { ...held, assigneeUserId: null, assigneeAgentId: "worker" },
      [{ authorAgentId: "reviewer" }],
      "me",
    )).toBe("agent:worker");
  });

  it("keeps the existing suggestion when someone else holds the stage or it is not pending", () => {
    const history = [escalatedBy("reviewer")];
    expect(suggestedCommentAssigneeValue(
      { ...held, executionState: { status: "pending", currentParticipant: { type: "user", userId: "other" } } },
      [], "me", undefined, history,
    )).toBe("agent:reviewer");
    expect(suggestedCommentAssigneeValue(
      { ...held, executionState: { status: "changes_requested", currentParticipant: { type: "user", userId: "me" } } },
      [], "me", undefined, history,
    )).toBe("agent:reviewer");
    expect(suggestedCommentAssigneeValue({ ...held, status: "in_progress" }, [], "me", undefined, history))
      .toBe("agent:reviewer");
  });
});
