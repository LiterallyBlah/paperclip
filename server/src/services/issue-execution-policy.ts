import { randomUUID } from "node:crypto";
import type {
  IssueExecutionDecision,
  IssueExecutionMonitorClearReason,
  IssueExecutionMonitorPolicy,
  IssueExecutionMonitorState,
  IssueExecutionMonitorMaintenanceWait,
  IssueExecutionPolicy,
  IssueExecutionStage,
  IssueExecutionStagePrincipal,
  IssueExecutionState,
  IssueMonitorScheduledBy,
} from "@paperclipai/shared";
import { issueExecutionPolicySchema, issueExecutionStateSchema } from "@paperclipai/shared";
import { conflict, forbidden, unprocessable } from "../errors.js";

type AssigneeLike = {
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
};

type IssueLike = AssigneeLike & {
  status: string;
  responsibleUserId?: string | null;
  createdByUserId?: string | null;
  createdByAgentId?: string | null;
  executionPolicy?: IssueExecutionPolicy | Record<string, unknown> | null;
  executionState?: IssueExecutionState | Record<string, unknown> | null;
  monitorNextCheckAt?: Date | null;
  monitorWakeRequestedAt?: Date | null;
  monitorLastTriggeredAt?: Date | null;
  monitorAttemptCount?: number | null;
  monitorNotes?: string | null;
  monitorScheduledBy?: string | null;
};

type ActorLike = {
  agentId?: string | null;
  userId?: string | null;
};

type RequestedAssigneePatch = {
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
};

type TransitionInput = {
  issue: IssueLike;
  policy: IssueExecutionPolicy | null;
  previousPolicy?: IssueExecutionPolicy | null;
  requestedStatus?: string;
  requestedAssigneePatch: RequestedAssigneePatch;
  actor: ActorLike;
  allowBoardOverride?: boolean;
  commentBody?: string | null;
  reviewRequest?: IssueExecutionState["reviewRequest"] | null;
  monitorExplicitlyUpdated?: boolean;
  /**
   * The company's review escalation delegate (an active agent of the issue's
   * company), resolved by the caller. Absent or null keeps the default
   * escalation behaviour exactly.
   */
  reviewEscalationDelegateAgentId?: string | null;
};

type TransitionResult = {
  patch: Record<string, unknown>;
  decision?: Pick<IssueExecutionDecision, "stageId" | "stageType" | "outcome" | "body">;
  workflowControlledAssignment?: boolean;
};

/**
 * Consecutive agent-initiated changes-requested rounds tolerated on one stage
 * before the pending review escalates to the responsible human. Policies can
 * override via `maxReviewRounds`; human decisions always reset the counter.
 */
export const DEFAULT_MAX_REVIEW_ROUNDS = 3;

const COMPLETED_STATUS: IssueExecutionState["status"] = "completed";
const PENDING_STATUS: IssueExecutionState["status"] = "pending";
const CHANGES_REQUESTED_STATUS: IssueExecutionState["status"] = "changes_requested";
const MONITOR_INVALID_MESSAGE = "Monitor can only be scheduled on issues assigned to an agent in in_progress or in_review";
const MONITOR_BOUNDS_EXHAUSTED_MESSAGE = "Monitor bounds are already exhausted";
const STAGE_DECISION_COMMENT_HINT = "Include the decision comment in the same PATCH request; prior comments are not considered.";
export const REDACTED_ISSUE_MONITOR_EXTERNAL_REF = "[redacted]";

