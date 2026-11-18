import { describe, expect, it } from "vitest";
import { HttpError } from "../errors.ts";
import {
  applyIssueExecutionPolicyTransition,
  buildReturnToExecutorPatch,
  normalizeIssueExecutionPolicy,
} from "../services/issue-execution-policy.ts";

// Count-preserving return of a pending agent review to its executor, with no
// decision. Synthetic fixture: in_review, pending review stage 0 held by an
// agent reviewer, changesRequestedCount 2 of maxReviewRounds 3, last outcome
// changes_requested, an agent return assignee, no blocker, no live run.
const companyId = "company-1";
const issueId = "issue-1";
const managerAgentId = "b0000001-0000-4000-8000-000000000001";
const developerAgentId = "b0000002-0000-4000-8000-000000000002";
const reviewerAgentId = "b0000003-0000-4000-8000-000000000003";
const delegateAgentId = "b0000004-0000-4000-8000-000000000004";
const implementerUserId = "implementer-user-1";
const lastDecisionId = "b0000005-0000-4000-8000-000000000005";
const earlierStageId = "b0000006-0000-4000-8000-000000000006";

const policy = normalizeIssueExecutionPolicy({
  stages: [
    { type: "review", participants: [{ type: "agent", agentId: reviewerAgentId }] },
    { type: "approval", participants: [{ type: "user", userId: "approver-user-1" }] },
  ],
  maxReviewRounds: 3,
  commentRequired: true,
})!;
const reviewStageId = policy.stages[0]!.id;
const policySnapshot = JSON.stringify(policy);

const agentReturnAssignee = { type: "agent" as const, agentId: developerAgentId, userId: null };
const reviewerPrincipal = { type: "agent" as const, agentId: reviewerAgentId, userId: null };

function pendingReviewState(overrides: Record<string, unknown> = {}) {
  return {
    status: "pending",
    currentStageId: reviewStageId,
    currentStageIndex: 0,
    currentStageType: "review",
    currentParticipant: reviewerPrincipal,
    returnAssignee: agentReturnAssignee,
    reviewRequest: { instructions: "Check the parity commit." },
    completedStageIds: [],
    lastDecisionId,
    lastDecisionOutcome: "changes_requested",
    monitor: null,
    changesRequestedCount: 2,
    ...overrides,
  };
}

function fixtureIssue(overrides: Record<string, unknown> = {}, stateOverrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    companyId,
    status: "in_review",
    assigneeAgentId: reviewerAgentId,
    assigneeUserId: null,
    createdByAgentId: managerAgentId,
    createdByUserId: null,
    responsibleUserId: null,
    executionPolicy: policy,
    executionState: pendingReviewState(stateOverrides),
    ...overrides,
  };
}

const board = { type: "board" as const, userId: "board-user-1" };
const delegate = { type: "review_escalation_delegate" as const, agentId: delegateAgentId };

function returnToExecutor(issue = fixtureIssue(), extra: Partial<Parameters<typeof buildReturnToExecutorPatch>[0]> = {}) {
  return buildReturnToExecutorPatch({
    issue,
    policy,
    authority: board,
    expectedStageId: reviewStageId,
    ...extra,
  });
}

function withPatch<T extends Record<string, unknown>>(issue: T, patch: Record<string, unknown>): T {
  return { ...issue, ...patch };
}

function expectHttpError(fn: () => unknown, status: number, details: Record<string, unknown>) {
  let error: unknown;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(HttpError);
  expect((error as HttpError).status).toBe(status);
  expect((error as HttpError).details).toMatchObject(details);
}

function implementerResubmits(issue: Record<string, unknown>, actor: { agentId?: string; userId?: string }) {
  return applyIssueExecutionPolicyTransition({
    issue: issue as never,
    policy,
    previousPolicy: policy,
    requestedStatus: "in_review",
    requestedAssigneePatch: {},
    actor,
  });
}

function reviewerRequestsChanges(issue: Record<string, unknown>) {
  return applyIssueExecutionPolicyTransition({
    issue: issue as never,
    policy,
    previousPolicy: policy,
    requestedStatus: "in_progress",
    requestedAssigneePatch: {},
    actor: { agentId: reviewerAgentId },
    commentBody: "Changes requested.",
  });
}

