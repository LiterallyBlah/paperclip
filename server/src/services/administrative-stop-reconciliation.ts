// Fork feature (BLA-4475): run-scoped administrative stop reconciliation.
//
// A cancelled legacy run whose Stop won before any process existed, on a
// controller boot that is gone, can never receive its own executor's receipt
// (`executionCancellation` or `legacyStartupCancellation`). Without one it
// blocks `agentExecutionsHaveStopped` for its agent forever. An instance admin
// may record this receipt for exactly one such run. It is administrative: it
// says the owning controller is gone and no execution evidence exists, never
// that the executor proved termination. It never writes the executor receipts
// and never changes `startupCancellation`.
import { readdir, stat } from "node:fs/promises";
import { and, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { hasRetainedExecutionEvidence, RETAINED_EXECUTION_EVENT_TYPES } from "./cancelled-native-startup.js";
import { legacyControllerBootId } from "./legacy-controller-lease.js";
import { LEGACY_STARTUP_CANCELLATION_KEY } from "./legacy-startup-cancellation.js";
import { readProcessStartedAt } from "./hot-restart.js";

type Run = typeof heartbeatRuns.$inferSelect;

export const ADMINISTRATIVE_STOP_RECONCILIATION_KEY = "administrativeStopReconciliation";
/** Host-process window around the run: [startedAt - 1 s, finishedAt + 10 min]. */
export const HOST_PROCESS_WINDOW_BEFORE_MS = 1_000;
export const HOST_PROCESS_WINDOW_AFTER_MS = 10 * 60_000;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export type HostProcessCheck = (window: { from: Date; to: Date }) => Promise<"clear" | "found" | "unavailable">;

/**
 * Is any live process owned by this server's uid born inside the window?
 * Any failure other than a process vanishing mid-scan reports "unavailable",
 * and the writer then refuses.
 */
export const defaultHostProcessCheck: HostProcessCheck = async ({ from, to }) => {
  if (process.platform !== "linux" || typeof process.getuid !== "function") return "unavailable";
  const uid = process.getuid();
  let entries: string[];
  try { entries = await readdir("/proc"); } catch { return "unavailable"; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      if ((await stat(`/proc/${entry}`)).uid !== uid) continue;
      const startedAt = Date.parse(await readProcessStartedAt(pid));
      if (!Number.isFinite(startedAt)) return "unavailable";
      if (startedAt >= from.getTime() && startedAt <= to.getTime()) return "found";
    } catch {
      // A process that exited during the scan is not alive; any other failure is.
      if (!await stat(`/proc/${entry}`).then(() => true, () => false)) continue;
      return "unavailable";
    }
  }
  return "clear";
};

export type AdministrativeStopReconciliationInput = {
  runId: string;
  companyId: string;
  reconciledByActor: { type: "user" | "agent"; id: string };
  decisionRef: string;
  reason: string;
};

export type AdministrativeStopReconciliationResult =
  | { ok: true; receipt: Record<string, unknown> }
  | { ok: false; reason: "not_found" | "host_process_in_window" | "host_check_unavailable" | "premises_not_met" };

/** Writer premises; `isAdministrativelyReconciledStop` rechecks the same ones. */
function premiseConditions(runId: string, companyId: string, currentControllerBootId: string) {
  const execution = retainedExecutionEvents(runId, companyId);
  const coordinator = sql`select 1 from ${nativeRunFinalizations} where ${nativeRunFinalizations.companyId} = ${companyId}
    and ${nativeRunFinalizations.runId} = ${runId}`;
  const lease = sql`select 1 from ${environmentLeases} where ${environmentLeases.companyId} = ${companyId}
    and ${environmentLeases.heartbeatRunId} = ${runId} and (${environmentLeases.provider} is distinct from 'local'
      or ${environmentLeases.releasedAt} is null or ${environmentLeases.status} = 'pending_cleanup'
      or ${environmentLeases.cleanupStatus} is not distinct from 'failed')`;
  return and(
    eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId),
    eq(heartbeatRuns.status, "cancelled"), eq(heartbeatRuns.runtimeMode, "legacy"),
    isNotNull(heartbeatRuns.finishedAt), isNotNull(heartbeatRuns.startedAt),
    isNull(heartbeatRuns.processPid), isNull(heartbeatRuns.processGroupId), isNull(heartbeatRuns.processStartedAt),
    isNull(heartbeatRuns.sessionIdAfter), isNull(heartbeatRuns.nativeSessionId), isNull(heartbeatRuns.nativeIssueId),
    isNull(heartbeatRuns.exitCode), isNull(heartbeatRuns.signal),
    // The owning executor's controller boot is gone, and no controller lease is live.
    isNotNull(heartbeatRuns.controllerBootId), ne(heartbeatRuns.controllerBootId, currentControllerBootId),
    or(isNull(heartbeatRuns.controllerLeaseExpiresAt), sql`${heartbeatRuns.controllerLeaseExpiresAt} <= clock_timestamp()`),
    sql`jsonb_typeof(${heartbeatRuns.resultJson}->'cancellation'->'recordedAt') = 'string'`,
    sql`${heartbeatRuns.resultJson}->${ADMINISTRATIVE_STOP_RECONCILIATION_KEY} is null`,
    sql`${heartbeatRuns.resultJson}->${LEGACY_STARTUP_CANCELLATION_KEY} is null`,
    sql`${heartbeatRuns.resultJson}->'executionCancellation'->>'state' is distinct from 'acknowledged'`,
    sql`${heartbeatRuns.usageJson}->'budgetDispatch'->'handedOffAt' is null`,
    sql`not exists (${coordinator})`,
    sql`not exists (${execution})`,
    sql`not exists (${lease})`,
  );
}

