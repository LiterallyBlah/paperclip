import { describe, expect, it } from "vitest";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
} from "../services/issue-execution-policy.ts";
import { assertLegacyRunTaskOwnership } from "../legacy-run-task-ownership.ts";

// BLA-287 defect D1. Shapes mirror a production review loop:
// the CTO agent created the issue, the run chain stamped the board user as
// responsibleUserId, the Developer implements, the Reviewer is stage 1, the
// Security Engineer is stage 2 and maxReviewRounds is 2.
const companyId = "company-1";
const issueId = "issue-1";
const ctoAgentId = "a0000001-0000-4000-8000-000000000001";
const developerAgentId = "a0000002-0000-4000-8000-000000000002";
const reviewerAgentId = "a0000003-0000-4000-8000-000000000003";
const securityAgentId = "a0000004-0000-4000-8000-000000000004";
const boardUserId = "board-user-1";

const policy = normalizeIssueExecutionPolicy({
  stages: [
    { type: "review", participants: [{ type: "agent", agentId: reviewerAgentId }] },
    { type: "review", participants: [{ type: "agent", agentId: securityAgentId }] },
  ],
  maxReviewRounds: 2,
})!;
const reviewStageId = policy.stages[0].id;
const securityStageId = policy.stages[1].id;

function reviewerPassTwoIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    companyId,
    status: "in_review",
    assigneeAgentId: reviewerAgentId,
    assigneeUserId: null,
    createdByAgentId: ctoAgentId,
    createdByUserId: null,
    responsibleUserId: boardUserId,
    executionPolicy: policy,
    executionState: {
      status: "pending",
      currentStageId: reviewStageId,
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: reviewerAgentId, userId: null },
      returnAssignee: { type: "agent", agentId: developerAgentId, userId: null },
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: "changes_requested",
      changesRequestedCount: 1,
    },
    ...overrides,
  };
}

function reviewerRequestsChanges(issue = reviewerPassTwoIssue()) {
  return applyIssueExecutionPolicyTransition({
    issue,
    policy,
    previousPolicy: policy,
    requestedStatus: "in_progress",
    requestedAssigneePatch: {},
    actor: { agentId: reviewerAgentId },
    commentBody: "Changes requested — Reviewer pass 2 of 2",
  });
}

/** Apply a transition patch to an issue, as the PATCH route persists it. */
function withPatch<T extends Record<string, unknown>>(issue: T, patch: Record<string, unknown>): T {
  return { ...issue, ...patch };
}

// The held state is produced by the real cap-escalation transition, so it
// carries exactly what the escalation records (including its hold marker).
function heldByCto() {
  return withPatch(reviewerPassTwoIssue(), reviewerRequestsChanges().patch);
}

describe("BLA-287 symptom 1: review-cap escalation target", () => {
  it("hands the capped stage to the creating (managing) agent, not the responsible user", () => {
    const result = reviewerRequestsChanges();

    expect(result.decision).toMatchObject({ outcome: "changes_requested" });
    expect(result.patch.status).toBe("in_review");
    expect(result.patch.assigneeUserId ?? null).toBeNull();
    expect(result.patch.assigneeAgentId).toBe(ctoAgentId);
    expect(result.patch.executionState).toMatchObject({
      status: "pending",
      currentStageId: reviewStageId,
      currentParticipant: { type: "agent", agentId: ctoAgentId },
      returnAssignee: { type: "agent", agentId: developerAgentId },
      changesRequestedCount: 2,
    });
  });

  it("falls back to the responsible user when the creator agent is the reviewer", () => {
    const result = reviewerRequestsChanges(reviewerPassTwoIssue({ createdByAgentId: reviewerAgentId }));
    expect(result.patch.assigneeUserId).toBe(boardUserId);
    expect(result.patch.executionState).toMatchObject({
      currentParticipant: { type: "user", userId: boardUserId },
    });
  });

  it("falls back to the responsible user when the creator agent is the return assignee", () => {
    const result = reviewerRequestsChanges(reviewerPassTwoIssue({ createdByAgentId: developerAgentId }));
    expect(result.patch.assigneeUserId).toBe(boardUserId);
  });

  it("keeps the agent-held escalation sticky against the configured reviewer", () => {
    const result = applyIssueExecutionPolicyTransition({
      issue: heldByCto(),
      policy,
      previousPolicy: policy,
      requestedAssigneePatch: {},
      actor: { agentId: reviewerAgentId },
    });
    expect(result.patch.executionState).toBeUndefined();
    expect(result.patch.assigneeAgentId).toBeUndefined();

    expect(() =>
      applyIssueExecutionPolicyTransition({
        issue: heldByCto(),
        policy,
        previousPolicy: policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: reviewerAgentId },
        commentBody: "Reviewer trying to approve during the hold",
      }),
    ).toThrow("Only the escalated reviewer can advance the current execution stage");
  });

  it("lets the managing agent authorise one more correction round (counter resets)", () => {
    const result = applyIssueExecutionPolicyTransition({
      issue: heldByCto(),
      policy,
      previousPolicy: policy,
      requestedStatus: "in_progress",
      requestedAssigneePatch: {},
      actor: { agentId: ctoAgentId },
      commentBody: "CTO: one focused F2 correction, then one review pass",
    });
    expect(result.patch.status).toBe("in_progress");
    expect(result.patch.assigneeAgentId).toBe(developerAgentId);
    expect(result.patch.executionState).toMatchObject({
      status: "changes_requested",
      changesRequestedCount: 0,
    });
  });

  it("lets the managing agent approve the held stage and advance to stage 2", () => {
    const result = applyIssueExecutionPolicyTransition({
      issue: heldByCto(),
      policy,
      previousPolicy: policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: ctoAgentId },
      commentBody: "CTO accepts the residual risk",
    });
    expect(result.decision).toMatchObject({ outcome: "approved" });
    expect(result.patch.executionState).toMatchObject({
      status: "pending",
      currentStageId: securityStageId,
      currentParticipant: { type: "agent", agentId: securityAgentId },
    });
  });
});

