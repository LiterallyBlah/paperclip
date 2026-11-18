import { describe, expect, it } from "vitest";
import {
  applyIssueExecutionPolicyTransition,
  buildReviewEscalationClaimPatch,
  normalizeIssueExecutionPolicy,
} from "../services/issue-execution-policy.ts";

// BLA-501: the company's review escalation delegate. Synthetic data only. The
// held fixture has the shape of a real exhausted review: a user hold on a
// review stage, count/cap 2/2, one agent reviewer, a prior decision id and the
// Developer as return assignee.
const developerAgentId = "d0000000-0000-4000-8000-000000000001";
const reviewerAgentId = "d0000000-0000-4000-8000-000000000002";
const delegateAgentId = "d0000000-0000-4000-8000-000000000003";
const creatorAgentId = "d0000000-0000-4000-8000-000000000004";
const otherAgentId = "d0000000-0000-4000-8000-000000000005";
const escalatedUserId = "synthetic-board-user";
const otherUserId = "synthetic-other-user";
const priorDecisionId = "d0000000-0000-4000-8000-0000000000aa";

const policy = normalizeIssueExecutionPolicy({
  stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewerAgentId }] }],
  maxReviewRounds: 2,
})!;
const stageId = policy.stages[0]!.id;

const agent = (agentId: string) => ({ type: "agent" as const, agentId, userId: null });
const user = (userId: string) => ({ type: "user" as const, agentId: null, userId });

type Issue = Record<string, unknown> & { executionState: Record<string, unknown> | null };

/** A user hold left by the cap escalation (no escalation marker, as written by the PRE release). */
function userHeldIssue(overrides: Partial<Issue> = {}, stateOverrides: Record<string, unknown> = {}): Issue {
  return {
    id: "issue-1",
    companyId: "company-1",
    status: "in_review",
    assigneeAgentId: null,
    assigneeUserId: escalatedUserId,
    createdByAgentId: null,
    createdByUserId: escalatedUserId,
    responsibleUserId: escalatedUserId,
    executionPolicy: policy,
    executionState: {
      status: "pending",
      currentStageId: stageId,
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: user(escalatedUserId),
      returnAssignee: agent(developerAgentId),
      reviewRequest: null,
      completedStageIds: [],
      lastDecisionId: priorDecisionId,
      lastDecisionOutcome: "changes_requested",
      changesRequestedCount: 2,
      ...stateOverrides,
    },
    ...overrides,
  };
}

function withPatch(issue: Issue, patch: Record<string, unknown>): Issue {
  return { ...issue, ...patch } as Issue;
}

/** Persist a decision the way the PATCH route does (it stamps a fresh lastDecisionId). */
function withDecision(issue: Issue, patch: Record<string, unknown>, decisionId: string): Issue {
  return withPatch(issue, {
    ...patch,
    executionState: { ...(patch.executionState as Record<string, unknown>), lastDecisionId: decisionId },
  });
}

function transition(
  issue: Issue,
  input: {
    actor: { agentId?: string | null; userId?: string | null };
    requestedStatus?: string;
    requestedAssigneePatch?: { assigneeAgentId?: string | null; assigneeUserId?: string | null };
    commentBody?: string | null;
    delegate?: string | null;
    allowBoardOverride?: boolean;
  },
) {
  return applyIssueExecutionPolicyTransition({
    issue: issue as never,
    policy,
    previousPolicy: policy,
    requestedStatus: input.requestedStatus,
    requestedAssigneePatch: input.requestedAssigneePatch ?? {},
    actor: input.actor,
    commentBody: input.commentBody ?? null,
    allowBoardOverride: input.allowBoardOverride,
    reviewEscalationDelegateAgentId: input.delegate === undefined ? delegateAgentId : input.delegate,
  });
}

function claim(issue: Issue, actor: { agentId?: string | null; userId?: string | null }, delegate: string | null = delegateAgentId) {
  return buildReviewEscalationClaimPatch({
    issue: issue as never,
    policy,
    actor,
    reviewEscalationDelegateAgentId: delegate,
  });
}

