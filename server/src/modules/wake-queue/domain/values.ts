// Small, shared domain values for the wake-queue module: string readers, the
// two failed-run codes, and the recovery retry reason they gate. The
// application and adapter layers both need these, so they live here once
// instead of twice.

export function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function parseObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export const WORKSPACE_VALIDATION_FAILURE_CODE = "workspace_validation_failed";
export const CONFIGURATION_INCOMPLETE_FAILURE_CODE = "configuration_incomplete";
export const EXECUTION_REVIEW_PARTICIPANT_RECOVERY_RETRY_REASON = "execution_review_participant_recovery";

export function isWorkspaceValidationFailedRun(run: { errorCode: string | null }): boolean {
  return run.errorCode === WORKSPACE_VALIDATION_FAILURE_CODE;
}

export function isConfigurationIncompleteFailedRun(run: { errorCode: string | null }): boolean {
  return run.errorCode === CONFIGURATION_INCOMPLETE_FAILURE_CODE || run.errorCode === "model_not_found" ||
    run.errorCode === "native_provider_model_rejected";
}

/** Wake reasons the issue route uses when a pending stage needs its participant. */
export const EXECUTION_STAGE_WAKE_REASONS: ReadonlySet<string> = new Set([
  "execution_review_requested",
  "execution_approval_requested",
]);

/** Marker stored on a stage wake kept behind another agent's finishing run. */
export const EXECUTION_STAGE_WAKE_WAIT_CAUSE = "execution_owner_active";

export function readExecutionStageId(payload: unknown): string | null {
  return readNonEmptyString(parseObject(parseObject(payload).executionStage).stageId);
}

/** A stage wake that admission kept while another agent's run still owned the task. */
export function isKeptExecutionStageWake(row: { reason: string | null; payload: unknown }): boolean {
  return Boolean(row.reason && EXECUTION_STAGE_WAKE_REASONS.has(row.reason)) &&
    parseObject(parseObject(row.payload).executionWait).cause === EXECUTION_STAGE_WAKE_WAIT_CAUSE &&
    readExecutionStageId(row.payload) !== null;
}
