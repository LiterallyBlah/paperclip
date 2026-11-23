import { and, eq, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, type Db } from "@paperclipai/db";
import { remoteTerminationReceipt } from "./remote-execution-termination.js";

/**
 * SSH pending-cleanup reconciliation.
 *
 * An SSH lease is bookkeeping for one run on a host/account/workspace. Its
 * provider lease id (`ssh://user@host:port/cwd`) names a shared resource, not
 * an isolated sandbox, so there is nothing to tear down and nothing may be
 * destroyed. The SSH driver therefore has no orphan teardown. A `pending_cleanup`
 * SSH row (for example an active lease whose run ended before its release ran,
 * flipped by the orphaned-active sweep) can only settle when exact server-owned
 * evidence shows that the run's remote execution ended. Without that evidence
 * the row stays unresolved and blocks lifecycle stops, as before.
 *
 * Accepted evidence, both bound to the same company, run, lease and execution:
 * - `remote_termination_receipt`: a `paperclip.remote-termination.v1` receipt
 *   already on the lease for this company/run/lease/provider/provider lease.
 * - `observed_remote_exit`: the run row records an exit the adapter observed
 *   from the remote command: status `succeeded`/`failed`, integer exit code
 *   0-254 (255 is the ssh client's own transport failure), no signal, and a
 *   process start at or after this lease's acquisition. No newer lease may
 *   exist for the same run, so the exit belongs to this lease's execution.
 *
 * A terminal status alone, an old timestamp, an absent local PID, a signal, a
 * cancelled/timed-out run or a disconnected ssh client (exit 255) is not
 * evidence. Cancelled SSH runs still need an exact termination receipt in the
 * lifecycle stop gate; this module does not relax that rule.
 *
 * Settlement is a single fenced write: the cleanup attempt id, status, provider,
 * provider lease, run, acquisition time, any receipt, and the run's exit facts
 * are all re-checked in the UPDATE, so a lost attempt or a newer acquisition
 * leaves the row untouched. Other leases on the same SSH host/workspace are
 * never read for mutation. Existing termination receipts and failure history
 * are preserved in metadata; nothing is stripped.
 */

export const SSH_CLEANUP_RECONCILIATION_KEY = "sshCleanupReconciliation";
const SCHEMA = "paperclip.ssh-cleanup-reconciliation.v1";
/** Named operation the SSH driver cannot perform; reported on unresolved rows. */
export const SSH_UNSUPPORTED_CLEANUP_OPERATION = "ssh_remote_execution_stop";
const EXIT_OBSERVED_RUN_STATUSES = ["succeeded", "failed"] as const;

type Lease = Pick<typeof environmentLeases.$inferSelect, "id" | "companyId" | "heartbeatRunId" | "status"
  | "provider" | "providerLeaseId" | "acquiredAt" | "releasedAt" | "failureReason" | "metadata"> & {
  cleanupStatus: string | null;
};
type LeaseRow = typeof environmentLeases.$inferSelect;

export type SshCleanupUnresolvedReason =
  | "not_ssh_run_lease"
  | "run_missing"
  | "foreign_run_owner"
  | "remote_exit_not_observed"
  | "execution_generation_mismatch"
  | "newer_lease_for_run";

export type SshCleanupReconciliation =
  | { outcome: "settled"; source: "remote_termination_receipt" | "observed_remote_exit"; lease: LeaseRow }
  | { outcome: "unresolved"; reason: SshCleanupUnresolvedReason; recorded: boolean }
  | { outcome: "lost_attempt" };

export function isSshPendingCleanupLease(
  lease: Pick<Lease, "provider" | "metadata" | "status">,
  environment: { driver: string } | null,
): boolean {
  if (lease.status !== "pending_cleanup" || lease.provider !== "ssh") return false;
  const driver = typeof lease.metadata?.driver === "string" ? lease.metadata.driver : environment?.driver;
  return driver === "ssh";
}