describe("return to executor: result (criterion 2)", () => {
  it("moves the issue to in_progress under the return assignee and keeps the cycle", () => {
    const issue = fixtureIssue();
    const before = structuredClone(issue);
    const result = returnToExecutor(issue);

    expect(result.patch).toEqual({
      status: "in_progress",
      assigneeAgentId: developerAgentId,
      assigneeUserId: null,
      executionState: {
        status: "changes_requested",
        currentStageId: reviewStageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: reviewerPrincipal,
        returnAssignee: agentReturnAssignee,
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId,
        lastDecisionOutcome: "changes_requested",
        monitor: null,
        changesRequestedCount: 2,
      },
    });
    expect(result.stage.id).toBe(reviewStageId);
    expect(result.previousParticipant).toEqual(reviewerPrincipal);
    expect(result.returnAssignee).toEqual(agentReturnAssignee);
    // The input issue and the policy are not mutated, and no policy is returned.
    expect(issue).toEqual(before);
    expect(JSON.stringify(policy)).toBe(policySnapshot);
    expect(Object.keys(result.patch)).not.toContain("executionPolicy");
  });

  it("does not overwrite a last decision outcome other than changes_requested", () => {
    const result = returnToExecutor(fixtureIssue({}, { lastDecisionOutcome: null, lastDecisionId: null, changesRequestedCount: 0 }));
    expect(result.patch.executionState).toMatchObject({
      status: "changes_requested",
      lastDecisionOutcome: null,
      lastDecisionId: null,
      changesRequestedCount: 0,
    });
  });

  it("keeps a scheduled monitor and completed stages unchanged", () => {
    const monitor = {
      status: "scheduled",
      nextCheckAt: "2026-11-19T10:00:00.000Z",
      lastTriggeredAt: null,
      attemptCount: 1,
      notes: "check back",
      scheduledBy: "assignee",
      clearedAt: null,
      clearReason: null,
    };
    const result = returnToExecutor(fixtureIssue({}, { monitor, completedStageIds: [earlierStageId] }));
    expect(result.patch.executionState.monitor).toMatchObject(monitor);
    expect(result.patch.executionState.completedStageIds).toEqual([earlierStageId]);
  });

  it("assigns a user return assignee", () => {
    const userReturn = { type: "user" as const, agentId: null, userId: implementerUserId };
    const result = returnToExecutor(fixtureIssue({}, { returnAssignee: userReturn, changesRequestedCount: 0 }));
    expect(result.patch).toMatchObject({ status: "in_progress", assigneeAgentId: null, assigneeUserId: implementerUserId });
    expect(result.patch.executionState).toMatchObject({ returnAssignee: userReturn, changesRequestedCount: 0 });
  });

  it("accepts a matching expected count and the delegate authority", () => {
    expect(returnToExecutor(fixtureIssue(), { expectedChangesRequestedCount: 2 }).patch.status).toBe("in_progress");
    expect(returnToExecutor(fixtureIssue(), { authority: delegate }).patch.status).toBe("in_progress");
  });
});

describe("return to executor: resubmission and later decisions (criterion 3)", () => {
  it("re-pends the same stage with the same participant and count, with no decision", () => {
    const returned = withPatch(fixtureIssue(), returnToExecutor().patch);
    const resubmitted = implementerResubmits(returned, { agentId: developerAgentId });

    expect(resubmitted.decision).toBeUndefined();
    expect(resubmitted.patch).toMatchObject({ status: "in_review", assigneeAgentId: reviewerAgentId, assigneeUserId: null });
    expect(resubmitted.patch.executionState).toEqual({
      ...pendingReviewState(),
      reviewRequest: null,
    });
  });

  it("increments from the preserved count and escalates at the cap exactly as without the return", () => {
    const returned = withPatch(fixtureIssue(), returnToExecutor().patch);
    const resubmitted = withPatch(returned, implementerResubmits(returned, { agentId: developerAgentId }).patch);
    const afterReturn = reviewerRequestsChanges(resubmitted);

    // Reference: the same reviewer decision on the never-returned fixture.
    const reference = reviewerRequestsChanges(fixtureIssue({}, { reviewRequest: null }));

    expect(afterReturn.decision).toEqual(reference.decision);
    expect(afterReturn.decision).toMatchObject({ outcome: "changes_requested", stageId: reviewStageId });
    expect(afterReturn.patch).toEqual(reference.patch);
    // 2 + 1 reaches maxReviewRounds 3: the stage escalates to the managing agent.
    expect(afterReturn.patch).toMatchObject({ status: "in_review", assigneeAgentId: managerAgentId });
    expect(afterReturn.patch.executionState).toMatchObject({
      status: "pending",
      currentStageId: reviewStageId,
      changesRequestedCount: 3,
      currentParticipant: { type: "agent", agentId: managerAgentId },
      escalationHolder: { type: "agent", agentId: managerAgentId },
    });
  });

  it("from count 0 with a user return assignee, a later request for changes counts 1 and goes back to the user", () => {
    const userReturn = { type: "user" as const, agentId: null, userId: implementerUserId };
    const start = fixtureIssue({}, { returnAssignee: userReturn, changesRequestedCount: 0, lastDecisionOutcome: null, lastDecisionId: null });
    const returned = withPatch(start, returnToExecutor(start).patch);
    const resubmitted = implementerResubmits(returned, { userId: implementerUserId });
    expect(resubmitted.decision).toBeUndefined();
    expect(resubmitted.patch.executionState).toMatchObject({
      status: "pending",
      currentStageId: reviewStageId,
      currentParticipant: reviewerPrincipal,
      changesRequestedCount: 0,
    });

    const changed = reviewerRequestsChanges(withPatch(returned, resubmitted.patch));
    expect(changed.decision).toMatchObject({ outcome: "changes_requested" });
    expect(changed.patch).toMatchObject({ status: "in_progress", assigneeAgentId: null, assigneeUserId: implementerUserId });
    expect(changed.patch.executionState).toMatchObject({ status: "changes_requested", changesRequestedCount: 1 });
  });
});

