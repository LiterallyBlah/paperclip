import type { Agent, Issue } from "@paperclipai/shared";
import { formatUserLabel } from "../lib/assignees";
import { cn } from "../lib/utils";
import {
  isReviewStageParticipant,
  ReviewStageDecisionActions,
  type ReviewStageParticipant,
} from "./ReviewStageDecisionActions";

interface IssueReviewStageDecisionPanelProps {
  issue: Pick<Issue, "id" | "companyId" | "status" | "assigneeUserId" | "executionState">;
  currentUserId: string | null;
  agentMap?: Map<string, Agent>;
  userLabelMap?: ReadonlyMap<string, string> | null;
  className?: string;
}

/**
 * Task-page home for a pending native review/approval stage decision (BLA-180).
 *
 * Renders when the stage is held by a user — controls for that user, a "who
 * must act" line for everyone else — and when the task is assigned to the
 * viewer while the stage still waits on someone else (a drifted record), so the
 * viewer is told plainly that they cannot decide it. Agent-held stages assigned
 * to their participant keep the existing properties-panel label only.
 */
export function IssueReviewStageDecisionPanel({
  issue,
  currentUserId,
  agentMap,
  userLabelMap,
  className,
}: IssueReviewStageDecisionPanelProps) {
  const state = issue.executionState;
  if (issue.status !== "in_review" || state?.status !== "pending" || !state.currentParticipant) return null;
  const participant: ReviewStageParticipant = {
    type: state.currentParticipant.type,
    agentId: state.currentParticipant.agentId ?? null,
    userId: state.currentParticipant.userId ?? null,
  };
  const viewerDecides = isReviewStageParticipant(participant, currentUserId);
  const viewerIsDriftedAssignee =
    !viewerDecides && Boolean(currentUserId && issue.assigneeUserId === currentUserId);
  if (participant.type !== "user" && !viewerIsDriftedAssignee) return null;

  const stageType = state.currentStageType === "approval" ? "approval" : "review";
  const participantLabel = participant.type === "agent"
    ? (participant.agentId ? agentMap?.get(participant.agentId)?.name ?? null : null)
    : formatUserLabel(participant.userId, userLabelMap);
  const heading = viewerDecides
    ? `${stageType === "approval" ? "Approval" : "Review"} decision needed from you`
    : `${stageType === "approval" ? "Approval" : "Review"} pending`;

  return (
    <section
      aria-label={heading}
      data-testid="issue-review-stage-panel"
      className={cn("rounded-lg border border-border bg-card p-3", className)}
    >
      <h2 className="mb-2 text-sm font-semibold text-foreground">{heading}</h2>
      <ReviewStageDecisionActions
        issueId={issue.id}
        companyId={issue.companyId}
        stageType={stageType}
        participant={participant}
        participantLabel={participantLabel}
        currentUserId={currentUserId}
      />
      {viewerIsDriftedAssignee ? (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="issue-review-stage-drift">
          This task is assigned to you, but the stage is held by its participant. To move the
          decision, reassign the task to a configured reviewer in Properties, or comment to ask the
          participant to act.
        </p>
      ) : null}
    </section>
  );
}