function boundTerminationReceipt(lease: Lease) {
  const receipt = lease.metadata?.remoteExecutionTermination as Record<string, unknown> | undefined;
  if (!receipt || receipt.schema !== "paperclip.remote-termination.v1" || receipt.companyId !== lease.companyId
    || receipt.runId !== lease.heartbeatRunId || receipt.leaseId !== lease.id || receipt.provider !== lease.provider
    || !remoteTerminationReceipt(lease, receipt)) return null;
  return receipt;
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function priorCleanupState(lease: Lease) {
  return {
    status: lease.status,
    cleanupStatus: lease.cleanupStatus,
    failureReason: lease.failureReason,
    releasedAt: lease.releasedAt ? new Date(lease.releasedAt).toISOString() : null,
    attempts: typeof lease.metadata?.pendingCleanupRetryAttempts === "number"
      ? lease.metadata.pendingCleanupRetryAttempts : null,
  };
}

function fence(lease: Lease, attemptId: string) {
  return [
    eq(environmentLeases.id, lease.id),
    eq(environmentLeases.companyId, lease.companyId),
    eq(environmentLeases.status, "pending_cleanup"),
    eq(environmentLeases.provider, "ssh"),
    eq(environmentLeases.providerLeaseId, lease.providerLeaseId!),
    eq(environmentLeases.heartbeatRunId, lease.heartbeatRunId!),
    // Postgres keeps microseconds; the snapshot is a millisecond JS Date.
    sql`date_trunc('milliseconds', ${environmentLeases.acquiredAt}) = ${iso(lease.acquiredAt)}::timestamptz`,
    sql`${environmentLeases.metadata}->>'pendingCleanupAttemptId' = ${attemptId}`,
  ];
}

function noNewerLeaseForRunSql(lease: Lease) {
  return sql`not exists (select 1 from environment_leases newer
    where newer.company_id = ${lease.companyId} and newer.heartbeat_run_id = ${lease.heartbeatRunId}
      and newer.id <> ${lease.id} and date_trunc('milliseconds', newer.acquired_at) > ${iso(lease.acquiredAt)}::timestamptz)`;
}

export const SSH_EXECUTION_EXIT_KEY = "sshExecutionExit";
const EXIT_SCHEMA = "paperclip.ssh-execution-exit.v1";

type RunExitFacts = {
  agentId: string; status: string; exitCode: number | null; signal: string | null;
  processStartedAt: Date | null; finishedAt: Date | null;
};

function observedRemoteExit(run: RunExitFacts): boolean {
  return (EXIT_OBSERVED_RUN_STATUSES as readonly string[]).includes(run.status) && Boolean(run.finishedAt)
    && typeof run.exitCode === "number" && Number.isInteger(run.exitCode) && run.exitCode >= 0 && run.exitCode <= 254
    && run.signal === null;
}

async function readRunExitFacts(db: Db, lease: Pick<Lease, "companyId" | "heartbeatRunId">) {
  if (!lease.heartbeatRunId) return null;
  const [run] = await db.select({
    agentId: heartbeatRuns.agentId, status: heartbeatRuns.status, exitCode: heartbeatRuns.exitCode,
    signal: heartbeatRuns.signal, processStartedAt: heartbeatRuns.processStartedAt, finishedAt: heartbeatRuns.finishedAt,
  }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, lease.heartbeatRunId), eq(heartbeatRuns.companyId, lease.companyId),
  ));
  return run ?? null;
}

/**
 * Normal SSH completion: when the run row already records an exit observed
 * from the remote command for this lease's execution, return a lease-bound
 * record of it. The SSH release stores it so a later cancellation or
 * maintenance settlement keeps exact evidence even after process fields are
 * cleared. Returns undefined when the exit was not observed exactly.
 */
