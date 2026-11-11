import { useId, useRef, useState, type ReactNode } from "react";
import { Link } from "@/lib/router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ExternalLink, Loader2, RotateCcw } from "lucide-react";
import { issuesApi } from "../api/issues";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

export type ReviewStageDecision = "approve" | "request_changes";

export interface ReviewStageParticipant {
  type: "agent" | "user";
  agentId?: string | null;
  userId?: string | null;
}

interface ReviewStageDecisionActionsProps {
  issueId: string;
  companyId: string;
  stageType: "review" | "approval";
  participant: ReviewStageParticipant;
  /** Display name for the participant when the viewer is not the one who must act. */
  participantLabel?: string | null;
  currentUserId?: string | null;
  /** Shown beside the "who must act" line for viewers who cannot decide here. */
  issueHref?: string | null;
  /** Rendered at the left of the action row — e.g. a decisions-row disclosure toggle. */
  footerSlot?: ReactNode;
  onResolved?: (decision: ReviewStageDecision) => void;
  className?: string;
}

const ACTION_PAST_TENSE: Record<ReviewStageDecision, string> = {
  approve: "Approved — the stage decision was recorded.",
  request_changes: "Changes requested — the issue went back to its assignee.",
};

export function isReviewStageParticipant(
  participant: ReviewStageParticipant | null | undefined,
  currentUserId: string | null | undefined,
): boolean {
  return Boolean(currentUserId && participant?.type === "user" && participant.userId === currentUserId);
}

/**
 * Approve / Request changes for a *pending native* review or approval stage
 * whose current participant is a user — e.g. the hand-off when the review-round
 * cap escalates an agent↔agent loop (BLA-180). Shared by the /decisions row
 * and the task page so both resolve the same way: the participant's own
 * `PATCH /issues/:id` with `status` + `comment`, which the execution policy
 * records as the stage decision (approve → next stage or done; request changes
 * → back to the return assignee with the round counter reset).
 *
 * The stage participant is the only actor the server lets decide, so any other
 * viewer gets a plain statement of who must act instead of controls.
 */
export function ReviewStageDecisionActions({
  issueId,
  companyId,
  stageType,
  participant,
  participantLabel,
  currentUserId,
  issueHref,
  footerSlot,
  onResolved,
  className,
}: ReviewStageDecisionActionsProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const noteId = useId();
  const noteHintId = useId();
  const canDecide = isReviewStageParticipant(participant, currentUserId);
  const stageNoun = stageType === "approval" ? "approval" : "review";

  const decide = useMutation({
    mutationFn: (decision: ReviewStageDecision) =>
      issuesApi.update(issueId, {
        status: decision === "approve" ? "done" : "in_progress",
        comment: note.trim(),
      }),
    onSuccess: (_result, decision) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.attention(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(issueId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.activity(issueId) });
      setNote("");
      setNoteError(null);
      pushToast({ title: ACTION_PAST_TENSE[decision], tone: "success" });
      onResolved?.(decision);
    },
    onError: (error) => {
      pushToast({
        title: "Could not record the review decision",
        body: error instanceof Error ? error.message : "Please try again.",
        tone: "error",
      });
    },
  });

  if (!canDecide) {
    const who = participantLabel?.trim()
      || (participant.type === "agent" ? "the agent reviewer" : "another user");
    return (
      <div className={cn("flex flex-col gap-2", className)} data-testid="review-stage-waiting">
        <p role="status" className="text-sm text-muted-foreground">
          This {stageNoun} is waiting on <span className="font-medium text-foreground">{who}</span>.
          Only they can approve or request changes.
        </p>
        {footerSlot || issueHref ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            {footerSlot ?? <span />}
            {issueHref ? (
              <Button asChild variant="outline" size="sm">
                <Link to={issueHref}>
                  Open task
                  <ExternalLink className="h-3 w-3" aria-hidden />
                </Link>
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  const pending = decide.isPending;
  const runningFor = (decision: ReviewStageDecision) => pending && decide.variables === decision;
  const submit = (decision: ReviewStageDecision) => {
    if (!note.trim()) {
      // Keep the verbs focusable and say why instead of a silent disabled button.
      setNoteError(
        decision === "approve"
          ? "Add a note to approve. The note is recorded with the decision."
          : "Add a note to request changes. The note tells the assignee what to change.",
      );
      noteRef.current?.focus();
      return;
    }
    setNoteError(null);
    decide.mutate(decision);
  };

  return (
    <div className={cn("flex flex-col gap-3", className)} data-testid="review-stage-decision">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={noteId} className="text-sm font-medium text-foreground">
          Your {stageNoun} decision note
        </label>
        <Textarea
          ref={noteRef}
          id={noteId}
          value={note}
          onChange={(event) => {
            setNote(event.target.value);
            if (noteError) setNoteError(null);
          }}
          placeholder="Required — recorded with your decision…"
          className="min-h-16 text-sm"
          data-testid="review-stage-note"
          aria-describedby={noteHintId}
          aria-invalid={noteError ? true : undefined}
          disabled={pending}
        />
        <p
          id={noteHintId}
          className={cn("text-xs", noteError ? "text-destructive" : "text-muted-foreground")}
          role={noteError ? "alert" : undefined}
        >
          {noteError ?? `You are the current ${stageNoun} participant. A plain comment does not decide the stage.`}
        </p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        {footerSlot ?? <span className="hidden sm:block" />}
        <div className="flex flex-col gap-2 sm:flex-1 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end @xl:flex-none">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full border-amber-400/70 text-amber-900 hover:bg-amber-100 dark:border-amber-500/50 dark:text-amber-100 dark:hover:bg-amber-500/15 sm:w-auto sm:flex-1 @xl:flex-none"
            disabled={pending}
            onClick={() => submit("request_changes")}
            data-testid="review-stage-request-changes"
          >
            {runningFor("request_changes") ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <RotateCcw className="h-3.5 w-3.5" aria-hidden />
            )}
            Request changes
          </Button>
          <Button
            type="button"
            size="sm"
            className="w-full sm:w-auto sm:flex-1 @xl:flex-none"
            disabled={pending}
            onClick={() => submit("approve")}
            data-testid="review-stage-approve"
          >
            {runningFor("approve") ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
            )}
            Approve
          </Button>
        </div>
      </div>
    </div>
  );
}
