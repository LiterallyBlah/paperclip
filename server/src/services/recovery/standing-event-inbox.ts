/**
 * Standing event inbox disposition.
 *
 * Some issues are long-lived inboxes: their owner is woken by delivered
 * comments (the normal `issue_commented` path) and has nothing to execute
 * between deliveries. Such an issue stays `todo`/`in_progress` with its owner,
 * so generic continuation recovery would otherwise read every quiet successful
 * run as a missing disposition and open bounded repair actions forever.
 *
 * The disposition is an explicit per-issue opt-in stored on the execution
 * policy (`executionPolicy.standingEventInbox === true`). It is never inferred
 * from titles, descriptions or origin. It only describes quiet runs: a run
 * that failed, timed out, errored or was cancelled for any other reason keeps
 * its ordinary recovery.
 */

export const STANDING_EVENT_INBOX_DURABLE_REASON = "standing_event_inbox";

/**
 * System cancellations that are not work failures: a parked continuation the
 * dispatch gate cancelled before it started, and a queued disposition repair
 * whose dispatch was suppressed because a durable wait now owns the issue.
 */
const QUIET_CANCELLATION_ERROR_CODES = new Set([
  "issue_continuation_waiting_on_review",
  "legacy_disposition_repair_suppressed",
]);

const STANDING_EVENT_INBOX_STATUSES = new Set(["todo", "in_progress"]);

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function hasStandingEventInboxMarker(issue: { executionPolicy?: unknown } | null | undefined) {
  return readRecord(issue?.executionPolicy)?.standingEventInbox === true;
}

/** The marker applies only while the agent-owned issue is open for events. */
export function isStandingEventInbox(
  issue: {
    status: string;
    executionPolicy?: unknown;
    assigneeAgentId?: string | null;
    assigneeUserId?: string | null;
  } | null | undefined,
) {
  return Boolean(
    issue &&
      hasStandingEventInboxMarker(issue) &&
      STANDING_EVENT_INBOX_STATUSES.has(issue.status) &&
      issue.assigneeAgentId &&
      !issue.assigneeUserId,
  );
}

/**
 * A quiet run is a successful run, or a system cancellation listed above.
 * Every other terminal outcome is a real failure that must still recover.
 */
export function isStandingEventInboxQuietRun(
  run: { status: string; errorCode?: string | null } | null | undefined,
) {
  if (!run) return false;
  if (run.status === "succeeded") return true;
  return run.status === "cancelled" && QUIET_CANCELLATION_ERROR_CODES.has(run.errorCode ?? "");
}

/** True when this issue is a standing inbox and the run is a quiet event wait. */
export function isStandingEventInboxQuietWait(
  issue: Parameters<typeof isStandingEventInbox>[0],
  run: Parameters<typeof isStandingEventInboxQuietRun>[0],
) {
  return isStandingEventInbox(issue) && isStandingEventInboxQuietRun(run);
}