function normalizeMonitorNotes(notes: string | null | undefined) {
  if (typeof notes !== "string") return null;
  const trimmed = notes.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeMonitorText(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function redactIssueMonitorExternalRef(value: string | null | undefined) {
  return normalizeMonitorText(value) ? REDACTED_ISSUE_MONITOR_EXTERNAL_REF : null;
}

function monitorMetadataFromPolicy(monitor: IssueExecutionMonitorPolicy) {
  return {
    kind: monitor.kind ?? null,
    serviceName: normalizeMonitorText(monitor.serviceName),
    externalRef: redactIssueMonitorExternalRef(monitor.externalRef),
    timeoutAt: monitor.timeoutAt ?? null,
    maxAttempts: monitor.maxAttempts ?? null,
    recoveryPolicy: monitor.recoveryPolicy ?? null,
  };
}

function monitorMetadataFromState(state: IssueExecutionMonitorState | null | undefined) {
  return {
    kind: state?.kind ?? null,
    serviceName: normalizeMonitorText(state?.serviceName),
    externalRef: redactIssueMonitorExternalRef(state?.externalRef),
    timeoutAt: state?.timeoutAt ?? null,
    maxAttempts: state?.maxAttempts ?? null,
    recoveryPolicy: state?.recoveryPolicy ?? null,
  };
}

function blankExecutionState(): IssueExecutionState {
  return {
    status: "idle",
    currentStageId: null,
    currentStageIndex: null,
    currentStageType: null,
    currentParticipant: null,
    returnAssignee: null,
    reviewRequest: null,
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: null,
    monitor: null,
  };
}

function isoString(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function monitorStatesEqual(left: IssueExecutionMonitorState | null, right: IssueExecutionMonitorState | null): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function executionStateWithMonitor(
  stageState: IssueExecutionState | null,
  monitorState: IssueExecutionMonitorState | null,
): IssueExecutionState | null {
  if (!stageState && !monitorState) return null;
  const base = stageState ? { ...stageState } : blankExecutionState();
  return {
    ...base,
    monitor: monitorState,
  };
}

function derivePersistedMonitorState(input: {
  issue: IssueLike;
  state: IssueExecutionState | null;
  policy: IssueExecutionPolicy | null;
}): IssueExecutionMonitorState | null {
  const fromState = input.state?.monitor ?? null;
  const scheduledMonitor = input.policy?.monitor ?? null;
  const nextCheckAt = isoString(input.issue.monitorNextCheckAt) ?? scheduledMonitor?.nextCheckAt ?? fromState?.nextCheckAt ?? null;
  const lastTriggeredAt = isoString(input.issue.monitorLastTriggeredAt) ?? fromState?.lastTriggeredAt ?? null;
  const attemptCount = input.issue.monitorAttemptCount ?? fromState?.attemptCount ?? 0;
  const notes = scheduledMonitor?.notes ?? normalizeMonitorNotes(input.issue.monitorNotes) ?? fromState?.notes ?? null;
  const scheduledByRaw = input.issue.monitorScheduledBy ?? scheduledMonitor?.scheduledBy ?? fromState?.scheduledBy ?? null;
  const scheduledBy =
    scheduledByRaw === "assignee" || scheduledByRaw === "board" ? scheduledByRaw : null;
  const metadata = scheduledMonitor ? monitorMetadataFromPolicy(scheduledMonitor) : monitorMetadataFromState(fromState);

  if (nextCheckAt) {
    return {
      status: "scheduled",
      nextCheckAt,
      lastTriggeredAt,
      attemptCount,
      notes,
      scheduledBy,
      ...metadata,
      ...deferredCountFor(fromState, nextCheckAt),
      ...maintenanceWaitFor(fromState, nextCheckAt),
      clearedAt: null,
      clearReason: null,
    };
  }

  if (fromState?.status === "cleared") {
    return {
      ...fromState,
      notes,
      scheduledBy,
      attemptCount,
      lastTriggeredAt,
      ...metadata,
    };
  }

  if (fromState?.status === "triggered" || lastTriggeredAt || attemptCount > 0) {
    return {
      status: "triggered",
      nextCheckAt: null,
      lastTriggeredAt,
      attemptCount,
      notes,
      scheduledBy,
      ...metadata,
      clearedAt: null,
      clearReason: null,
    };
  }

  return null;
}

/**
 * Deferred-fire counts belong to one scheduled check. Keep the count while the
 * same nextCheckAt is still scheduled; any new schedule starts from zero.
 */
function deferredCountFor(
  state: IssueExecutionMonitorState | null | undefined,
  nextCheckAt: string,
): { deferredCount?: number } {
  if (!state?.deferredCount || !isSameScheduledCheck(state, nextCheckAt)) return {};
  return { deferredCount: state.deferredCount };
}

/** Like deferredCountFor: a maintenance wait belongs to the check it re-armed. */
function maintenanceWaitFor(
  state: IssueExecutionMonitorState | null | undefined,
  nextCheckAt: string,
): { maintenanceWait?: IssueExecutionMonitorMaintenanceWait } {
  if (!state?.maintenanceWait || !isSameScheduledCheck(state, nextCheckAt)) return {};
  return { maintenanceWait: { ...state.maintenanceWait } };
}

function isSameScheduledCheck(state: IssueExecutionMonitorState, nextCheckAt: string) {
  if (state.status !== "scheduled") return false;
  const stateTime = parseMonitorDate(state.nextCheckAt)?.getTime();
  const nextTime = parseMonitorDate(nextCheckAt)?.getTime();
  return stateTime !== undefined && stateTime === nextTime;
}

function buildScheduledMonitorState(
  previous: IssueExecutionMonitorState | null,
  monitor: IssueExecutionMonitorPolicy,
): IssueExecutionMonitorState {
  return {
    status: "scheduled",
    nextCheckAt: monitor.nextCheckAt,
    lastTriggeredAt: previous?.lastTriggeredAt ?? null,
    attemptCount: previous?.attemptCount ?? 0,
    notes: monitor.notes ?? null,
    scheduledBy: monitor.scheduledBy,
    ...monitorMetadataFromPolicy(monitor),
    ...deferredCountFor(previous, monitor.nextCheckAt),
    ...maintenanceWaitFor(previous, monitor.nextCheckAt),
    clearedAt: null,
    clearReason: null,
  };
}

function buildTriggeredMonitorState(input: {
  previous: IssueExecutionMonitorState | null;
  triggeredAt: Date;
}): IssueExecutionMonitorState {
  return {
    status: "triggered",
    nextCheckAt: null,
    lastTriggeredAt: input.triggeredAt.toISOString(),
    attemptCount: (input.previous?.attemptCount ?? 0) + 1,
    notes: input.previous?.notes ?? null,
    scheduledBy: input.previous?.scheduledBy ?? null,
    ...monitorMetadataFromState(input.previous),
    clearedAt: null,
    clearReason: null,
  };
}

function buildClearedMonitorState(input: {
  previous: IssueExecutionMonitorState | null;
  clearReason: IssueExecutionMonitorClearReason;
  clearedAt: Date;
}): IssueExecutionMonitorState {
  return {
    status: "cleared",
    nextCheckAt: null,
    lastTriggeredAt: input.previous?.lastTriggeredAt ?? null,
    attemptCount: input.previous?.attemptCount ?? 0,
    notes: input.previous?.notes ?? null,
    scheduledBy: input.previous?.scheduledBy ?? null,
    ...monitorMetadataFromState(input.previous),
    clearedAt: input.clearedAt.toISOString(),
    clearReason: input.clearReason,
  };
}

function issueAllowsMonitor(status: string, assigneeAgentId: string | null, assigneeUserId: string | null) {
  return Boolean(assigneeAgentId) && !assigneeUserId && (status === "in_progress" || status === "in_review");
}

function monitorClearReasonForIssue(
  status: string,
  assigneeAgentId: string | null,
  assigneeUserId: string | null,
): IssueExecutionMonitorClearReason | null {
  if (status === "done") return "done";
  if (status === "cancelled") return "cancelled";
  if (!issueAllowsMonitor(status, assigneeAgentId, assigneeUserId)) {
    if (assigneeUserId || !assigneeAgentId) return "invalid_assignee";
    return "invalid_status";
  }
  return null;
}

function parseMonitorDate(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function exhaustedMonitorClearReason(input: {
  monitor: IssueExecutionMonitorPolicy;
  attemptCount: number;
  now: Date;
}): IssueExecutionMonitorClearReason | null {
  const timeoutAt = parseMonitorDate(input.monitor.timeoutAt ?? null);
  if (timeoutAt && input.now.getTime() >= timeoutAt.getTime()) {
    return "timeout_exceeded";
  }
  const maxAttempts = input.monitor.maxAttempts ?? null;
  if (maxAttempts !== null && input.attemptCount >= maxAttempts) {
    return "max_attempts_exhausted";
  }
  return null;
}

function nextAssigneeIds(input: {
  issue: IssueLike;
  requestedAssigneePatch: RequestedAssigneePatch;
  stagePatch: Record<string, unknown>;
}) {
  const assigneeAgentId =
    input.stagePatch.assigneeAgentId !== undefined
      ? (input.stagePatch.assigneeAgentId as string | null)
      : input.requestedAssigneePatch.assigneeAgentId !== undefined
        ? input.requestedAssigneePatch.assigneeAgentId ?? null
        : input.issue.assigneeAgentId ?? null;
  const assigneeUserId =
    input.stagePatch.assigneeUserId !== undefined
      ? (input.stagePatch.assigneeUserId as string | null)
      : input.requestedAssigneePatch.assigneeUserId !== undefined
        ? input.requestedAssigneePatch.assigneeUserId ?? null
        : input.issue.assigneeUserId ?? null;
  return { assigneeAgentId, assigneeUserId };
}

export function stripMonitorFromExecutionPolicy(policy: IssueExecutionPolicy | null): IssueExecutionPolicy | null {
  if (!policy) return null;
  if (!policy.monitor) return policy;
  const { monitor: _monitor, ...remainingPolicy } = policy;
  return normalizeIssueExecutionPolicy(remainingPolicy);
}

export function setIssueExecutionPolicyMonitorScheduledBy(
  policy: IssueExecutionPolicy | null,
  scheduledBy: IssueMonitorScheduledBy,
): IssueExecutionPolicy | null {
  if (!policy?.monitor) return policy;
  return {
    ...policy,
    monitor: {
      ...policy.monitor,
      scheduledBy,
    },
  };
}

export function normalizeIssueExecutionPolicy(input: unknown): IssueExecutionPolicy | null {
  if (input == null) return null;
  const parsed = issueExecutionPolicySchema.safeParse(input);
  if (!parsed.success) {
    throw unprocessable("Invalid execution policy", parsed.error.flatten());
  }

  const stages = parsed.data.stages
    .map((stage) => {
      const participants: IssueExecutionStage["participants"] = stage.participants
        .map((participant) => ({
          id: participant.id ?? randomUUID(),
          type: participant.type,
          agentId: participant.type === "agent" ? participant.agentId ?? null : null,
          userId: participant.type === "user" ? participant.userId ?? null : null,
        }))
        .filter((participant) => (participant.type === "agent" ? Boolean(participant.agentId) : Boolean(participant.userId)));

      const dedupedParticipants: IssueExecutionStage["participants"] = [];
      const seen = new Set<string>();
      for (const participant of participants) {
        const key = participant.type === "agent" ? `agent:${participant.agentId}` : `user:${participant.userId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        dedupedParticipants.push(participant);
      }

      if (dedupedParticipants.length === 0) return null;
      return {
        id: stage.id ?? randomUUID(),
        type: stage.type,
        approvalsNeeded: 1 as const,
        participants: dedupedParticipants,
      };
    })
    .filter((stage): stage is NonNullable<typeof stage> => stage !== null);

  const monitor = parsed.data.monitor
    ? {
      nextCheckAt: parsed.data.monitor.nextCheckAt,
      notes: normalizeMonitorNotes(parsed.data.monitor.notes),
      scheduledBy: parsed.data.monitor.scheduledBy,
      kind: parsed.data.monitor.kind ?? null,
      serviceName: normalizeMonitorText(parsed.data.monitor.serviceName),
      externalRef: redactIssueMonitorExternalRef(parsed.data.monitor.externalRef),
      timeoutAt: parsed.data.monitor.timeoutAt ?? null,
      maxAttempts: parsed.data.monitor.maxAttempts ?? null,
      recoveryPolicy: parsed.data.monitor.recoveryPolicy ?? null,
    }
    : null;

  const reviewPreset = parsed.data.reviewPreset;
  const authorizationPolicy = parsed.data.authorizationPolicy;

  if (stages.length === 0 && !monitor && !reviewPreset && !authorizationPolicy
    && parsed.data.maxReviewRounds == null && !parsed.data.requiredQualityReview) return null;

  return {
    mode: parsed.data.mode ?? "normal",
    commentRequired: true,
    stages,
    ...(parsed.data.requiredQualityReview ? { requiredQualityReview: parsed.data.requiredQualityReview } : {}),
    ...(monitor ? { monitor } : {}),
    ...(reviewPreset ? { reviewPreset } : {}),
    ...(authorizationPolicy ? { authorizationPolicy } : {}),
    ...(parsed.data.maxReviewRounds != null ? { maxReviewRounds: parsed.data.maxReviewRounds } : {}),
  };
}

export function parseIssueExecutionState(input: unknown): IssueExecutionState | null {
  if (input == null) return null;
  const parsed = issueExecutionStateSchema.safeParse(input);
  if (!parsed.success) return null;
  return parsed.data;
}

export function assigneePrincipal(input: AssigneeLike): IssueExecutionStagePrincipal | null {
  if (input.assigneeAgentId) {
    return { type: "agent", agentId: input.assigneeAgentId, userId: null };
  }
  if (input.assigneeUserId) {
    return { type: "user", userId: input.assigneeUserId, agentId: null };
  }
  return null;
}

function actorPrincipal(actor: ActorLike): IssueExecutionStagePrincipal | null {
  if (actor.agentId) return { type: "agent", agentId: actor.agentId, userId: null };
  if (actor.userId) return { type: "user", userId: actor.userId, agentId: null };
  return null;
}

function principalsEqual(a: IssueExecutionStagePrincipal | null, b: IssueExecutionStagePrincipal | null): boolean {
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  return a.type === "agent" ? a.agentId === b.agentId : a.userId === b.userId;
}

function resolveMaxReviewRounds(policy: IssueExecutionPolicy | null): number {
  const configured = policy?.maxReviewRounds;
  return typeof configured === "number" && configured > 0 ? configured : DEFAULT_MAX_REVIEW_ROUNDS;
}

/**
 * Who a review stage escalates to when agents exhaust their changes-requested
 * rounds. The agent that created the issue (its managing agent) comes first,
 * so an agent-run review loop goes back up the agent chain instead of to a
 * human. It is skipped when it is the reviewer that just decided or the return
 * assignee, because either would recreate the loop the cap stops. The
 * responsible human, then the creating human, are the fallback. Without any
 * target the loop keeps handing back to the return assignee (pre-existing
 * behavior) rather than stalling the stage.
 */
function reviewEscalationPrincipal(
  issue: IssueLike,
  exclude: Array<IssueExecutionStagePrincipal | null>,
): IssueExecutionStagePrincipal | null {
  const creatorAgentId = issue.createdByAgentId?.trim();
  if (creatorAgentId) {
    const creatorAgent: IssueExecutionStagePrincipal = { type: "agent", agentId: creatorAgentId, userId: null };
    if (!exclude.some((principal) => principalsEqual(principal, creatorAgent))) return creatorAgent;
  }
  const responsible = issue.responsibleUserId?.trim();
  if (responsible) return { type: "user", agentId: null, userId: responsible };
  const creator = issue.createdByUserId?.trim();
  if (creator) return { type: "user", agentId: null, userId: creator };
  return null;
}

function reviewEscalationDelegatePrincipal(agentId: string | null | undefined): IssueExecutionStagePrincipal | null {
  const trimmed = typeof agentId === "string" ? agentId.trim() : "";
  return trimmed ? { type: "agent", agentId: trimmed, userId: null } : null;
}

/**
 * The review escalation delegate is eligible for a review stage only when it
 * is not the implementer it would judge (the return assignee) and not one of
 * the stage's configured reviewers, whose loop the cap exists to stop. When it
 * is either, callers keep the default route. Approval stages never use it.
 */
function eligibleReviewEscalationDelegate(input: {
  delegate: IssueExecutionStagePrincipal | null;
  stage: IssueExecutionStage;
  returnAssignee: IssueExecutionStagePrincipal | null;
}): IssueExecutionStagePrincipal | null {
  const { delegate, stage } = input;
  if (!delegate || stage.type !== "review") return null;
  if (principalsEqual(delegate, input.returnAssignee)) return null;
  if (stageHasParticipant(stage, delegate)) return null;
  return delegate;
}

/**
 * Whether the pending stage is an escalation hold for `participant`.
 *
 * The review-cap escalation records its target in `escalationHolder`, so a
 * genuine hold is recognised whether or not the holder is also a configured
 * stage participant, and a regular review by the same principal (e.g. a creator
 * agent that is itself a configured reviewer) is never mistaken for one.
 *
 * States without the marker (written before it existed, or never escalated)
 * keep the pre-existing rule exactly: only an out-of-stage *user* at or above
 * the cap is held. Agents are held only through the marker.
 */
function isEscalationHold(input: {
  state: IssueExecutionState | null;
  stage: IssueExecutionStage;
  participant: IssueExecutionStagePrincipal;
  policy: IssueExecutionPolicy;
}): boolean {
  const holder = input.state?.escalationHolder ?? null;
  if (holder) return principalsEqual(holder, input.participant);
  return (
    input.participant.type === "user" &&
    !stageHasParticipant(input.stage, input.participant) &&
    (input.state?.changesRequestedCount ?? 0) >= resolveMaxReviewRounds(input.policy)
  );
}

function findStageById(policy: IssueExecutionPolicy, stageId: string | null | undefined) {
  if (!stageId) return null;
  return policy.stages.find((stage) => stage.id === stageId) ?? null;
}

function nextPendingStage(policy: IssueExecutionPolicy, state: IssueExecutionState | null) {
  const completed = new Set(state?.completedStageIds ?? []);
  return policy.stages.find((stage) => !completed.has(stage.id)) ?? null;
}

function nextPendingStageAfter(
  policy: IssueExecutionPolicy,
  completedStage: IssueExecutionStage,
  state: IssueExecutionState | null,
) {
  const completed = new Set(state?.completedStageIds ?? []);
  const completedIndex = policy.stages.findIndex((stage) => stage.id === completedStage.id);
  return policy.stages.find((stage, index) => index > completedIndex && !completed.has(stage.id)) ?? null;
}

function selectStageParticipant(
  stage: IssueExecutionStage,
  opts?: {
    preferred?: IssueExecutionStagePrincipal | null;
    exclude?: IssueExecutionStagePrincipal | null;
  },
): IssueExecutionStagePrincipal | null {
  const participants = stage.participants.filter((participant) => !principalsEqual(participant, opts?.exclude ?? null));
  if (participants.length === 0) return null;
  if (opts?.preferred) {
    const preferred = participants.find((participant) => principalsEqual(participant, opts.preferred ?? null));
    if (preferred) return preferred;
  }
  const first = participants[0];
  return first ? { type: first.type, agentId: first.agentId ?? null, userId: first.userId ?? null } : null;
}

function stageHasParticipant(stage: IssueExecutionStage, participant: IssueExecutionStagePrincipal | null): boolean {
  if (!participant) return false;
  return stage.participants.some((candidate) => principalsEqual(candidate, participant));
}

function patchForPrincipal(principal: IssueExecutionStagePrincipal | null) {
  if (!principal) {
    return { assigneeAgentId: null, assigneeUserId: null };
  }
  return principal.type === "agent"
    ? { assigneeAgentId: principal.agentId ?? null, assigneeUserId: null }
    : { assigneeAgentId: null, assigneeUserId: principal.userId ?? null };
}

function buildCompletedState(previous: IssueExecutionState | null, currentStage: IssueExecutionStage): IssueExecutionState {
  const completedStageIds = Array.from(new Set([...(previous?.completedStageIds ?? []), currentStage.id]));
  return {
    status: COMPLETED_STATUS,
    currentStageId: null,
    currentStageIndex: null,
    currentStageType: null,
    currentParticipant: null,
    returnAssignee: previous?.returnAssignee ?? null,
    reviewRequest: null,
    completedStageIds,
    lastDecisionId: previous?.lastDecisionId ?? null,
    lastDecisionOutcome: "approved",
    monitor: previous?.monitor ?? null,
    changesRequestedCount: 0,
  };
}

function buildStateWithCompletedStages(input: {
  previous: IssueExecutionState | null;
  completedStageIds: string[];
  returnAssignee: IssueExecutionStagePrincipal | null;
}): IssueExecutionState {
  return {
    status: input.previous?.status ?? PENDING_STATUS,
    currentStageId: input.previous?.currentStageId ?? null,
    currentStageIndex: input.previous?.currentStageIndex ?? null,
    currentStageType: input.previous?.currentStageType ?? null,
    currentParticipant: input.previous?.currentParticipant ?? null,
    returnAssignee: input.previous?.returnAssignee ?? input.returnAssignee,
    reviewRequest: input.previous?.reviewRequest ?? null,
    completedStageIds: input.completedStageIds,
    lastDecisionId: input.previous?.lastDecisionId ?? null,
    lastDecisionOutcome: input.previous?.lastDecisionOutcome ?? null,
    monitor: input.previous?.monitor ?? null,
    ...(input.previous?.escalationHolder ? { escalationHolder: input.previous.escalationHolder } : {}),
  };
}

function buildSkippedStageCompletedState(input: {
  previous: IssueExecutionState | null;
  completedStageIds: string[];
  returnAssignee: IssueExecutionStagePrincipal | null;
}): IssueExecutionState {
  return {
    status: COMPLETED_STATUS,
    currentStageId: null,
    currentStageIndex: null,
    currentStageType: null,
    currentParticipant: null,
    returnAssignee: input.previous?.returnAssignee ?? input.returnAssignee,
    reviewRequest: null,
    completedStageIds: input.completedStageIds,
    lastDecisionId: input.previous?.lastDecisionId ?? null,
    lastDecisionOutcome: input.previous?.lastDecisionOutcome ?? null,
    monitor: input.previous?.monitor ?? null,
  };
}

function buildPendingState(input: {
  previous: IssueExecutionState | null;
  stage: IssueExecutionStage;
  stageIndex: number;
  participant: IssueExecutionStagePrincipal;
  returnAssignee: IssueExecutionStagePrincipal | null;
  reviewRequest?: IssueExecutionState["reviewRequest"] | null;
  changesRequestedCount?: number;
  /** Only the review-cap escalation (and re-asserting its hold) sets this. */
  escalationHolder?: IssueExecutionStagePrincipal | null;
}): IssueExecutionState {
  return {
    status: PENDING_STATUS,
    currentStageId: input.stage.id,
    currentStageIndex: input.stageIndex,
    currentStageType: input.stage.type,
    currentParticipant: input.participant,
    returnAssignee: input.returnAssignee,
    reviewRequest: input.reviewRequest ?? null,
    completedStageIds: input.previous?.completedStageIds ?? [],
    lastDecisionId: input.previous?.lastDecisionId ?? null,
    lastDecisionOutcome: input.previous?.lastDecisionOutcome ?? null,
    monitor: input.previous?.monitor ?? null,
    changesRequestedCount: input.changesRequestedCount ?? input.previous?.changesRequestedCount ?? 0,
    ...(input.escalationHolder ? { escalationHolder: input.escalationHolder } : {}),
  };
}

function buildChangesRequestedState(
  previous: IssueExecutionState,
  currentStage: IssueExecutionStage,
  changesRequestedCount: number,
): IssueExecutionState {
  const { escalationHolder: _leftEscalation, ...rest } = previous;
  return {
    ...rest,
    status: CHANGES_REQUESTED_STATUS,
    currentStageId: currentStage.id,
    currentStageType: currentStage.type,
    reviewRequest: null,
    lastDecisionOutcome: "changes_requested",
    changesRequestedCount,
  };
}

function buildPendingStagePatch(input: {
  patch: Record<string, unknown>;
  previous: IssueExecutionState | null;
  policy: IssueExecutionPolicy;
  stage: IssueExecutionStage;
  participant: IssueExecutionStagePrincipal;
  returnAssignee: IssueExecutionStagePrincipal | null;
  reviewRequest?: IssueExecutionState["reviewRequest"] | null;
  changesRequestedCount?: number;
  escalationHolder?: IssueExecutionStagePrincipal | null;
}) {
  input.patch.status = "in_review";
  Object.assign(input.patch, patchForPrincipal(input.participant));
  input.patch.executionState = buildPendingState({
    previous: input.previous,
    stage: input.stage,
    stageIndex: input.policy.stages.findIndex((candidate) => candidate.id === input.stage.id),
    participant: input.participant,
    returnAssignee: input.returnAssignee,
    reviewRequest: input.reviewRequest,
    changesRequestedCount: input.changesRequestedCount,
    escalationHolder: input.escalationHolder,
  });
}

function clearExecutionStatePatch(input: {
  patch: Record<string, unknown>;
  issueStatus: string;
  requestedStatus?: string;
  returnAssignee: IssueExecutionStagePrincipal | null;
}) {
  input.patch.executionState = null;
  if (input.requestedStatus === undefined && input.issueStatus === "in_review" && input.returnAssignee) {
    input.patch.status = "in_progress";
    Object.assign(input.patch, patchForPrincipal(input.returnAssignee));
  }
}

function canAutoSkipPendingStage(input: {
  stage: IssueExecutionStage;
  returnAssignee: IssueExecutionStagePrincipal | null;
  requestedStatus?: string;
}) {
  if (input.requestedStatus !== "done" || input.stage.type !== "review" || !input.returnAssignee) {
    return false;
  }
  return input.stage.participants.length > 0 &&
    input.stage.participants.every((participant) => principalsEqual(participant, input.returnAssignee));
}

function applyIssueExecutionStageTransition(input: TransitionInput): TransitionResult {
  const patch: Record<string, unknown> = {};
  const existingState = parseIssueExecutionState(input.issue.executionState);
  const currentAssignee = assigneePrincipal(input.issue);
  const actor = actorPrincipal(input.actor);
  const requestedAssigneePatchProvided =
    input.requestedAssigneePatch.assigneeAgentId !== undefined || input.requestedAssigneePatch.assigneeUserId !== undefined;
  const explicitAssignee = assigneePrincipal(input.requestedAssigneePatch);
  const currentStage = input.policy ? findStageById(input.policy, existingState?.currentStageId) : null;
  const requestedStatus = input.requestedStatus;
  const activeStage = currentStage && existingState?.status === PENDING_STATUS ? currentStage : null;
  const effectiveReviewRequest = input.reviewRequest === undefined
    ? existingState?.reviewRequest ?? null
    : input.reviewRequest;

  if (!input.policy) {
    if (existingState) {
      patch.executionState = null;
      if (input.issue.status === "in_review" && existingState.returnAssignee) {
        patch.status = "in_progress";
        Object.assign(patch, patchForPrincipal(existingState.returnAssignee));
      }
    }
    return { patch };
  }

  if (
    (input.issue.status === "done" || input.issue.status === "cancelled") &&
    requestedStatus &&
    requestedStatus !== "done" &&
    requestedStatus !== "cancelled"
  ) {
    patch.executionState = null;
    return { patch };
  }

  if (existingState?.currentStageId && !currentStage) {
    // The stored stage id no longer resolves against the (possibly just
    // replaced) policy — e.g. the caller PATCHed a brand-new executionPolicy
    // in the same request that regenerated stage ids. When a review cycle is
    // genuinely live (pending, or awaiting the assignee's response to
    // changes requested), letting `done` ride along on that request would
    // silently drop the cycle and mark the issue complete through a review
    // that never ran — so `done` is rejected. Every other requested status,
    // including a board cancellation that deliberately abandons the cycle,
    // keeps the established clear/return-to-executor behavior below, exactly
    // like a bare policy edit with no requested status.
    const hasLiveReviewCycle =
      existingState.status === PENDING_STATUS || existingState.status === CHANGES_REQUESTED_STATUS;
    if (hasLiveReviewCycle && requestedStatus === "done") {
      throw unprocessable(
        "This issue has an unexecuted review stage from a live review cycle. Resolve the review before marking it done.",
        { code: "unexecuted_review_stage" },
      );
    }
    // A policy with no stages at all, sent by an agent during a live cycle, is
    // almost always a partial write — e.g. `{ monitor: { nextCheckAt } }` to
    // schedule a check. The request schema defaults the omitted `stages` to
    // `[]`, so that write would silently dissolve the review chain and its
    // round limit. Fail loudly instead; the board can still clear it, and an
    // agent that means to drop the review sends `executionPolicy: null`.
    const actorIsAgent = Boolean(input.actor.agentId);
    const removesLiveStage = Boolean(
      input.previousPolicy && findStageById(input.previousPolicy, existingState.currentStageId),
    );
    if (hasLiveReviewCycle && actorIsAgent && removesLiveStage && input.policy.stages.length === 0) {
      throw unprocessable(
        "This executionPolicy has no stages and would remove the live review cycle. Send the issue's current executionPolicy (stages included) with your change, or executionPolicy: null to remove the review deliberately.",
        { code: "live_review_stages_removed" },
      );
    }
    clearExecutionStatePatch({
      patch,
      issueStatus: input.issue.status,
      requestedStatus,
      returnAssignee: existingState.returnAssignee,
    });
    return { patch };
  }

  if (activeStage) {
    const currentParticipant =
      existingState?.currentParticipant ??
      selectStageParticipant(activeStage, {
        exclude: existingState?.returnAssignee ?? null,
      });
    if (!currentParticipant) {
      throw unprocessable(`No eligible ${activeStage.type} participant is configured for this issue`);
    }

    // An escalated review is deliberately held by the managing agent or a
    // human, who need not be in the stage's configured participants.
    // Re-selecting a configured participant would silently undo the escalation
    // on the next unrelated PATCH, so the hold is sticky until the escalation
    // holder decides — their own decisions fall through to the participant
    // decision branch below. The hold is identified by the marker the cap
    // escalation records, not inferred from identity or membership, so an
    // out-of-stage agent that was only a regular reviewer (e.g. one removed
    // by a mid-cycle participant edit) is left to the stage-membership repair
    // below, as before.
    const escalatedHold = isEscalationHold({
      state: existingState,
      stage: activeStage,
      participant: currentParticipant,
      policy: input.policy,
    });
    // A delegate hold is a review-cap hold whose recorded holder is the
    // company's configured review escalation delegate. Its decisions keep the
    // round count (the cap stays exhausted), so a request for changes returns
    // the work to the implementer and the resubmission comes back to the
    // delegate instead of opening another configured-reviewer round.
    const reviewEscalationDelegate = eligibleReviewEscalationDelegate({
      delegate: reviewEscalationDelegatePrincipal(input.reviewEscalationDelegateAgentId),
      stage: activeStage,
      returnAssignee: existingState?.returnAssignee ?? null,
    });
    const delegateHold =
      escalatedHold &&
      principalsEqual(existingState?.escalationHolder ?? null, currentParticipant) &&
      principalsEqual(currentParticipant, reviewEscalationDelegate);
    if (escalatedHold && !principalsEqual(currentParticipant, actor)) {
      // An empty patch would not override the caller's own requested fields,
      // so a status or assignee change from a non-escalated actor must be
      // rejected outright — mirroring the "only the active participant can
      // advance" rule below — and a drifted assignee must be re-asserted
      // rather than left pointing away from the escalation holder.
      const attemptedAdvanceDuringHold =
        (requestedStatus !== undefined && requestedStatus !== "in_review") ||
        (requestedAssigneePatchProvided && !principalsEqual(explicitAssignee, currentParticipant));
      if (attemptedAdvanceDuringHold) {
        throw unprocessable("Only the escalated reviewer can advance the current execution stage");
      }
      const holdDrifted =
        input.issue.status !== "in_review" ||
        !principalsEqual(currentAssignee, currentParticipant);
      if (holdDrifted) {
        patch.status = "in_review";
        Object.assign(patch, patchForPrincipal(currentParticipant));
        patch.executionState = buildPendingState({
          previous: existingState,
          stage: activeStage,
          stageIndex: input.policy.stages.findIndex((candidate) => candidate.id === activeStage.id),
          participant: currentParticipant,
          returnAssignee: existingState?.returnAssignee ?? null,
          reviewRequest: effectiveReviewRequest,
          escalationHolder: existingState?.escalationHolder ?? null,
        });
      }
      return { patch };
    }
    if (!escalatedHold && !stageHasParticipant(activeStage, currentParticipant)) {
      const participant = selectStageParticipant(activeStage, {
        preferred: explicitAssignee ?? existingState?.currentParticipant ?? null,
        exclude: existingState?.returnAssignee ?? null,
      });
      if (!participant) {
        clearExecutionStatePatch({
          patch,
          issueStatus: input.issue.status,
          requestedStatus,
          returnAssignee: existingState?.returnAssignee ?? null,
        });
        return { patch };
      }

      buildPendingStagePatch({
        patch,
        previous: existingState,
        policy: input.policy,
        stage: activeStage,
        participant,
        returnAssignee: existingState?.returnAssignee ?? currentAssignee ?? actor,
        reviewRequest: effectiveReviewRequest,
      });
      return {
        patch,
        workflowControlledAssignment: true,
      };
    }

    if (principalsEqual(currentParticipant, actor)) {
      if (requestedStatus === "done") {
        if (!input.commentBody?.trim()) {
          throw unprocessable(`Approving a review or approval stage requires a comment. ${STAGE_DECISION_COMMENT_HINT}`);
        }
        const approvedState = buildCompletedState(existingState, activeStage);
        // Only stages after the stage being approved are advance candidates.
        // Scanning the whole policy could wrap back to the first stage when
        // earlier completedStageIds no longer match the policy (e.g. stage ids
        // were regenerated by a mid-flow policy edit), turning a final-stage
        // approval into an endless re-review loop (#7893).
        const nextStage = nextPendingStageAfter(input.policy, activeStage, approvedState);

        if (!nextStage) {
          patch.executionState = approvedState;
          return {
            patch,
            decision: {
              stageId: activeStage.id,
              stageType: activeStage.type,
              outcome: "approved",
              body: input.commentBody.trim(),
            },
          };
        }

        const participant = selectStageParticipant(nextStage, {
          preferred: explicitAssignee,
          exclude: existingState?.returnAssignee ?? null,
        });
        if (!participant) {
          throw unprocessable(`No eligible ${nextStage.type} participant is configured for this issue`);
        }

        buildPendingStagePatch({
          patch,
          previous: approvedState,
          policy: input.policy,
          stage: nextStage,
          participant,
          returnAssignee: existingState?.returnAssignee ?? currentAssignee ?? actor,
          reviewRequest: input.reviewRequest ?? null,
        });
        return {
          patch,
          decision: {
            stageId: activeStage.id,
            stageType: activeStage.type,
            outcome: "approved",
            body: input.commentBody.trim(),
          },
          workflowControlledAssignment: true,
        };
      }

      if (
        input.allowBoardOverride &&
        requestedStatus &&
        requestedStatus !== "in_review" &&
        requestedStatus !== "in_progress"
      ) {
        patch.executionState = null;
        return { patch };
      }

      if (requestedStatus && requestedStatus !== "in_review") {
        if (!input.commentBody?.trim()) {
          throw unprocessable(`Requesting changes requires a comment. ${STAGE_DECISION_COMMENT_HINT}`);
        }
        if (!existingState?.returnAssignee) {
          throw unprocessable("This execution stage has no return assignee");
        }
        const decision = {
          stageId: activeStage.id,
          stageType: activeStage.type,
          outcome: "changes_requested" as const,
          body: input.commentBody.trim(),
        };
        // Human decisions, and decisions by the escalation holder, reset the
        // round counter: the cap exists to stop unattended agent↔agent
        // ping-pong, not to limit the review it escalated to. The review
        // escalation delegate is the exception: its request for changes keeps
        // the count, so the stage stays exhausted and the resubmission returns
        // to the delegate (see the resubmission branch below).
        const actorResetsRounds = !delegateHold && (actor?.type === "user" || escalatedHold);
        const nextRounds = delegateHold
          ? existingState.changesRequestedCount ?? 0
          : actorResetsRounds ? 0 : (existingState.changesRequestedCount ?? 0) + 1;
        if (!delegateHold && !actorResetsRounds && nextRounds >= resolveMaxReviewRounds(input.policy)) {
          // A configured review escalation delegate takes precedence over the
          // creator-agent and human routes; when it is ineligible (it is the
          // implementer or a configured reviewer of this stage) the default
          // route applies unchanged.
          const delegateTarget = principalsEqual(reviewEscalationDelegate, actor) ? null : reviewEscalationDelegate;
          const escalationTarget =
            delegateTarget ?? reviewEscalationPrincipal(input.issue, [actor, existingState.returnAssignee]);
          if (escalationTarget) {
            // Rounds exhausted: keep the stage pending but hand it to the
            // managing agent (or responsible human) instead of bouncing back
            // to the implementer.
            // The recorded changes-requested decision carries the reviewer's
            // reasoning; the human approves, requests changes (resetting the
            // counter), or re-scopes.
            buildPendingStagePatch({
              patch,
              previous: existingState,
              policy: input.policy,
              stage: activeStage,
              participant: escalationTarget,
              returnAssignee: existingState.returnAssignee,
              reviewRequest: effectiveReviewRequest,
              changesRequestedCount: nextRounds,
              escalationHolder: escalationTarget,
            });
            return {
              patch,
              decision,
              workflowControlledAssignment: true,
            };
          }
        }
        patch.status = "in_progress";
        Object.assign(patch, patchForPrincipal(existingState.returnAssignee));
        patch.executionState = buildChangesRequestedState(existingState, activeStage, nextRounds);
        return {
          patch,
          decision,
          workflowControlledAssignment: true,
        };
      }
    }

    const attemptedStageAdvance =
      (requestedStatus !== undefined && requestedStatus !== "in_review") ||
      (requestedAssigneePatchProvided && !principalsEqual(explicitAssignee, currentParticipant));
    const stageStateDrifted =
      input.issue.status !== "in_review" ||
      !principalsEqual(currentAssignee, currentParticipant) ||
      !principalsEqual(existingState?.currentParticipant ?? null, currentParticipant);

    if (input.allowBoardOverride && attemptedStageAdvance) {
      if (requestedStatus !== undefined && requestedStatus !== "in_review") {
        patch.executionState = null;
        return { patch };
      }
      // Assignee-only override: the issue stays in_review, so clearing the
      // execution state would strand it with no participant or return
      // assignment. Re-pend the stage when the board's chosen assignee is an
      // eligible stage participant; otherwise (unassign or a non-participant)
      // dissolve the review — storing an ineligible participant would be
      // silently replaced by the stage-membership repair on the next
      // transition.
      if (explicitAssignee && stageHasParticipant(activeStage, explicitAssignee)) {
        buildPendingStagePatch({
          patch,
          previous: existingState,
          policy: input.policy,
          stage: activeStage,
          participant: explicitAssignee,
          returnAssignee: existingState?.returnAssignee ?? currentAssignee ?? actor,
          reviewRequest: effectiveReviewRequest,
        });
        return { patch };
      }
      patch.executionState = null;
      if (input.issue.status === "in_review") {
        patch.status = "in_progress";
      }
      return { patch };
    }

    if (attemptedStageAdvance && !stageStateDrifted) {
      throw unprocessable("Only the active reviewer or approver can advance the current execution stage");
    }

    if (stageStateDrifted) {
      // The escalation holder's own non-decision update (e.g. after checkout
      // moved the issue to in_progress) repairs drift here; it has not left
      // the escalation, so its marker must survive the repair.
      buildPendingStagePatch({
        patch,
        previous: existingState,
        policy: input.policy,
        stage: activeStage,
        participant: currentParticipant,
        returnAssignee: existingState?.returnAssignee ?? currentAssignee ?? actor,
        reviewRequest: effectiveReviewRequest,
        escalationHolder: escalatedHold ? existingState?.escalationHolder ?? null : null,
      });
      return {
        patch,
        workflowControlledAssignment: true,
      };
    }

    return { patch };
  }

  const shouldStartWorkflow =
    requestedStatus === "done" ||
    requestedStatus === "in_review";

  if (!shouldStartWorkflow) {
    return { patch };
  }

  // A workflow whose execution already completed is terminal for approve/done:
  // closing the issue must not restart the chain at the first stage (#7893).
  if (requestedStatus === "done" && existingState?.status === COMPLETED_STATUS) {
    return { patch };
  }

  // Resubmission after the review escalation delegate requested changes: the
  // stage's rounds are still exhausted and the delegate is the recorded
  // participant, so the work goes back to the delegate (count unchanged)
  // rather than to the configured reviewers. Without a configured, eligible
  // delegate this branch never applies.
  if (existingState?.status === CHANGES_REQUESTED_STATUS && currentStage) {
    const resubmissionReturnAssignee = existingState.returnAssignee ?? currentAssignee;
    const delegate = eligibleReviewEscalationDelegate({
      delegate: reviewEscalationDelegatePrincipal(input.reviewEscalationDelegateAgentId),
      stage: currentStage,
      returnAssignee: resubmissionReturnAssignee,
    });
    if (
      delegate &&
      principalsEqual(existingState.currentParticipant ?? null, delegate) &&
      (existingState.changesRequestedCount ?? 0) >= resolveMaxReviewRounds(input.policy)
    ) {
      buildPendingStagePatch({
        patch,
        previous: existingState,
        policy: input.policy,
        stage: currentStage,
        participant: delegate,
        returnAssignee: resubmissionReturnAssignee,
        reviewRequest: input.reviewRequest ?? null,
        escalationHolder: delegate,
      });
      return {
        patch,
        workflowControlledAssignment: true,
      };
    }
  }

  let pendingStage =
    existingState?.status === CHANGES_REQUESTED_STATUS && currentStage
      ? currentStage
      : nextPendingStage(input.policy, existingState);
  if (!pendingStage) return { patch };

  const returnAssignee = existingState?.returnAssignee ?? currentAssignee;
  const skippedStageIds = [...(existingState?.completedStageIds ?? [])];
  let participant = selectStageParticipant(pendingStage, {
    preferred:
      existingState?.status === CHANGES_REQUESTED_STATUS
        ? explicitAssignee ?? existingState.currentParticipant ?? null
        : explicitAssignee,
    exclude: returnAssignee,
  });
  while (!participant && canAutoSkipPendingStage({ stage: pendingStage, returnAssignee, requestedStatus })) {
    skippedStageIds.push(pendingStage.id);
    pendingStage = nextPendingStage(
      input.policy,
      buildStateWithCompletedStages({
        previous: existingState,
        completedStageIds: skippedStageIds,
        returnAssignee,
      }),
    );
    if (!pendingStage) {
      patch.executionState = buildSkippedStageCompletedState({
        previous: existingState,
        completedStageIds: skippedStageIds,
        returnAssignee,
      });
      return { patch };
    }
    participant = selectStageParticipant(pendingStage, {
      preferred:
        existingState?.status === CHANGES_REQUESTED_STATUS
          ? explicitAssignee ?? existingState.currentParticipant ?? null
          : explicitAssignee,
      exclude: returnAssignee,
    });
  }
  if (!participant) {
    throw unprocessable(`No eligible ${pendingStage.type} participant is configured for this issue`);
  }

  buildPendingStagePatch({
    patch,
    previous:
      skippedStageIds.length === (existingState?.completedStageIds ?? []).length
        ? existingState
        : buildStateWithCompletedStages({
            previous: existingState,
            completedStageIds: skippedStageIds,
            returnAssignee,
          }),
    policy: input.policy,
    stage: pendingStage,
    participant,
    returnAssignee,
    reviewRequest: input.reviewRequest ?? null,
  });
  return {
    patch,
    workflowControlledAssignment: true,
  };
}

function applyMonitorTransition(input: TransitionInput, stagePatch: Record<string, unknown>) {
  const patch: Record<string, unknown> = {};
  const previousPolicy = input.previousPolicy ?? normalizeIssueExecutionPolicy(input.issue.executionPolicy ?? null);
  const existingState = parseIssueExecutionState(input.issue.executionState);
  const currentMonitorState = derivePersistedMonitorState({
    issue: input.issue,
    state: existingState,
    policy: previousPolicy,
  });
  const nextStatus =
    typeof stagePatch.status === "string"
      ? (stagePatch.status as string)
      : input.requestedStatus ?? input.issue.status;
  const { assigneeAgentId, assigneeUserId } = nextAssigneeIds({
    issue: input.issue,
    requestedAssigneePatch: input.requestedAssigneePatch,
    stagePatch,
  });
  const stageState =
    stagePatch.executionState !== undefined
      ? parseIssueExecutionState(stagePatch.executionState)
      : existingState;
  const invalidReason = input.policy?.monitor
    ? monitorClearReasonForIssue(nextStatus, assigneeAgentId, assigneeUserId)
    : null;

  let targetMonitorState = currentMonitorState;

  if (input.policy?.monitor) {
    if (invalidReason) {
      if (input.monitorExplicitlyUpdated) {
        throw unprocessable(MONITOR_INVALID_MESSAGE);
      }
      patch.executionPolicy = stripMonitorFromExecutionPolicy(input.policy);
      patch.monitorNextCheckAt = null;
      patch.monitorWakeRequestedAt = null;
      targetMonitorState = buildClearedMonitorState({
        previous: currentMonitorState,
        clearReason: invalidReason,
        clearedAt: new Date(),
      });
    } else {
      const exhaustedReason = exhaustedMonitorClearReason({
        monitor: input.policy.monitor,
        attemptCount: currentMonitorState?.attemptCount ?? 0,
        now: new Date(),
      });
      if (exhaustedReason) {
        if (input.monitorExplicitlyUpdated) {
          throw unprocessable(MONITOR_BOUNDS_EXHAUSTED_MESSAGE, { clearReason: exhaustedReason });
        }
        patch.executionPolicy = stripMonitorFromExecutionPolicy(input.policy);
        patch.monitorNextCheckAt = null;
        patch.monitorWakeRequestedAt = null;
        targetMonitorState = buildClearedMonitorState({
          previous: currentMonitorState,
          clearReason: exhaustedReason,
          clearedAt: new Date(),
        });
      } else {
        patch.monitorNextCheckAt = new Date(input.policy.monitor.nextCheckAt);
        patch.monitorWakeRequestedAt = null;
        patch.monitorNotes = input.policy.monitor.notes ?? null;
        patch.monitorScheduledBy = input.policy.monitor.scheduledBy;
        targetMonitorState = buildScheduledMonitorState(currentMonitorState, input.policy.monitor);
      }
    }
  } else if (previousPolicy?.monitor) {
    patch.monitorNextCheckAt = null;
    patch.monitorWakeRequestedAt = null;
    targetMonitorState = buildClearedMonitorState({
      previous: currentMonitorState,
      clearReason:
        input.monitorExplicitlyUpdated
          ? "manual"
          : monitorClearReasonForIssue(nextStatus, assigneeAgentId, assigneeUserId) ?? "manual",
      clearedAt: new Date(),
    });
  }

  if (stagePatch.executionState !== undefined || !monitorStatesEqual(currentMonitorState, targetMonitorState)) {
    patch.executionState = executionStateWithMonitor(stageState, targetMonitorState);
  }

  return patch;
}

export function buildInitialIssueMonitorFields(input: {
  policy: IssueExecutionPolicy | null;
  status: string;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
}) {
  if (!input.policy?.monitor) return {};
  if (!issueAllowsMonitor(input.status, input.assigneeAgentId ?? null, input.assigneeUserId ?? null)) {
    throw unprocessable(MONITOR_INVALID_MESSAGE);
  }
  const exhaustedReason = exhaustedMonitorClearReason({
    monitor: input.policy.monitor,
    attemptCount: 0,
    now: new Date(),
  });
  if (exhaustedReason) {
    throw unprocessable(MONITOR_BOUNDS_EXHAUSTED_MESSAGE, { clearReason: exhaustedReason });
  }

  const monitorState = buildScheduledMonitorState(null, input.policy.monitor);
  return {
    monitorNextCheckAt: new Date(input.policy.monitor.nextCheckAt),
    monitorWakeRequestedAt: null,
    monitorNotes: input.policy.monitor.notes ?? null,
    monitorScheduledBy: input.policy.monitor.scheduledBy,
    executionState: executionStateWithMonitor(null, monitorState) as Record<string, unknown> | null,
  };
}

export function buildIssueMonitorTriggeredPatch(input: {
  issue: IssueLike;
  policy: IssueExecutionPolicy | null;
  triggeredAt: Date;
}) {
  const existingState = parseIssueExecutionState(input.issue.executionState);
  const currentMonitorState = derivePersistedMonitorState({
    issue: input.issue,
    state: existingState,
    policy: input.policy,
  });
  const nextMonitorState = buildTriggeredMonitorState({
    previous: currentMonitorState,
    triggeredAt: input.triggeredAt,
  });

  return {
    executionPolicy: stripMonitorFromExecutionPolicy(input.policy) as Record<string, unknown> | null,
    executionState: executionStateWithMonitor(existingState, nextMonitorState) as Record<string, unknown> | null,
    monitorNextCheckAt: null,
    monitorWakeRequestedAt: null,
    monitorLastTriggeredAt: input.triggeredAt,
    monitorAttemptCount: nextMonitorState.attemptCount,
    monitorNotes: nextMonitorState.notes,
    monitorScheduledBy: nextMonitorState.scheduledBy,
  };
}

/** Consecutive deferred fires already recorded for the issue's current scheduled check. */
export function issueMonitorDeferredCount(issue: IssueLike): number {
  const nextCheckAt = isoString(issue.monitorNextCheckAt);
  if (!nextCheckAt) return 0;
  return deferredCountFor(parseIssueExecutionState(issue.executionState)?.monitor, nextCheckAt).deferredCount ?? 0;
}

/**
 * A scheduled fire that could not dispatch (execution held or dispatch failed)
 * still consumes an attempt and moves the check forward, so attempt and
 * timeout bounds keep making progress instead of the same row re-firing.
 */
export function buildIssueMonitorDeferredPatch(input: {
  issue: IssueLike;
  policy: IssueExecutionPolicy | null;
  nextCheckAt: Date;
  deferredCount: number;
}) {
  const existingState = parseIssueExecutionState(input.issue.executionState);
  const currentMonitorState = derivePersistedMonitorState({
    issue: input.issue,
    state: existingState,
    policy: input.policy,
  });
  const attemptCount = (currentMonitorState?.attemptCount ?? 0) + 1;
  const nextMonitorState: IssueExecutionMonitorState = {
    status: "scheduled",
    lastTriggeredAt: currentMonitorState?.lastTriggeredAt ?? null,
    notes: currentMonitorState?.notes ?? null,
    scheduledBy: currentMonitorState?.scheduledBy ?? null,
    ...monitorMetadataFromState(currentMonitorState),
    nextCheckAt: input.nextCheckAt.toISOString(),
    attemptCount,
    deferredCount: input.deferredCount,
    clearedAt: null,
    clearReason: null,
  };

  return {
    executionState: executionStateWithMonitor(existingState, nextMonitorState) as Record<string, unknown> | null,
    monitorNextCheckAt: input.nextCheckAt,
    monitorWakeRequestedAt: null,
    monitorAttemptCount: attemptCount,
  };
}

/**
 * A due fire deferred because an active subtree pause hold covers the issue is
 * a maintenance wait, not a failed attempt. It keeps the attempt count, the
 * deferred-fire count and all monitor metadata unchanged, records the original
 * check time and holding pause hold for diagnostics, and re-arms the check at
 * nextCheckAt so the issue keeps a future durable wait until the hold ends.
 */
export function buildIssueMonitorMaintenanceWaitPatch(input: {
  issue: IssueLike;
  policy: IssueExecutionPolicy | null;
  nextCheckAt: Date;
  holdId: string;
  now: Date;
}) {
  const existingState = parseIssueExecutionState(input.issue.executionState);
  const currentMonitorState = derivePersistedMonitorState({
    issue: input.issue,
    state: existingState,
    policy: input.policy,
  });
  const previousWait = currentMonitorState?.maintenanceWait;
  const dueAt = isoString(input.issue.monitorNextCheckAt) ?? currentMonitorState?.nextCheckAt ?? input.now.toISOString();
  const nextMonitorState: IssueExecutionMonitorState = {
    status: "scheduled",
    lastTriggeredAt: currentMonitorState?.lastTriggeredAt ?? null,
    notes: currentMonitorState?.notes ?? null,
    scheduledBy: currentMonitorState?.scheduledBy ?? null,
    ...monitorMetadataFromState(currentMonitorState),
    nextCheckAt: input.nextCheckAt.toISOString(),
    attemptCount: currentMonitorState?.attemptCount ?? 0,
    ...(currentMonitorState?.deferredCount ? { deferredCount: currentMonitorState.deferredCount } : {}),
    maintenanceWait: {
      holdId: input.holdId,
      originalNextCheckAt: previousWait?.originalNextCheckAt ?? dueAt,
      since: previousWait?.since ?? input.now.toISOString(),
      heldFireCount: (previousWait?.heldFireCount ?? 0) + 1,
    },
    clearedAt: null,
    clearReason: null,
  };

  return {
    executionState: executionStateWithMonitor(existingState, nextMonitorState) as Record<string, unknown> | null,
    monitorNextCheckAt: input.nextCheckAt,
    monitorWakeRequestedAt: null,
  };
}

export function buildIssueMonitorClearedPatch(input: {
  issue: IssueLike;
  policy: IssueExecutionPolicy | null;
  clearReason: IssueExecutionMonitorClearReason;
  clearedAt?: Date;
}) {
  const existingState = parseIssueExecutionState(input.issue.executionState);
  const currentMonitorState = derivePersistedMonitorState({
    issue: input.issue,
    state: existingState,
    policy: input.policy,
  });
  const nextMonitorState = buildClearedMonitorState({
    previous: currentMonitorState,
    clearReason: input.clearReason,
    clearedAt: input.clearedAt ?? new Date(),
  });

  return {
    executionPolicy: stripMonitorFromExecutionPolicy(input.policy) as Record<string, unknown> | null,
    executionState: executionStateWithMonitor(existingState, nextMonitorState) as Record<string, unknown> | null,
    monitorNextCheckAt: null,
    monitorWakeRequestedAt: null,
  };
}

export const REVIEW_ESCALATION_CLAIM_DENIED = "Only the review escalation delegate can claim an exhausted review held by the escalated user";

/**
 * The explicit claim of one existing review-cap hold by the company's review
 * escalation delegate. It moves only the hold: the current participant, the
 * escalation marker and the assignee become the delegate. The stage id and
 * index, the round count and cap, the return assignee, the review request and
 * the decision history stay exactly as they are, and no decision is made.
 *
 * Every refusal is the 422 the hold guard uses, with no state change. The
 * claim is refused unless all of these hold:
 * - the actor is the configured delegate, and the delegate is neither the
 *   return assignee nor a configured participant of the stage;
 * - the issue is `in_review` with a pending `review` stage (never `approval`);
 * - the stage's rounds are exhausted (`changesRequestedCount >= cap`);
 * - the current participant is a user that is not a configured participant of
 *   the stage, i.e. the user the review-cap escalation chose (when the state
 *   records the escalation marker, it must name that same user).
 */
export function buildReviewEscalationClaimPatch(input: {
  issue: IssueLike;
  policy: IssueExecutionPolicy | null;
  actor: ActorLike;
  reviewEscalationDelegateAgentId: string | null | undefined;
}): {
  patch: { status: "in_review"; assigneeAgentId: string; assigneeUserId: null; executionState: IssueExecutionState };
  previousParticipant: IssueExecutionStagePrincipal;
  stage: IssueExecutionStage;
  state: IssueExecutionState;
  maxReviewRounds: number;
} {
  const deny = (reason: string): never => {
    throw unprocessable(REVIEW_ESCALATION_CLAIM_DENIED, { code: "review_escalation_claim_denied", reason });
  };
  const delegate = reviewEscalationDelegatePrincipal(input.reviewEscalationDelegateAgentId);
  const actor = actorPrincipal(input.actor);
  if (!delegate) return deny("no_delegate_configured");
  if (!actor || actor.type !== "agent" || !principalsEqual(actor, delegate)) return deny("actor_is_not_delegate");
  if (!input.policy) return deny("no_execution_policy");
  const state = parseIssueExecutionState(input.issue.executionState);
  if (!state || state.status !== PENDING_STATUS) return deny("no_pending_stage");
  if (input.issue.status !== "in_review") return deny("issue_not_in_review");
  const stage = findStageById(input.policy, state.currentStageId);
  if (!stage) return deny("stage_not_found");
  if (stage.type !== "review" || state.currentStageType !== "review") return deny("not_a_review_stage");
  const maxReviewRounds = resolveMaxReviewRounds(input.policy);
  if ((state.changesRequestedCount ?? 0) < maxReviewRounds) return deny("review_rounds_not_exhausted");
  const participant = state.currentParticipant ?? null;
  if (!participant || participant.type !== "user") return deny("not_held_by_escalated_user");
  if (stageHasParticipant(stage, participant)) return deny("participant_is_configured_reviewer");
  if (state.escalationHolder && !principalsEqual(state.escalationHolder, participant)) {
    return deny("participant_is_not_escalation_holder");
  }
  if (!eligibleReviewEscalationDelegate({ delegate, stage, returnAssignee: state.returnAssignee ?? null })) {
    return deny("delegate_is_implementer_or_reviewer");
  }
  const executionState: IssueExecutionState = {
    ...state,
    currentParticipant: delegate,
    escalationHolder: delegate,
  };
  return {
    patch: {
      status: "in_review",
      assigneeAgentId: delegate.agentId!,
      assigneeUserId: null,
      executionState,
    },
    previousParticipant: participant,
    stage,
    state,
    maxReviewRounds,
  };
}

export const EXECUTION_RETURN_TO_EXECUTOR_REFUSED =
  "This issue has no pending execution stage that can be returned to its executor";
export const EXECUTION_RETURN_TO_EXECUTOR_STALE =
  "The pending execution stage changed since it was read; re-read the issue and retry";
export const EXECUTION_RETURN_TO_EXECUTOR_FORBIDDEN =
  "Only a board member with write access or the review escalation delegate can return this stage to its executor";

/** Who is asking to return the stage; the route establishes this before the call. */
export type ExecutionReturnAuthority =
  | { type: "board"; userId: string | null }
  | { type: "review_escalation_delegate"; agentId: string };

/**
 * Administrative return of a pending execution stage to its return assignee,
 * without a decision.
 *
 * The result is the state a request for changes leaves behind, except that no
 * decision is recorded: the issue goes to `in_progress` under the return
 * assignee and the execution state becomes `changes_requested`. Everything
 * else in the state is kept as it is (stage id, index and type, participant,
 * return assignee, completed stages, last decision id and outcome, monitor and
 * the round count), `reviewRequest` is cleared, and the policy is not touched.
 * A later resubmission therefore re-pends the same stage with the same
 * participant and count through the normal changes-requested branch.
 *
 * Refusals change nothing:
 * - 422 `execution_return_refused` when the issue is not `in_review` with a
 *   pending stage of its current policy, a current participant and a return
 *   assignee, or when the stage is an escalation hold (those keep the
 *   review-escalation claim and decision paths);
 * - 409 `execution_return_stale` when the stage id, or the round count when
 *   given, differs from what the caller expected;
 * - 403 `execution_return_forbidden` when the acting board user or review
 *   escalation delegate is the return assignee or the current participant.
 */
export function buildReturnToExecutorPatch(input: {
  issue: IssueLike;
  policy: IssueExecutionPolicy | null;
  authority: ExecutionReturnAuthority;
  expectedStageId: string;
  expectedChangesRequestedCount?: number | null;
}): {
  patch: {
    status: "in_progress";
    assigneeAgentId: string | null;
    assigneeUserId: string | null;
    executionState: IssueExecutionState;
  };
  stage: IssueExecutionStage;
  state: IssueExecutionState;
  previousParticipant: IssueExecutionStagePrincipal;
  returnAssignee: IssueExecutionStagePrincipal;
} {
  const refuse = (reason: string): never => {
    throw unprocessable(EXECUTION_RETURN_TO_EXECUTOR_REFUSED, { code: "execution_return_refused", reason });
  };
  if (input.issue.status !== "in_review") return refuse("issue_not_in_review");
  if (!input.policy) return refuse("no_execution_policy");
  const state = parseIssueExecutionState(input.issue.executionState);
  if (!state || state.status !== PENDING_STATUS) return refuse("no_pending_stage");
  const stage = findStageById(input.policy, state.currentStageId);
  if (!stage) return refuse("stage_not_found");
  const previousParticipant = state.currentParticipant ?? null;
  if (!previousParticipant) return refuse("no_current_participant");
  const returnAssignee = state.returnAssignee ?? null;
  if (!returnAssignee) return refuse("no_return_assignee");
  if (
    state.escalationHolder ||
    isEscalationHold({ state, stage, participant: previousParticipant, policy: input.policy })
  ) {
    return refuse("escalation_hold");
  }

  const changesRequestedCount = state.changesRequestedCount ?? 0;
  if (stage.id !== input.expectedStageId) {
    throw conflict(EXECUTION_RETURN_TO_EXECUTOR_STALE, {
      code: "execution_return_stale",
      reason: "stage_mismatch",
      currentStageId: stage.id,
    });
  }
  if (
    typeof input.expectedChangesRequestedCount === "number" &&
    input.expectedChangesRequestedCount !== changesRequestedCount
  ) {
    throw conflict(EXECUTION_RETURN_TO_EXECUTOR_STALE, {
      code: "execution_return_stale",
      reason: "count_mismatch",
      changesRequestedCount,
    });
  }

  // Neither the implementer nor the current reviewer may use this to bounce
  // the stage, whichever authority they act under.
  const actingPrincipal: IssueExecutionStagePrincipal | null =
    input.authority.type === "review_escalation_delegate"
      ? { type: "agent", agentId: input.authority.agentId, userId: null }
      : input.authority.userId
        ? { type: "user", agentId: null, userId: input.authority.userId }
        : null;
  const actorLabel = input.authority.type === "review_escalation_delegate" ? "delegate" : "actor";
  if (principalsEqual(actingPrincipal, returnAssignee)) {
    throw forbidden(EXECUTION_RETURN_TO_EXECUTOR_FORBIDDEN, {
      code: "execution_return_forbidden",
      reason: `${actorLabel}_is_return_assignee`,
    });
  }
  if (principalsEqual(actingPrincipal, previousParticipant)) {
    throw forbidden(EXECUTION_RETURN_TO_EXECUTOR_FORBIDDEN, {
      code: "execution_return_forbidden",
      reason: `${actorLabel}_is_current_participant`,
    });
  }

  const executionState: IssueExecutionState = {
    ...state,
    status: CHANGES_REQUESTED_STATUS,
    reviewRequest: null,
  };
  return {
    patch: {
      status: "in_progress",
      ...patchForPrincipal(returnAssignee),
      executionState,
    },
    stage,
    state,
    previousParticipant,
    returnAssignee,
  };
}

export function applyIssueExecutionPolicyTransition(input: TransitionInput): TransitionResult {
  const stageResult = applyIssueExecutionStageTransition(input);
  const monitorPatch = applyMonitorTransition(input, stageResult.patch);
  Object.assign(stageResult.patch, monitorPatch);
  return stageResult;
}

export function applyIssueMonitorPolicyTransition(input: TransitionInput): TransitionResult {
  return { patch: applyMonitorTransition(input, {}) };
}