export async function sshExecutionExitEvidence(db: Db, lease: Lease, now = new Date()) {
  if (lease.provider !== "ssh" || !lease.heartbeatRunId || !lease.providerLeaseId) return undefined;
  const run = await readRunExitFacts(db, lease);
  if (!run || !observedRemoteExit(run) || !run.processStartedAt
    || run.processStartedAt.getTime() < new Date(lease.acquiredAt).getTime()) return undefined;
  const leaseAgentId = typeof lease.metadata?.agentId === "string" ? lease.metadata.agentId : null;
  if (leaseAgentId && leaseAgentId !== run.agentId) return undefined;
  return {
    schema: EXIT_SCHEMA, companyId: lease.companyId, runId: lease.heartbeatRunId, leaseId: lease.id,
    provider: lease.provider, providerLeaseId: lease.providerLeaseId, leaseAcquiredAt: iso(lease.acquiredAt),
    agentId: run.agentId, runStatus: run.status, exitCode: run.exitCode,
    processStartedAt: run.processStartedAt.toISOString(), recordedAt: now.toISOString(),
  };
}

function boundRecordedExit(lease: Lease) {
  const value = lease.metadata?.[SSH_EXECUTION_EXIT_KEY] as Record<string, unknown> | undefined;
  if (!value || value.schema !== EXIT_SCHEMA || value.companyId !== lease.companyId
    || value.runId !== lease.heartbeatRunId || value.leaseId !== lease.id || value.provider !== lease.provider
    || value.providerLeaseId !== lease.providerLeaseId || value.leaseAcquiredAt !== iso(lease.acquiredAt)
    || typeof value.processStartedAt !== "string" || Number.isNaN(Date.parse(value.processStartedAt))) return null;
  return value;
}

/**
 * Settle one claimed SSH `pending_cleanup` lease from exact stop evidence, or
 * record why it stays unresolved. `attemptId` is the cleanup-attempt id the
 * caller claimed; every write is fenced on it.
 */