function expectHoldGuard422(fn: () => unknown, message?: RegExp) {
  try {
    fn();
  } catch (error) {
    expect((error as { status?: number }).status).toBe(422);
    if (message) expect((error as Error).message).toMatch(message);
    return;
  }
  throw new Error("expected a 422");
}

function claimedIssue() {
  const held = userHeldIssue();
  return withPatch(held, claim(held, { agentId: delegateAgentId }).patch);
}

/** An agent reviewer's pass at count 1 of cap 2 (the next request-changes reaches the cap). */
function reviewerPassTwoIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    ...userHeldIssue(),
    assigneeAgentId: reviewerAgentId,
    assigneeUserId: null,
    createdByAgentId: creatorAgentId,
    executionState: {
      ...userHeldIssue().executionState!,
      currentParticipant: agent(reviewerAgentId),
      changesRequestedCount: 1,
    },
    ...overrides,
  };
}

describe("BLA-501 review escalation delegate: BLA-433-shaped exhausted user hold", () => {
  it("claim, request changes, resubmission to the delegate and approval keep the count at 2", () => {
    const held = userHeldIssue();
    const claimed = claim(held, { agentId: delegateAgentId });
    // The claim moves only the hold.
    expect(claimed.patch).toEqual({
      status: "in_review",
      assigneeAgentId: delegateAgentId,
      assigneeUserId: null,
      executionState: {
        ...held.executionState,
        currentParticipant: agent(delegateAgentId),
        escalationHolder: agent(delegateAgentId),
      },
    });
    expect(claimed.patch.executionState).toMatchObject({
      currentStageId: stageId,
      changesRequestedCount: 2,
      returnAssignee: agent(developerAgentId),
      lastDecisionId: priorDecisionId,
      lastDecisionOutcome: "changes_requested",
    });
    let issue = withPatch(held, claimed.patch);

    // Delegate requests changes: back to the Developer, count unchanged.
    const requestChanges = transition(issue, {
      actor: { agentId: delegateAgentId },
      requestedStatus: "in_progress",
      commentBody: "Delegate: please fix the finding.",
    });
    expect(requestChanges.decision).toMatchObject({ stageId, outcome: "changes_requested" });
    expect(requestChanges.patch).toMatchObject({
      status: "in_progress",
      assigneeAgentId: developerAgentId,
      assigneeUserId: null,
      executionState: {
        status: "changes_requested",
        currentStageId: stageId,
        currentParticipant: agent(delegateAgentId),
        returnAssignee: agent(developerAgentId),
        changesRequestedCount: 2,
      },
    });
    issue = withDecision(issue, requestChanges.patch, "d0000000-0000-4000-8000-0000000000b0");

    // Two correction cycles: each resubmission goes to the delegate, never the reviewer.
    for (const cycle of [1, 2]) {
      const resubmit = transition(issue, { actor: { agentId: developerAgentId }, requestedStatus: "in_review" });
      expect(resubmit.decision).toBeUndefined();
      expect(resubmit.patch).toMatchObject({
        status: "in_review",
        assigneeAgentId: delegateAgentId,
        assigneeUserId: null,
        executionState: {
          status: "pending",
          currentStageId: stageId,
          currentParticipant: agent(delegateAgentId),
          escalationHolder: agent(delegateAgentId),
          returnAssignee: agent(developerAgentId),
          changesRequestedCount: 2,
        },
      });
      issue = withPatch(issue, resubmit.patch);
      if (cycle === 1) {
        const again = transition(issue, {
          actor: { agentId: delegateAgentId },
          requestedStatus: "in_progress",
          commentBody: "Delegate: one more change.",
        });
        expect(again.patch).toMatchObject({
          status: "in_progress",
          assigneeAgentId: developerAgentId,
          executionState: { status: "changes_requested", changesRequestedCount: 2 },
        });
        issue = withDecision(issue, again.patch, "d0000000-0000-4000-8000-0000000000b1");
      }
    }

    // Delegate approves: the stage completes normally under the delegate's decision.
    const approve = transition(issue, {
      actor: { agentId: delegateAgentId },
      requestedStatus: "done",
      commentBody: "Delegate: approved.",
    });
    expect(approve.decision).toMatchObject({ stageId, outcome: "approved" });
    expect(approve.patch.executionState).toMatchObject({
      status: "completed",
      completedStageIds: [stageId],
      lastDecisionOutcome: "approved",
    });
    expect(approve.patch.assigneeUserId).toBeUndefined();
  });

  it("accepts a user hold that carries the escalation marker for that same user", () => {
    const held = userHeldIssue({}, { escalationHolder: user(escalatedUserId) });
    expect(claim(held, { agentId: delegateAgentId }).patch.executionState.escalationHolder).toEqual(agent(delegateAgentId));
  });
});