describe("return to executor: refusals change nothing (criteria 1 and 4)", () => {
  const refused = (reason: string) => ({ code: "execution_return_refused", reason });

  it("refuses an issue that is not in review", () => {
    expectHttpError(() => returnToExecutor(fixtureIssue({ status: "in_progress" })), 422, refused("issue_not_in_review"));
  });

  it("refuses without a policy", () => {
    expectHttpError(() => returnToExecutor(fixtureIssue(), { policy: null }), 422, refused("no_execution_policy"));
  });

  it("refuses a stage that is not pending", () => {
    for (const status of ["changes_requested", "completed", "idle"]) {
      expectHttpError(() => returnToExecutor(fixtureIssue({}, { status })), 422, refused("no_pending_stage"));
    }
    expectHttpError(() => returnToExecutor(fixtureIssue({ executionState: null })), 422, refused("no_pending_stage"));
  });

  it("refuses a stage id that is not in the current policy", () => {
    expectHttpError(
      () => returnToExecutor(fixtureIssue({}, { currentStageId: "b0000009-0000-4000-8000-000000000009" })),
      422,
      refused("stage_not_found"),
    );
  });

  it("refuses without a participant or a return assignee", () => {
    expectHttpError(() => returnToExecutor(fixtureIssue({}, { currentParticipant: null })), 422, refused("no_current_participant"));
    expectHttpError(() => returnToExecutor(fixtureIssue({}, { returnAssignee: null })), 422, refused("no_return_assignee"));
  });

  it("refuses an escalation hold, marked or legacy", () => {
    const manager = { type: "agent" as const, agentId: managerAgentId, userId: null };
    expectHttpError(
      () => returnToExecutor(fixtureIssue({ assigneeAgentId: managerAgentId }, {
        currentParticipant: manager, escalationHolder: manager, changesRequestedCount: 3,
      })),
      422,
      refused("escalation_hold"),
    );
    const escalatedUser = { type: "user" as const, agentId: null, userId: "escalated-user-1" };
    expectHttpError(
      () => returnToExecutor(fixtureIssue({ assigneeAgentId: null, assigneeUserId: "escalated-user-1" }, {
        currentParticipant: escalatedUser, changesRequestedCount: 3,
      })),
      422,
      refused("escalation_hold"),
    );
  });

  it("answers 409 to a stale stage id or count", () => {
    expectHttpError(
      () => returnToExecutor(fixtureIssue(), { expectedStageId: "b0000008-0000-4000-8000-000000000008" }),
      409,
      { code: "execution_return_stale", reason: "stage_mismatch", currentStageId: reviewStageId },
    );
    expectHttpError(
      () => returnToExecutor(fixtureIssue(), { expectedChangesRequestedCount: 1 }),
      409,
      { code: "execution_return_stale", reason: "count_mismatch", changesRequestedCount: 2 },
    );
  });

  it("refuses a board user who is the return assignee or the current participant", () => {
    const userReturn = { type: "user" as const, agentId: null, userId: implementerUserId };
    expectHttpError(
      () => returnToExecutor(fixtureIssue({}, { returnAssignee: userReturn }), { authority: { type: "board", userId: implementerUserId } }),
      403,
      { code: "execution_return_forbidden", reason: "actor_is_return_assignee" },
    );
    const userReviewer = { type: "user" as const, agentId: null, userId: "reviewer-user-1" };
    const userPolicy = normalizeIssueExecutionPolicy({
      stages: [{ type: "review", participants: [{ type: "user", userId: "reviewer-user-1" }] }],
      maxReviewRounds: 3,
    })!;
    expectHttpError(
      () => buildReturnToExecutorPatch({
        issue: fixtureIssue({ assigneeAgentId: null, assigneeUserId: "reviewer-user-1", executionPolicy: userPolicy }, {
          currentStageId: userPolicy.stages[0]!.id, currentParticipant: userReviewer,
        }),
        policy: userPolicy,
        authority: { type: "board", userId: "reviewer-user-1" },
        expectedStageId: userPolicy.stages[0]!.id,
      }),
      403,
      { code: "execution_return_forbidden", reason: "actor_is_current_participant" },
    );
  });

  it("refuses the delegate when it is the return assignee or the current participant", () => {
    expectHttpError(
      () => returnToExecutor(fixtureIssue(), { authority: { type: "review_escalation_delegate", agentId: developerAgentId } }),
      403,
      { code: "execution_return_forbidden", reason: "delegate_is_return_assignee" },
    );
    expectHttpError(
      () => returnToExecutor(fixtureIssue(), { authority: { type: "review_escalation_delegate", agentId: reviewerAgentId } }),
      403,
      { code: "execution_return_forbidden", reason: "delegate_is_current_participant" },
    );
  });
});
