import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { hasRetainedExecutionEvidence, RETAINED_EXECUTION_EVENT_TYPES } from "./cancelled-native-startup.js";

type Run = typeof heartbeatRuns.$inferSelect;

export const LEGACY_STARTUP_CANCELLATION_KEY = "legacyStartupCancellation";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * Legacy Stop that wins before adapter entry has no process to acknowledge,
 * so the cancellation path cannot write `executionCancellation`. Only the
 * executor that owns this run on this server boot knows that it never entered
 * the adapter. It calls this after preparation and lease cleanup unwound.
 *
 * The single UPDATE binds the receipt to this run, company, controller boot
 * and the current cancellation record (plus its startup fence, if any). The
 * locked provider handoff refuses any run carrying that record. It refuses a run that committed
 * the locked provider handoff, recorded any process, session or exit, has a
 * native coordinator, or retains any launch/provider event. It never runs for
 * historical rows: without its own executor there is no receipt.
 */
export async function recordLegacyStartupCancellationSettled(db: Db, input: {
  runId: string;
  companyId: string;
  controllerBootId: string;
  adapterEntered: boolean;
}) {
  if (input.adapterEntered) return false;
  const settledAt = new Date().toISOString();
  const execution = db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, input.companyId), eq(heartbeatRunEvents.runId, input.runId),
    sql`(${heartbeatRunEvents.sourceEventId} is not null or ${heartbeatRunEvents.eventType} in (${sql.join(
      RETAINED_EXECUTION_EVENT_TYPES.map(type => sql`${type}`), sql`, `)}))`,
  ));
  const coordinator = db.select({ runId: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, input.companyId), eq(nativeRunFinalizations.runId, input.runId),
  ));
  const updated = await db.update(heartbeatRuns).set({
    resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || jsonb_build_object(
      ${LEGACY_STARTUP_CANCELLATION_KEY}::text, jsonb_build_object(
        'version', 1,
        'runId', ${input.runId}::text,
        'companyId', ${input.companyId}::text,
        'controllerBootId', ${input.controllerBootId}::text,
        'providerDispatchStarted', false,
        'cancellationRecordedAt', ${heartbeatRuns.resultJson}->'cancellation'->'recordedAt',
        'startupCancellationRequestedAt', coalesce(${heartbeatRuns.resultJson}->'startupCancellation'->'requestedAt', 'null'::jsonb),
        'settledAt', ${settledAt}::text))`,
  }).where(and(
    eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.status, "cancelled"), eq(heartbeatRuns.runtimeMode, "legacy"),
    eq(heartbeatRuns.controllerBootId, input.controllerBootId),
    isNull(heartbeatRuns.processPid), isNull(heartbeatRuns.processGroupId), isNull(heartbeatRuns.processStartedAt),
    isNull(heartbeatRuns.sessionIdAfter), isNull(heartbeatRuns.nativeSessionId), isNull(heartbeatRuns.nativeIssueId),
    isNull(heartbeatRuns.exitCode), isNull(heartbeatRuns.signal), isNotNull(heartbeatRuns.finishedAt),
    sql`jsonb_typeof(${heartbeatRuns.resultJson}->'cancellation'->'recordedAt') = 'string'`,
    sql`${heartbeatRuns.resultJson}->${LEGACY_STARTUP_CANCELLATION_KEY} is null`,
    sql`${heartbeatRuns.usageJson}->'budgetDispatch'->'handedOffAt' is null`,
    sql`not exists (${coordinator})`,
    sql`not exists (${execution})`,
  )).returning({ id: heartbeatRuns.id });
  return updated.length > 0;
}

/**
 * Stop proof for a cancelled legacy run that never reached its adapter.
 * Every premise is rechecked against current rows: a receipt from a different
 * run, company, controller boot or cancellation fence, a later provider
 * handoff, process/session/exit evidence, a coordinator, any non-local or
 * unsettled lease, or any retained launch/provider event rejects it.
 * Remote execution always keeps its own termination-receipt requirement.
 */
export async function isSettledLegacyStartupCancellation(db: Db, run: Run) {
  if (run.runtimeMode !== "legacy" || run.status !== "cancelled" || !run.finishedAt ||
      run.executionStage !== "settled" || run.processPid || run.processGroupId || run.processStartedAt ||
      run.sessionIdAfter || run.nativeSessionId || run.nativeIssueId ||
      run.exitCode !== null || run.signal !== null || !run.controllerBootId) return false;
  if (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date()) return false;
  const result = record(run.resultJson);
  const cancellation = record(result.cancellation);
  const startupRequestedAt = record(result.startupCancellation).requestedAt ?? null;
  const receipt = record(result[LEGACY_STARTUP_CANCELLATION_KEY]);
  if (receipt.version !== 1 || receipt.runId !== run.id || receipt.companyId !== run.companyId ||
      receipt.controllerBootId !== run.controllerBootId || receipt.providerDispatchStarted !== false ||
      typeof cancellation.recordedAt !== "string" || receipt.cancellationRecordedAt !== cancellation.recordedAt ||
      receipt.startupCancellationRequestedAt !== startupRequestedAt ||
      typeof receipt.settledAt !== "string") return false;
  const requestedAt = Date.parse(cancellation.recordedAt), settledAt = Date.parse(receipt.settledAt);
  if (!Number.isFinite(requestedAt) || !Number.isFinite(settledAt) || settledAt < requestedAt) return false;
  if (record(record(run.usageJson).budgetDispatch).handedOffAt !== undefined) return false;
  const [coordinator] = await db.select({ runId: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, run.companyId), eq(nativeRunFinalizations.runId, run.id),
  )).limit(1);
  if (coordinator) return false;
  const leases = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
  ));
  if (leases.some(lease => lease.provider !== "local" || !lease.releasedAt ||
      lease.status === "pending_cleanup" || lease.cleanupStatus === "failed")) return false;
  return !await hasRetainedExecutionEvidence(db, run.companyId, run.id);
}