describe("BLA-501 claim refusals (422, no state change)", () => {
  const cases: Array<[string, () => Issue, { agentId?: string | null; userId?: string | null }, string | null]> = [
    ["no delegate configured", () => userHeldIssue(), { agentId: delegateAgentId }, null],
    ["the implementer", () => userHeldIssue(), { agentId: developerAgentId }, delegateAgentId],
    ["the configured reviewer", () => userHeldIssue(), { agentId: reviewerAgentId }, delegateAgentId],
    ["another agent", () => userHeldIssue(), { agentId: otherAgentId }, delegateAgentId],
    ["the escalated user", () => userHeldIssue(), { userId: escalatedUserId }, delegateAgentId],
    ["another user", () => userHeldIssue(), { userId: otherUserId }, delegateAgentId],
    ["a non-exhausted stage", () => userHeldIssue({}, { changesRequestedCount: 1 }), { agentId: delegateAgentId }, delegateAgentId],
    ["an issue not in_review", () => userHeldIssue({ status: "in_progress" }), { agentId: delegateAgentId }, delegateAgentId],
    ["a stage that is not pending", () => userHeldIssue({}, { status: "changes_requested" }), { agentId: delegateAgentId }, delegateAgentId],
    ["an agent hold", () => userHeldIssue({}, { currentParticipant: agent(creatorAgentId), escalationHolder: agent(creatorAgentId) }), { agentId: delegateAgentId }, delegateAgentId],
    ["a marker naming a different holder", () => userHeldIssue({}, { escalationHolder: user(otherUserId) }), { agentId: delegateAgentId }, delegateAgentId],
    ["a delegate that is the implementer", () => userHeldIssue(), { agentId: developerAgentId }, developerAgentId],
    ["a delegate that is the reviewer", () => userHeldIssue(), { agentId: reviewerAgentId }, reviewerAgentId],
    ["an already claimed hold", () => claimedIssue(), { agentId: delegateAgentId }, delegateAgentId],
  ];

  it.each(cases)("refuses %s", (_label, build, actor, delegate) => {
    const issue = build();
    const before = structuredClone(issue);
    expectHoldGuard422(() => claim(issue, actor, delegate), /review escalation delegate/);
    expect(issue).toEqual(before);
  });

  it("refuses an approval stage with the approval policy itself", () => {
    const approvalPolicy = normalizeIssueExecutionPolicy({
      stages: [{ type: "approval", participants: [{ type: "agent", agentId: reviewerAgentId }] }],
      maxReviewRounds: 2,
    })!;
    const issue = userHeldIssue({ executionPolicy: approvalPolicy }, {
      currentStageId: approvalPolicy.stages[0]!.id,
      currentStageType: "approval",
    });
    expectHoldGuard422(() => buildReviewEscalationClaimPatch({
      issue: issue as never, policy: approvalPolicy, actor: { agentId: delegateAgentId },
      reviewEscalationDelegateAgentId: delegateAgentId,
    }));
  });

  it("refuses a participant who is a configured user reviewer of the stage", () => {
    const userStagePolicy = normalizeIssueExecutionPolicy({
      stages: [{ type: "review", participants: [{ type: "user", userId: escalatedUserId }] }],
      maxReviewRounds: 2,
    })!;
    const issue = userHeldIssue({ executionPolicy: userStagePolicy }, { currentStageId: userStagePolicy.stages[0]!.id });
    expectHoldGuard422(() => buildReviewEscalationClaimPatch({
      issue: issue as never, policy: userStagePolicy, actor: { agentId: delegateAgentId },
      reviewEscalationDelegateAgentId: delegateAgentId,
    }));
  });
});