describe("BLA-287 symptom 2: 403 on the reviewer's follow-up card", () => {
  const legacyReviewerRun = {
    companyId,
    runtimeMode: "legacy",
    contextSnapshot: { issueId },
  };

  it("a user-held escalation hands the outgoing reviewer run's task to a human (issue_handed_off)", () => {
    // Pre-fix routing (no creator agent): the request-changes PATCH assigns
    // the issue to a user, so every later write by the same legacy run on
    // that issue — including POST /interactions — is refused with 403.
    const result = reviewerRequestsChanges(reviewerPassTwoIssue({ createdByAgentId: null }));
    const after = { id: issueId, companyId, assigneeAgentId: null, assigneeUserId: null, ...result.patch };
    expect(after.assigneeUserId).toBe(boardUserId);
    expect(() => assertLegacyRunTaskOwnership(legacyReviewerRun, after as never)).toThrow(
      "This task is assigned to a human; the outgoing run can no longer change it",
    );
  });

  it("an agent-held escalation leaves the outgoing reviewer run able to write", () => {
    const result = reviewerRequestsChanges();
    const after = { id: issueId, companyId, assigneeAgentId: null, assigneeUserId: null, ...result.patch };
    expect(after.assigneeAgentId).toBe(ctoAgentId);
    expect(() => assertLegacyRunTaskOwnership(legacyReviewerRun, after as never)).not.toThrow();
  });
});

describe("BLA-287 symptom 3: stages cleared after a final-round request-changes", () => {
  // State after the Security Engineer's request-changes at 07:38:09: stage 2
  // is changes_requested and the Developer is assigned.
  const changesRequestedIssue = {
    id: issueId,
    companyId,
    status: "in_progress",
    assigneeAgentId: developerAgentId,
    assigneeUserId: null,
    createdByAgentId: ctoAgentId,
    responsibleUserId: boardUserId,
    executionPolicy: policy,
    executionState: {
      status: "changes_requested",
      currentStageId: securityStageId,
      currentStageIndex: 1,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: securityAgentId, userId: null },
      returnAssignee: { type: "agent", agentId: developerAgentId, userId: null },
      completedStageIds: [reviewStageId],
      lastDecisionId: "00c05850-a434-4470-b5ca-3fd07d62e06f",
      lastDecisionOutcome: "changes_requested",
      changesRequestedCount: 1,
    },
  };

  // What `PATCH { executionPolicy: { monitor: { nextCheckAt } } }` becomes
  // after request validation: `stages` defaults to [] and the round limit to
  // null, and the route replaces the whole stored policy with it.
  const monitorOnlyPolicy = normalizeIssueExecutionPolicy({
    stages: [],
    monitor: { nextCheckAt: "2026-11-12T09:30:00.000Z", scheduledBy: "assignee" },
  })!;

  it("a monitor-only policy normalizes to one with no stages and no round limit", () => {
    expect(monitorOnlyPolicy.stages).toEqual([]);
    expect(monitorOnlyPolicy.maxReviewRounds).toBeUndefined();
  });

  it("rejects an agent's monitor-only write that would dissolve the live review cycle", () => {
    expect(() =>
      applyIssueExecutionPolicyTransition({
        issue: changesRequestedIssue,
        policy: monitorOnlyPolicy,
        previousPolicy: policy,
        requestedAssigneePatch: {},
        actor: { agentId: developerAgentId },
        monitorExplicitlyUpdated: true,
      }),
    ).toThrow(/would remove the live review cycle/);
  });

  it("still lets the board clear the stages deliberately", () => {
    const result = applyIssueExecutionPolicyTransition({
      issue: changesRequestedIssue,
      policy: monitorOnlyPolicy,
      previousPolicy: policy,
      requestedAssigneePatch: {},
      actor: { userId: boardUserId },
      allowBoardOverride: true,
    });
    // The review cycle is dissolved; only the new monitor state remains.
    expect(result.patch.executionState).toMatchObject({ status: "idle", currentStageId: null });
  });

  it("accepts the same monitor write when the current stages are sent with it", () => {
    const fullPolicy = normalizeIssueExecutionPolicy({
      ...policy,
      monitor: { nextCheckAt: "2026-11-12T09:30:00.000Z", scheduledBy: "assignee" },
    })!;
    const result = applyIssueExecutionPolicyTransition({
      issue: changesRequestedIssue,
      policy: fullPolicy,
      previousPolicy: policy,
      requestedAssigneePatch: {},
      actor: { agentId: developerAgentId },
      monitorExplicitlyUpdated: true,
    });
    expect(result.patch.executionState).not.toBeNull();
    expect(fullPolicy.stages.map((stage) => stage.id)).toEqual([reviewStageId, securityStageId]);
  });
});

