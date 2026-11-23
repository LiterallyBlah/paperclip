import { and, eq, sql, type SQL } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { CHAT_CONTROL_RECOVERY_ADMISSION_KEY, readChatControlRecoveryAdmission } from "./chat-control-recovery-stop.js";
import { canonicalExecutionUuid } from "./execution-identity.js";
import { executionStartedEventPredicate } from "./pre-dispatch-execution-evidence.js";
import { hasRequiredWorkspaceRecovery, LEGACY_WORKSPACE_RECOVERY_SCHEMA } from "./workspace-restore-recovery-state.js";

type Run = typeof heartbeatRuns.$inferSelect;

const TERMINAL_STATUSES = ["failed", "timed_out", "interrupted", "cancelled"];
/** Legacy stages written before the dispatch gate. Anything else, including
 * `settled` (written on cancellation after any stage), may follow adapter entry. */
const PRE_ADMISSION_STAGES = ["preparing", "dispatching"];

/**
 * The dispatch gate commits `phase=admitted` in its own transaction before the
 * legacy adapter can be entered, and nothing writes `required` back. A terminal
 * automation run that still carries the exact `required` tuple therefore never
 * started provider work. Every retained execution, cleanup and workspace
 * reference must agree; missing or conflicting evidence keeps the hold.
 * `sourceIssueId` binds the run to the issue whose hold is being evaluated.
 */
export function preAdmissionLostRunPredicate(sourceIssueId: SQL | string): SQL {
  const contextIssueId = canonicalExecutionUuid(sql`${heartbeatRuns.contextSnapshot}->>'issueId'`);
  return sql`coalesce(
    ${heartbeatRuns.runtimeMode} = 'legacy'
    AND ${heartbeatRuns.status} IN (${sql.join(TERMINAL_STATUSES.map(status => sql`${status}`), sql`, `)})
    AND ${heartbeatRuns.finishedAt} IS NOT NULL
    AND ${heartbeatRuns.invocationSource} = 'automation'
    AND ${contextIssueId} = ${sourceIssueId}
    AND (${heartbeatRuns.issueId} IS NULL OR ${heartbeatRuns.issueId} = ${contextIssueId})
    AND ${heartbeatRuns.nativeIssueId} IS NULL
    AND ${heartbeatRuns.wakeupRequestId} IS NOT NULL
    AND ${heartbeatRuns.runnerProfileJson}->${CHAT_CONTROL_RECOVERY_ADMISSION_KEY} = jsonb_build_object(
      'version', 1, 'phase', 'required',
      'companyId', ${heartbeatRuns.companyId}::text, 'runId', ${heartbeatRuns.id}::text,
      'agentId', ${heartbeatRuns.agentId}::text, 'issueId', ${heartbeatRuns.contextSnapshot}->'issueId',
      'wakeupRequestId', ${heartbeatRuns.wakeupRequestId}::text)
    AND ${heartbeatRuns.processPid} IS NULL AND ${heartbeatRuns.processGroupId} IS NULL
    AND ${heartbeatRuns.processStartedAt} IS NULL
    AND (${heartbeatRuns.executionStage} IS NULL
      OR ${heartbeatRuns.executionStage} IN (${sql.join(PRE_ADMISSION_STAGES.map(stage => sql`${stage}`), sql`, `)}))
    AND coalesce(${heartbeatRuns.resultJson}->>'workspaceRestoreFailure', '') <> 'restore_unsafe_archive'
    AND NOT (coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) ? 'workspaceRestoreRecovery')
    AND NOT (coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb) ?| array[
      'nativeExecutionInput', 'nativeWorkspaceSync', 'remoteWorkspace', 'nativeWorkspaceFinalizationOwner', 'sessionCheckpoint'])
    AND NOT EXISTS (SELECT 1 FROM ${nativeRunFinalizations}
      WHERE ${nativeRunFinalizations.companyId} = ${heartbeatRuns.companyId} AND ${nativeRunFinalizations.runId} = ${heartbeatRuns.id})
    AND NOT EXISTS (SELECT 1 FROM ${environmentLeases}
      WHERE ${environmentLeases.companyId} = ${heartbeatRuns.companyId} AND ${environmentLeases.heartbeatRunId} = ${heartbeatRuns.id}
        AND ((${environmentLeases.releasedAt} IS NULL AND NOT coalesce(
            ${environmentLeases.status} = 'retained' AND ${environmentLeases.leasePolicy} = 'reuse_by_environment'
              AND ${environmentLeases.cleanupStatus} = 'success', false))
          OR ${environmentLeases.status} IN ('active', 'pending_cleanup')
          OR coalesce(${environmentLeases.cleanupStatus}, 'success') <> 'success'
          OR coalesce(${environmentLeases.metadata}->>'pendingCleanupInFlight', 'false') <> 'false'))
    AND NOT EXISTS (SELECT 1 FROM ${heartbeatRunEvents}
      WHERE ${and(eq(heartbeatRunEvents.companyId, heartbeatRuns.companyId),
        eq(heartbeatRunEvents.runId, heartbeatRuns.id), executionStartedEventPredicate())}), false)`;
}

/** Row-level candidate check; the database proof below is still required. */
export function isPreAdmissionLostRunCandidate(run: Run, sourceIssueId: string): boolean {
  return run.runtimeMode === "legacy" && TERMINAL_STATUSES.includes(run.status) && run.finishedAt !== null &&
    run.invocationSource === "automation" && run.contextSnapshot?.issueId === sourceIssueId &&
    (run.issueId === null || run.issueId === sourceIssueId) && run.nativeIssueId === null &&
    readChatControlRecoveryAdmission(run) === "required" &&
    run.processPid === null && run.processGroupId === null && run.processStartedAt === null &&
    (run.executionStage === null || PRE_ADMISSION_STAGES.includes(run.executionStage)) &&
    run.resultJson?.workspaceRestoreFailure !== "restore_unsafe_archive" &&
    !hasRequiredWorkspaceRecovery(run.resultJson) &&
    (run.resultJson?.workspaceRestoreRecovery as { schema?: unknown } | undefined)?.schema !== LEGACY_WORKSPACE_RECOVERY_SCHEMA;
}

/** True only when the stored row and all retained evidence prove the run never
 * passed the dispatch admission gate. Fails closed on any read failure. */
export async function isPreAdmissionLostRunVerified(db: Db, run: Run, sourceIssueId?: string | null): Promise<boolean> {
  const issueId = sourceIssueId ?? (typeof run.contextSnapshot?.issueId === "string" ? run.contextSnapshot.issueId : null);
  if (!issueId || !isPreAdmissionLostRunCandidate(run, issueId)) return false;
  try {
    const [verified] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.id), preAdmissionLostRunPredicate(issueId),
    )).limit(1);
    return Boolean(verified);
  } catch {
    return false;
  }
}