describe("BLA-501 denied actors on a delegate hold", () => {
  const advanceAttempts: Array<{ requestedStatus?: string; requestedAssigneePatch?: Record<string, string | null> }> = [
    { requestedStatus: "done" },
    { requestedStatus: "in_progress" },
    { requestedStatus: "todo" },
    { requestedAssigneePatch: { assigneeAgentId: otherAgentId } },
    { requestedAssigneePatch: { assigneeAgentId: null, assigneeUserId: escalatedUserId } },
  ];
  const deniedActors: Array<[string, { agentId?: string | null; userId?: string | null }, boolean]> = [
    ["implementer", { agentId: developerAgentId }, false],
    ["configured reviewer", { agentId: reviewerAgentId }, false],
    ["other agent", { agentId: otherAgentId }, false],
    ["previously escalated user", { userId: escalatedUserId }, false],
    ["previously escalated user as board", { userId: escalatedUserId }, true],
    ["other user", { userId: otherUserId }, false],
  ];

  for (const [label, actor, board] of deniedActors) {
    it.each(advanceAttempts)(`${label} cannot advance or decide: %o`, (attempt) => {
      const issue = claimedIssue();
      const before = structuredClone(issue);
      expectHoldGuard422(() => transition(issue, {
        actor,
        allowBoardOverride: board,
        commentBody: "attempt",
        ...attempt,
      }), /Only the escalated reviewer can advance/);
      expect(issue).toEqual(before);
    });
  }

  it("an implementer resubmission while the delegate holds the stage changes nothing", () => {
    const issue = claimedIssue();
    const result = transition(issue, { actor: { agentId: developerAgentId }, requestedStatus: "in_review" });
    expect(result.patch).toEqual({});
  });

  it("re-asserts a drifted delegate hold without touching count or decision history", () => {
    const issue = withPatch(claimedIssue(), { status: "in_progress", assigneeAgentId: developerAgentId });
    const result = transition(issue, { actor: { agentId: developerAgentId }, commentBody: "comment only" });
    expect(result.patch).toMatchObject({
      status: "in_review",
      assigneeAgentId: delegateAgentId,
      executionState: {
        currentParticipant: agent(delegateAgentId),
        escalationHolder: agent(delegateAgentId),
        changesRequestedCount: 2,
        lastDecisionId: priorDecisionId,
      },
    });
  });

  it("no transition of a delegate hold sets executionState to null or resets the count", () => {
    const issue = claimedIssue();
    const attempts = [
      { actor: { agentId: delegateAgentId }, requestedStatus: "in_progress", commentBody: "rc" },
      { actor: { agentId: delegateAgentId }, requestedStatus: "in_review" },
      { actor: { agentId: delegateAgentId } },
      { actor: { agentId: developerAgentId }, requestedStatus: "in_review" },
      { actor: { agentId: developerAgentId } },
    ];
    for (const attempt of attempts) {
      const result = transition(issue, attempt);
      if ("executionState" in result.patch) {
        expect(result.patch.executionState).not.toBeNull();
        expect((result.patch.executionState as { changesRequestedCount?: number }).changesRequestedCount).toBe(2);
      }
    }
  });
});