describe("BLA-293: a non-escalated out-of-stage agent is not treated as a hold", () => {
  const replacementReviewerId = "7e57a9e0-0000-4000-8000-000000000005";
  // Same stage ids; stage 1's reviewer swapped mid-cycle.
  const swappedPolicy = normalizeIssueExecutionPolicy({
    ...policy,
    stages: [
      { ...policy.stages[0], participants: [{ type: "agent", agentId: replacementReviewerId }] },
      policy.stages[1],
    ],
  })!;

  // Pending stage at or above the cap but never escalated: the round limit
  // was reached on a hand-back with no target, then the work was resubmitted.
  function pendingAtCapWithoutEscalation(overrides: Record<string, unknown> = {}) {
    return reviewerPassTwoIssue({
      executionState: { ...reviewerPassTwoIssue().executionState, changesRequestedCount: 2 },
      ...overrides,
    });
  }

  for (const [label, overrides] of [
    ["with a creator agent", {}],
    ["without a creator agent", { createdByAgentId: null }],
  ] as const) {
    it(`re-selects the edited stage's reviewer ${label}`, () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: pendingAtCapWithoutEscalation(overrides),
        policy: swappedPolicy,
        previousPolicy: policy,
        requestedAssigneePatch: {},
        actor: { userId: boardUserId },
        allowBoardOverride: true,
      });
      expect(swappedPolicy.stages[0].id).toBe(reviewStageId);
      expect(result.patch.assigneeAgentId).toBe(replacementReviewerId);
      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageId: reviewStageId,
        currentParticipant: { type: "agent", agentId: replacementReviewerId },
      });
    });
  }

  it("keeps the creator-agent hold sticky across the same participant edit", () => {
    const result = applyIssueExecutionPolicyTransition({
      issue: heldByCto(),
      policy: swappedPolicy,
      previousPolicy: policy,
      requestedAssigneePatch: {},
      actor: { userId: boardUserId },
    });
    expect(result.patch.executionState).toBeUndefined();
    expect(result.patch.assigneeAgentId).toBeUndefined();
  });
});

describe("BLA-293: stage-less writes that stay as on base", () => {
  const monitorOnlyPolicy = normalizeIssueExecutionPolicy({
    stages: [],
    monitor: { nextCheckAt: "2026-11-12T09:30:00.000Z", scheduledBy: "assignee" },
  })!;

  it("an agent's executionPolicy: null still removes a live review deliberately", () => {
    const result = applyIssueExecutionPolicyTransition({
      issue: reviewerPassTwoIssue(),
      policy: null,
      previousPolicy: policy,
      requestedAssigneePatch: {},
      actor: { agentId: reviewerAgentId },
    });
    expect(result.patch.executionState).toBeNull();
    expect(result.patch.assigneeAgentId).toBe(developerAgentId);
  });

  it("an agent's monitor-only write is accepted when no review is live", () => {
    const issue = {
      ...reviewerPassTwoIssue(),
      status: "in_progress",
      assigneeAgentId: developerAgentId,
      executionState: null,
    };
    expect(() =>
      applyIssueExecutionPolicyTransition({
        issue,
        policy: monitorOnlyPolicy,
        previousPolicy: policy,
        requestedAssigneePatch: {},
        actor: { agentId: developerAgentId },
        monitorExplicitlyUpdated: true,
      }),
    ).not.toThrow();
  });
});