function retainedExecutionEvents(runId: string, companyId: string) {
  return sql`select 1 from ${heartbeatRunEvents} where ${heartbeatRunEvents.companyId} = ${companyId}
    and ${heartbeatRunEvents.runId} = ${runId} and (${heartbeatRunEvents.sourceEventId} is not null
      or ${heartbeatRunEvents.eventType} in (${sql.join(RETAINED_EXECUTION_EVENT_TYPES.map(type => sql`${type}`), sql`, `)}))`;
}

/**
 * Write the administrative receipt with one guarded UPDATE. Every premise is
 * rechecked against current rows inside the statement; a concurrent launch,
 * event, lease, coordinator or handoff makes it match nothing.
 */
export async function recordAdministrativeStopReconciliation(
  db: Db,
  input: AdministrativeStopReconciliationInput,
  options: { currentControllerBootId?: string; hostProcessCheck?: HostProcessCheck } = {},
): Promise<AdministrativeStopReconciliationResult> {
  const currentControllerBootId = options.currentControllerBootId ?? legacyControllerBootId;
  const [run] = await db.select().from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)));
  if (!run) return { ok: false, reason: "not_found" };
  if (!run.startedAt || !run.finishedAt) return { ok: false, reason: "premises_not_met" };
  const window = {
    from: new Date(run.startedAt.getTime() - HOST_PROCESS_WINDOW_BEFORE_MS),
    to: new Date(run.finishedAt.getTime() + HOST_PROCESS_WINDOW_AFTER_MS),
  };
  const host = await (options.hostProcessCheck ?? defaultHostProcessCheck)(window);
  if (host === "found") return { ok: false, reason: "host_process_in_window" };
  if (host !== "clear") return { ok: false, reason: "host_check_unavailable" };
  const observedAt = new Date().toISOString();
  const [updated] = await db.update(heartbeatRuns).set({
    resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || jsonb_build_object(
      ${ADMINISTRATIVE_STOP_RECONCILIATION_KEY}::text, jsonb_build_object(
        'version', 1,
        'kind', 'administrative',
        'runId', ${input.runId}::text,
        'companyId', ${input.companyId}::text,
        'controllerBootId', ${heartbeatRuns.controllerBootId},
        'cancellationRecordedAt', ${heartbeatRuns.resultJson}->'cancellation'->'recordedAt',
        'reconciledByActor', jsonb_build_object('type', ${input.reconciledByActor.type}::text, 'id', ${input.reconciledByActor.id}::text),
        'decisionRef', ${input.decisionRef}::text,
        'reason', ${input.reason}::text,
        'observedAt', ${observedAt}::text,
        'currentControllerBootId', ${currentControllerBootId}::text,
        'hostProcessWindow', jsonb_build_object('from', ${window.from.toISOString()}::text, 'to', ${window.to.toISOString()}::text, 'result', 'clear'),
        'executorTerminationProven', false))`,
  }).where(premiseConditions(input.runId, input.companyId, currentControllerBootId))
    .returning({ resultJson: heartbeatRuns.resultJson });
  if (!updated) return { ok: false, reason: "premises_not_met" };
  return { ok: true, receipt: record(record(updated.resultJson)[ADMINISTRATIVE_STOP_RECONCILIATION_KEY]) };
}

/**
 * Stop proof for a cancelled legacy run that carries an administrative
 * receipt. The receipt must bind this run, company, controller boot and
 * cancellation record, and every negative premise is rechecked live: any later
 * process, session, exit, event, lease, coordinator, provider handoff, live
 * controller lease or a run owned by the current controller boot rejects it.
 * A non-local lease rejects it: remote runs keep their termination-receipt rule.
 */
export async function isAdministrativelyReconciledStop(
  db: Db,
  run: Run,
  currentControllerBootId: string = legacyControllerBootId,
) {
  if (run.runtimeMode !== "legacy" || run.status !== "cancelled" || !run.finishedAt || !run.startedAt ||
      run.processPid || run.processGroupId || run.processStartedAt ||
      run.sessionIdAfter || run.nativeSessionId || run.nativeIssueId ||
      run.exitCode !== null || run.signal !== null ||
      !run.controllerBootId || run.controllerBootId === currentControllerBootId) return false;
  if (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date()) return false;
  const result = record(run.resultJson);
  const cancellation = record(result.cancellation);
  const receipt = record(result[ADMINISTRATIVE_STOP_RECONCILIATION_KEY]);
  const actor = record(receipt.reconciledByActor);
  if (receipt.version !== 1 || receipt.kind !== "administrative" || receipt.runId !== run.id ||
      receipt.companyId !== run.companyId || receipt.controllerBootId !== run.controllerBootId ||
      receipt.executorTerminationProven !== false ||
      typeof receipt.currentControllerBootId !== "string" || receipt.currentControllerBootId === run.controllerBootId ||
      typeof cancellation.recordedAt !== "string" || receipt.cancellationRecordedAt !== cancellation.recordedAt ||
      typeof actor.type !== "string" || typeof actor.id !== "string" ||
      typeof receipt.decisionRef !== "string" || typeof receipt.observedAt !== "string") return false;
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