describe("BLA-501 new cap escalations with a delegate", () => {
  it("hands an agent reviewer's capped request-changes to the delegate, ahead of the creator agent", () => {
    const issue = reviewerPassTwoIssue();
    const result = transition(issue, {
      actor: { agentId: reviewerAgentId },
      requestedStatus: "in_progress",
      commentBody: "Reviewer pass 2 of 2",
    });
    expect(result.decision).toMatchObject({ outcome: "changes_requested" });
    expect(result.patch).toMatchObject({
      status: "in_review",
      assigneeAgentId: delegateAgentId,
      assigneeUserId: null,
      executionState: {
        status: "pending",
        currentParticipant: agent(delegateAgentId),
        escalationHolder: agent(delegateAgentId),
        returnAssignee: agent(developerAgentId),
        changesRequestedCount: 2,
      },
    });
    // The delegate then returns the work with the count unchanged.
    const held = withDecision(issue, result.patch, "d0000000-0000-4000-8000-0000000000b2");
    const back = transition(held, {
      actor: { agentId: delegateAgentId },
      requestedStatus: "in_progress",
      commentBody: "Delegate request changes",
    });
    expect(back.patch).toMatchObject({
      status: "in_progress",
      assigneeAgentId: developerAgentId,
      executionState: { status: "changes_requested", changesRequestedCount: 2 },
    });
  });

  it.each([
    ["the implementer", developerAgentId],
    ["the stage reviewer", reviewerAgentId],
  ])("falls back to the default route when the delegate is %s", (_label, delegate) => {
    const issue = reviewerPassTwoIssue();
    const withDelegate = transition(issue, {
      actor: { agentId: reviewerAgentId }, requestedStatus: "in_progress", commentBody: "rc", delegate,
    });
    const withoutDelegate = transition(issue, {
      actor: { agentId: reviewerAgentId }, requestedStatus: "in_progress", commentBody: "rc", delegate: null,
    });
    expect(withDelegate).toEqual(withoutDelegate);
    // Default route: the creator agent (BLA-293).
    expect(withDelegate.patch).toMatchObject({
      assigneeAgentId: creatorAgentId,
      executionState: { escalationHolder: agent(creatorAgentId) },
    });
  });

  it("does not route approval-stage caps to the delegate", () => {
    const approvalPolicy = normalizeIssueExecutionPolicy({
      stages: [{ type: "approval", participants: [{ type: "agent", agentId: reviewerAgentId }] }],
      maxReviewRounds: 2,
    })!;
    const issue = reviewerPassTwoIssue({
      executionPolicy: approvalPolicy,
      executionState: {
        ...reviewerPassTwoIssue().executionState!,
        currentStageId: approvalPolicy.stages[0]!.id,
        currentStageType: "approval",
      },
    });
    const run = (delegate: string | null) => applyIssueExecutionPolicyTransition({
      issue: issue as never, policy: approvalPolicy, previousPolicy: approvalPolicy, requestedStatus: "in_progress",
      requestedAssigneePatch: {}, actor: { agentId: reviewerAgentId }, commentBody: "rc",
      reviewEscalationDelegateAgentId: delegate,
    });
    expect(run(delegateAgentId)).toEqual(run(null));
  });
});