describe("BLA-293 pass 2: an escalation hold is identified by provenance, not identity", () => {
  const replacementReviewerId = "7e57a9e0-0000-4000-8000-000000000005";

  it("F1: a creator agent that was only the regular reviewer is not held after a participant edit", () => {
    // Creator C (the CTO) is itself the configured reviewer; no user fallback.
    const creatorReviewsPolicy = normalizeIssueExecutionPolicy({
      stages: [{ type: "review", participants: [{ type: "agent", agentId: ctoAgentId }] }],
      maxReviewRounds: 2,
    })!;
    const stageId = creatorReviewsPolicy.stages[0].id;
    const start = {
      id: issueId,
      companyId,
      status: "in_review",
      assigneeAgentId: ctoAgentId,
      assigneeUserId: null,
      createdByAgentId: ctoAgentId,
      createdByUserId: null,
      responsibleUserId: null,
      executionPolicy: creatorReviewsPolicy,
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: ctoAgentId, userId: null },
        returnAssignee: { type: "agent", agentId: developerAgentId, userId: null },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: "changes_requested",
        changesRequestedCount: 1,
      },
    };

    // 1. C requests changes; C is excluded as its own target and there is no
    //    user, so the work returns to D with the count at the cap.
    const cDecides = applyIssueExecutionPolicyTransition({
      issue: start,
      policy: creatorReviewsPolicy,
      previousPolicy: creatorReviewsPolicy,
      requestedStatus: "in_progress",
      requestedAssigneePatch: {},
      actor: { agentId: ctoAgentId },
      commentBody: "C requests changes",
    });
    expect(cDecides.patch.assigneeAgentId).toBe(developerAgentId);
    expect(cDecides.patch.executionState).toMatchObject({ status: "changes_requested", changesRequestedCount: 2 });
    const afterC = withPatch(start, cDecides.patch);

    // 2. D resubmits: the pending participant is C again, count still 2.
    const dResubmits = applyIssueExecutionPolicyTransition({
      issue: afterC,
      policy: creatorReviewsPolicy,
      previousPolicy: creatorReviewsPolicy,
      requestedStatus: "in_review",
      requestedAssigneePatch: {},
      actor: { agentId: developerAgentId },
    });
    expect(dResubmits.patch.executionState).toMatchObject({
      status: "pending",
      currentParticipant: { type: "agent", agentId: ctoAgentId },
      changesRequestedCount: 2,
    });
    const afterD = withPatch(afterC, dResubmits.patch);

    // 3. The board replaces C with R, keeping the stage id.
    const swapped = normalizeIssueExecutionPolicy({
      ...creatorReviewsPolicy,
      stages: [{ ...creatorReviewsPolicy.stages[0], participants: [{ type: "agent", agentId: replacementReviewerId }] }],
    })!;
    expect(swapped.stages[0].id).toBe(stageId);
    const boardEdit = applyIssueExecutionPolicyTransition({
      issue: afterD,
      policy: swapped,
      previousPolicy: creatorReviewsPolicy,
      requestedAssigneePatch: {},
      actor: { userId: boardUserId },
      allowBoardOverride: true,
    });
    expect(boardEdit.patch.assigneeAgentId).toBe(replacementReviewerId);
    expect(boardEdit.patch.executionState).toMatchObject({
      currentParticipant: { type: "agent", agentId: replacementReviewerId },
    });
    const afterEdit = withPatch({ ...afterD, executionPolicy: swapped }, boardEdit.patch);

    // 4. R can now decide the stage.
    const rApproves = applyIssueExecutionPolicyTransition({
      issue: afterEdit,
      policy: swapped,
      previousPolicy: swapped,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: replacementReviewerId },
      commentBody: "R approves",
    });
    expect(rApproves.decision).toMatchObject({ outcome: "approved" });
  });

  describe("F2: a real escalation to a creator that is also a configured participant", () => {
    // Stage participants [R, C]; R is current; D implements; a responsible user exists.
    const sharedPolicy = normalizeIssueExecutionPolicy({
      stages: [
        {
          type: "review",
          participants: [
            { type: "agent", agentId: reviewerAgentId },
            { type: "agent", agentId: ctoAgentId },
          ],
        },
      ],
      maxReviewRounds: 2,
    })!;
    const sharedStageId = sharedPolicy.stages[0].id;

    function escalatedToMemberCreator() {
      const start = reviewerPassTwoIssue({
        executionPolicy: sharedPolicy,
        executionState: { ...reviewerPassTwoIssue().executionState, currentStageId: sharedStageId },
      });
      const rDecides = applyIssueExecutionPolicyTransition({
        issue: start,
        policy: sharedPolicy,
        previousPolicy: sharedPolicy,
        requestedStatus: "in_progress",
        requestedAssigneePatch: {},
        actor: { agentId: reviewerAgentId },
        commentBody: "R requests changes at the cap",
      });
      expect(rDecides.patch.assigneeAgentId).toBe(ctoAgentId);
      expect(rDecides.patch.executionState).toMatchObject({
        status: "pending",
        currentParticipant: { type: "agent", agentId: ctoAgentId },
        changesRequestedCount: 2,
      });
      return withPatch(start, rDecides.patch);
    }

    it("the holder's request-changes resets the count and returns the work to D", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: escalatedToMemberCreator(),
        policy: sharedPolicy,
        previousPolicy: sharedPolicy,
        requestedStatus: "in_progress",
        requestedAssigneePatch: {},
        actor: { agentId: ctoAgentId },
        commentBody: "C authorises one more round",
      });
      expect(result.patch.status).toBe("in_progress");
      expect(result.patch.assigneeAgentId).toBe(developerAgentId);
      expect(result.patch.assigneeUserId ?? null).toBeNull();
      expect(result.patch.executionState).toMatchObject({ status: "changes_requested", changesRequestedCount: 0 });
      expect((result.patch.executionState as Record<string, unknown>).escalationHolder).toBeUndefined();
    });

    it("the hold stays sticky against the other configured reviewer", () => {
      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: escalatedToMemberCreator(),
          policy: sharedPolicy,
          previousPolicy: sharedPolicy,
          requestedStatus: "done",
          requestedAssigneePatch: {},
          actor: { agentId: reviewerAgentId },
          commentBody: "R tries to approve during the hold",
        }),
      ).toThrow("Only the escalated reviewer can advance the current execution stage");
    });

    it("F3: the holder's own drift repair (checkout, then a non-decision PATCH) keeps the hold", () => {
      // Checkout moves the issue to in_progress but keeps the pending state.
      const checkedOut = { ...escalatedToMemberCreator(), status: "in_progress" };
      const titleEdit = applyIssueExecutionPolicyTransition({
        issue: checkedOut,
        policy: sharedPolicy,
        previousPolicy: sharedPolicy,
        requestedStatus: undefined,
        requestedAssigneePatch: {},
        actor: { agentId: ctoAgentId },
      });
      expect(titleEdit.patch.status).toBe("in_review");
      expect((titleEdit.patch.executionState as Record<string, unknown>).escalationHolder).toMatchObject({
        type: "agent",
        agentId: ctoAgentId,
      });
      const repaired = withPatch(checkedOut, titleEdit.patch);
      const cDecides = applyIssueExecutionPolicyTransition({
        issue: repaired,
        policy: sharedPolicy,
        previousPolicy: sharedPolicy,
        requestedStatus: "in_progress",
        requestedAssigneePatch: {},
        actor: { agentId: ctoAgentId },
        commentBody: "C authorises one more round",
      });
      expect(cDecides.patch.status).toBe("in_progress");
      expect(cDecides.patch.assigneeAgentId).toBe(developerAgentId);
      expect(cDecides.patch.executionState).toMatchObject({ status: "changes_requested", changesRequestedCount: 0 });
    });

    it("the next cycle after the holder's decision is an ordinary review again", () => {
      const held = escalatedToMemberCreator();
      const cDecides = applyIssueExecutionPolicyTransition({
        issue: held,
        policy: sharedPolicy,
        previousPolicy: sharedPolicy,
        requestedStatus: "in_progress",
        requestedAssigneePatch: {},
        actor: { agentId: ctoAgentId },
        commentBody: "C authorises one more round",
      });
      const afterC = withPatch(held, cDecides.patch);
      const dResubmits = applyIssueExecutionPolicyTransition({
        issue: afterC,
        policy: sharedPolicy,
        previousPolicy: sharedPolicy,
        requestedStatus: "in_review",
        requestedAssigneePatch: {},
        actor: { agentId: developerAgentId },
      });
      const state = dResubmits.patch.executionState as Record<string, unknown>;
      expect(state).toMatchObject({ status: "pending", changesRequestedCount: 0 });
      expect(state.escalationHolder).toBeUndefined();
    });
  });
});