export async function reconcileSshPendingCleanup(
  db: Db,
  lease: Lease,
  options: { attemptId: string; now?: Date },
): Promise<SshCleanupReconciliation> {
  const now = options.now ?? new Date();
  const unresolved = async (reason: SshCleanupUnresolvedReason): Promise<SshCleanupReconciliation> => {
    if (!lease.heartbeatRunId || !lease.providerLeaseId || lease.provider !== "ssh") {
      return { outcome: "unresolved", reason, recorded: false };
    }
    // Keep status, cleanup status, failure reason and every receipt; only add
    // the specific unsupported operation so operators see why it waits.
    const [row] = await db.update(environmentLeases).set({
      updatedAt: now,
      metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({
        [SSH_CLEANUP_RECONCILIATION_KEY]: {
          schema: SCHEMA, state: "unresolved", reason,
          unsupportedOperation: SSH_UNSUPPORTED_CLEANUP_OPERATION,
          attemptId: options.attemptId, checkedAt: now.toISOString(),
        },
      })}::jsonb`,
    }).where(and(...fence(lease, options.attemptId))).returning({ id: environmentLeases.id });
    return row ? { outcome: "unresolved", reason, recorded: true } : { outcome: "lost_attempt" };
  };

  if (lease.provider !== "ssh" || !lease.heartbeatRunId || !lease.providerLeaseId) {
    return unresolved("not_ssh_run_lease");
  }

  const evidenceBase = {
    companyId: lease.companyId, runId: lease.heartbeatRunId, leaseId: lease.id,
    provider: lease.provider, providerLeaseId: lease.providerLeaseId,
    leaseAcquiredAt: iso(lease.acquiredAt),
  };
  const settle = async (
    source: "remote_termination_receipt" | "observed_remote_exit",
    evidence: Record<string, unknown>,
    conditions: ReturnType<typeof sql>[],
  ): Promise<SshCleanupReconciliation> => {
    const [row] = await db.update(environmentLeases).set({
      status: "expired",
      cleanupStatus: "success",
      failureReason: "ssh_cleanup_reconciled",
      releasedAt: sql`coalesce(${environmentLeases.releasedAt}, ${now.toISOString()}::timestamptz)`,
      lastUsedAt: now,
      updatedAt: now,
      metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({
        [SSH_CLEANUP_RECONCILIATION_KEY]: {
          schema: SCHEMA, state: "settled", source, evidence: { ...evidenceBase, ...evidence },
          prior: priorCleanupState(lease), attemptId: options.attemptId, settledAt: now.toISOString(),
        },
        pendingCleanupInFlight: false,
        pendingCleanupLeaseExpiresAtMs: 0,
      })}::jsonb`,
    }).where(and(...fence(lease, options.attemptId), ...conditions)).returning();
    return row ? { outcome: "settled", source, lease: row } : { outcome: "lost_attempt" };
  };

  const receipt = boundTerminationReceipt(lease);
  if (receipt) {
    return settle("remote_termination_receipt", { receiptState: receipt.state, receiptConfirmedAt: receipt.confirmedAt ?? null }, [
      sql`${environmentLeases.metadata}->'remoteExecutionTermination' = ${JSON.stringify(receipt)}::jsonb`,
    ]);
  }

  const run = await readRunExitFacts(db, lease);
  if (!run) return unresolved("run_missing");
  const leaseAgentId = typeof lease.metadata?.agentId === "string" ? lease.metadata.agentId : null;
  if (leaseAgentId && leaseAgentId !== run.agentId) return unresolved("foreign_run_owner");
  if (!observedRemoteExit(run)) return unresolved("remote_exit_not_observed");
  // The execution generation is the remote process start. Native completion
  // can clear it from the run row; the SSH release then kept a bound copy.
  const recorded = boundRecordedExit(lease);
  if (recorded && (recorded.agentId !== run.agentId || recorded.runStatus !== run.status
    || recorded.exitCode !== run.exitCode)) return unresolved("execution_generation_mismatch");
  const startedAt = run.processStartedAt ?? (recorded ? new Date(recorded.processStartedAt as string) : null);
  if (!startedAt || startedAt.getTime() < new Date(lease.acquiredAt).getTime()
    || (run.processStartedAt && recorded && run.processStartedAt.toISOString() !== recorded.processStartedAt)) {
    return unresolved("execution_generation_mismatch");
  }
  const [newer] = await db.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
    eq(environmentLeases.companyId, lease.companyId), eq(environmentLeases.heartbeatRunId, lease.heartbeatRunId),
    sql`${environmentLeases.id} <> ${lease.id}`,
    sql`date_trunc('milliseconds', ${environmentLeases.acquiredAt}) > ${iso(lease.acquiredAt)}::timestamptz`,
  )).limit(1);
  if (newer) return unresolved("newer_lease_for_run");

  const processStartedAt = startedAt.toISOString();
  return settle("observed_remote_exit", {
    agentId: run.agentId, runStatus: run.status, exitCode: run.exitCode,
    processStartedAt, runFinishedAt: run.finishedAt!.toISOString(), recordedAtRelease: Boolean(recorded),
  }, [
    // Re-check the run's exit facts and execution generation inside the write.
    sql`exists (select 1 from heartbeat_runs r where r.id = ${lease.heartbeatRunId}
      and r.company_id = ${lease.companyId} and r.agent_id = ${run.agentId}
      and r.status = ${run.status} and r.exit_code = ${run.exitCode} and r.signal is null
      and ${run.processStartedAt
        ? sql`date_trunc('milliseconds', r.process_started_at) = ${processStartedAt}::timestamptz`
        : sql`r.process_started_at is null`}
      and r.finished_at is not null)`,
    ...(recorded ? [sql`${environmentLeases.metadata}->${SSH_EXECUTION_EXIT_KEY} = ${JSON.stringify(recorded)}::jsonb`] : []),
    noNewerLeaseForRunSql(lease),
  ]);
}
