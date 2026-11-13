import { parseIssueExecutionState } from "./issue-execution-policy.js";
import { readExecutionStageId } from "../modules/wake-queue/domain/values.js";

export {
  EXECUTION_STAGE_WAKE_REASONS,
  EXECUTION_STAGE_WAKE_WAIT_CAUSE,
  isKeptExecutionStageWake,
} from "../modules/wake-queue/domain/values.js";

type ParsedExecutionState = NonNullable<ReturnType<typeof parseIssueExecutionState>>;

/** Idempotency prefix of the one re-admission of a stage wake an admission gate ended. */
export const EXECUTION_STAGE_WAKE_READMIT_KEY_PREFIX = "execution-stage-readmit:";

/**
 * True only while `agentId` is the current agent participant of the same
 * pending stage that `payload.executionStage` was built for. Review authority
 * comes from the task's current execution state, never from the stored wake.
 */
export function isCurrentExecutionStageParticipant(
  issue: { status: string; executionState: unknown },
  agentId: string,
  payload: unknown,
): boolean {
  const stageId = readExecutionStageId(payload);
  if (!stageId || issue.status !== "in_review") return false;
  const state = parseIssueExecutionState(issue.executionState);
  return state?.status === "pending" &&
    state.currentStageId === stageId &&
    state.currentParticipant?.type === "agent" &&
    state.currentParticipant.agentId === agentId;
}

export function buildExecutionStageWakeContext(input: {
  state: ParsedExecutionState;
  wakeRole: "reviewer" | "approver" | "executor";
  allowedActions: string[];
}) {
  return {
    wakeRole: input.wakeRole,
    stageId: input.state.currentStageId,
    stageType: input.state.currentStageType,
    currentParticipant: input.state.currentParticipant,
    returnAssignee: input.state.returnAssignee,
    reviewRequest: input.state.reviewRequest ?? null,
    lastDecisionOutcome: input.state.lastDecisionOutcome,
    allowedActions: input.allowedActions,
  };
}

/**
 * The wake a pending stage gives its current agent participant, built from
 * the task's current execution state exactly as the hand-off builds it.
 */
export function buildPendingStageParticipantWakeup(issueId: string, state: ParsedExecutionState) {
  const agentId = state.status === "pending" && state.currentParticipant?.type === "agent"
    ? state.currentParticipant.agentId ?? null : null;
  if (!agentId) return null;
  const approval = state.currentStageType === "approval";
  const reason = approval ? "execution_approval_requested" : "execution_review_requested";
  const executionStage = buildExecutionStageWakeContext({
    state, wakeRole: approval ? "approver" : "reviewer", allowedActions: ["approve", "request_changes"],
  });
  return {
    agentId,
    reason,
    payload: { issueId, mutation: "update", executionStage },
    contextSnapshot: { issueId, taskId: issueId, wakeReason: reason, source: "issue.execution_stage", executionStage },
  };
}