describe("BLA-501 default unchanged without a delegate", () => {
  const scenarios: Array<[string, () => Issue, Parameters<typeof transition>[1]]> = [
    ["capped reviewer request-changes (creator agent route)", () => reviewerPassTwoIssue(),
      { actor: { agentId: reviewerAgentId }, requestedStatus: "in_progress", commentBody: "rc" }],
    ["capped reviewer request-changes (human route)", () => reviewerPassTwoIssue({ createdByAgentId: null }),
      { actor: { agentId: reviewerAgentId }, requestedStatus: "in_progress", commentBody: "rc" }],
    ["user hold decision by the escalated user", () => userHeldIssue(),
      { actor: { userId: escalatedUserId }, requestedStatus: "in_progress", commentBody: "rc" }],
    ["user hold advance by an agent", () => userHeldIssue(),
      { actor: { agentId: developerAgentId }, requestedStatus: "done", commentBody: "x" }],
    ["resubmission after capped changes", () => withPatch(userHeldIssue(), {
      status: "in_progress", assigneeAgentId: developerAgentId, assigneeUserId: null,
      executionState: { ...userHeldIssue().executionState!, status: "changes_requested", currentParticipant: agent(delegateAgentId) },
    }), { actor: { agentId: developerAgentId }, requestedStatus: "in_review" }],
  ];

  it.each(scenarios)("%s: an absent delegate equals null equals the PRE call", (_label, build, input) => {
    const outcome = (delegate: string | null | undefined) => {
      try {
        return applyIssueExecutionPolicyTransition({
          issue: build() as never, policy, previousPolicy: policy, requestedStatus: input.requestedStatus,
          requestedAssigneePatch: input.requestedAssigneePatch ?? {}, actor: input.actor,
          commentBody: input.commentBody ?? null,
          ...(delegate === undefined ? {} : { reviewEscalationDelegateAgentId: delegate }),
        });
      } catch (error) {
        return { error: (error as Error).message, status: (error as { status?: number }).status };
      }
    };
    expect(outcome(null)).toEqual(outcome(undefined));
  });

  it("without a delegate a resubmission after capped changes opens a configured-reviewer round", () => {
    const issue = withPatch(userHeldIssue(), {
      status: "in_progress", assigneeAgentId: developerAgentId, assigneeUserId: null,
      executionState: { ...userHeldIssue().executionState!, status: "changes_requested", currentParticipant: agent(delegateAgentId) },
    });
    expect(transition(issue, { actor: { agentId: developerAgentId }, requestedStatus: "in_review", delegate: null }).patch)
      .toMatchObject({ assigneeAgentId: reviewerAgentId });
    // A delegate that is not the recorded participant does not capture it either.
    expect(transition(issue, { actor: { agentId: developerAgentId }, requestedStatus: "in_review", delegate: otherAgentId }).patch)
      .toMatchObject({ assigneeAgentId: reviewerAgentId });
  });

  it("an existing creator-agent hold keeps its reset-to-zero decision when the delegate is a different agent", () => {
    const issue = reviewerPassTwoIssue();
    const held = withDecision(issue, transition(issue, {
      actor: { agentId: reviewerAgentId }, requestedStatus: "in_progress", commentBody: "rc", delegate: null,
    }).patch, "d0000000-0000-4000-8000-0000000000b2");
    const result = transition(held, {
      actor: { agentId: creatorAgentId }, requestedStatus: "in_progress", commentBody: "creator rc",
    });
    expect(result.patch.executionState).toMatchObject({ status: "changes_requested", changesRequestedCount: 0 });
  });
});

describe("BLA-501 an in-flight delegate hold after the delegate is cleared (rollback semantics)", () => {
  it("stays held by the agent; only that agent can decide, and its request-changes resets the count as for any escalation holder", () => {
    const issue = claimedIssue();
    // Other actors are still refused by the existing hold guard.
    expectHoldGuard422(() => transition(issue, {
      actor: { agentId: developerAgentId }, requestedStatus: "done", commentBody: "x", delegate: null,
    }), /Only the escalated reviewer can advance/);
    // The former delegate can still approve.
    expect(transition(issue, {
      actor: { agentId: delegateAgentId }, requestedStatus: "done", commentBody: "ok", delegate: null,
    }).decision).toMatchObject({ outcome: "approved" });
    // Its request-changes follows the PRE escalation-holder rule: count back to 0.
    expect(transition(issue, {
      actor: { agentId: delegateAgentId }, requestedStatus: "in_progress", commentBody: "rc", delegate: null,
    }).patch.executionState).toMatchObject({ status: "changes_requested", changesRequestedCount: 0 });
  });
});
