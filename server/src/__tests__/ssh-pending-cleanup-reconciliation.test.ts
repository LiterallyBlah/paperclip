import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  costEvents,
  createDb,
  environmentLeases,
  environments,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));
vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: vi.fn(function child() { return this; }),
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
  },
  httpLogger: vi.fn(),
}));

import { heartbeatService, type HeartbeatEnvironmentRuntime } from "../services/heartbeat.ts";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { agentExecutionsHaveStopped } from "../services/agent-execution-stop.js";
import {
  reconcileSshPendingCleanup,
  SSH_CLEANUP_RECONCILIATION_KEY,
  SSH_EXECUTION_EXIT_KEY,
} from "../services/ssh-pending-cleanup-reconciliation.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

// Synthetic fixtures only: no SSH connection, remote command or network call is
// made. The SSH driver's acquire (which contacts the host) is never invoked.
describeEmbeddedPostgres("SSH pending-cleanup reconciliation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-ssh-pending-cleanup-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(environmentLeases);
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(environments);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => { await tempDb?.cleanup(); });

  const long = () => new Date(Date.now() - 60 * 60_000);
  const acquiredAt = () => new Date(Date.now() - 50 * 60_000);
  const startedAt = () => new Date(Date.now() - 49 * 60_000);
  const providerLeaseId = "ssh://agent@build.invalid:22/srv/work";

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), environmentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Paperclip",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "PT", role: "engineer", status: "idle",
      adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(environments).values({ id: environmentId, companyId, name: "SSH host", driver: "ssh",
      status: "active", config: { host: "build.invalid", port: 22, username: "agent", remoteWorkspacePath: "/srv/work" } });
    return { companyId, agentId, environmentId };
  }

  async function insertRun(input: { companyId: string; agentId: string; status?: string; exitCode?: number | null;
    signal?: string | null; processStartedAt?: Date | null; finishedAt?: Date | null }) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({ id, companyId: input.companyId, agentId: input.agentId,
      invocationSource: "on_demand", status: input.status ?? "succeeded", nextEventSeq: 1,
      startedAt: long(), finishedAt: input.finishedAt === undefined ? new Date(Date.now() - 40 * 60_000) : input.finishedAt,
      exitCode: input.exitCode === undefined ? 0 : input.exitCode, signal: input.signal ?? null,
      processStartedAt: input.processStartedAt === undefined ? startedAt() : input.processStartedAt });
    return id;
  }

  async function insertLease(input: { companyId: string; agentId: string; environmentId: string; runId: string;
    status?: string; cleanupStatus?: string | null; failureReason?: string | null; acquiredAt?: Date;
    metadata?: Record<string, unknown>; providerLeaseId?: string }) {
    const id = randomUUID();
    const pending = (input.status ?? "pending_cleanup") === "pending_cleanup";
    await db.insert(environmentLeases).values({ id, companyId: input.companyId, environmentId: input.environmentId,
      heartbeatRunId: input.runId, status: input.status ?? "pending_cleanup", leasePolicy: "ephemeral", provider: "ssh",
      providerLeaseId: input.providerLeaseId ?? providerLeaseId, acquiredAt: input.acquiredAt ?? acquiredAt(),
      releasedAt: pending ? long() : null, cleanupStatus: input.cleanupStatus === undefined ? (pending ? "failed" : null) : input.cleanupStatus,
      failureReason: input.failureReason === undefined ? (pending ? "orphaned_active_lease_recovered" : null) : input.failureReason,
      metadata: { driver: "ssh", agentId: input.agentId, remoteCwd: "/srv/work", ...(input.metadata ?? {}) },
      lastUsedAt: long(), updatedAt: long(), createdAt: long() });
    return id;
  }

  const lease = async (id: string) => (await db.select().from(environmentLeases).where(eq(environmentLeases.id, id)))[0]!;
  const sweeper = () => heartbeatService(db, {
    environmentRuntime: environmentRuntimeService(db) as unknown as HeartbeatEnvironmentRuntime,
  });

  it("settles an orphaned SSH lease from the observed remote exit, keeps failure history, and unblocks the stop gate", async () => {
    const { companyId, agentId, environmentId } = await seed();
    const runId = await insertRun({ companyId, agentId, exitCode: 0 });
    const id = await insertLease({ companyId, agentId, environmentId, runId, status: "active", cleanupStatus: null, failureReason: null });
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(false);

    const heartbeat = sweeper();
    expect(await heartbeat.sweepOrphanedActiveLeases({ backoffMs: 0 })).toEqual({ recovered: 1 });
    // Simulate the historical capped failure: the old sweep marked it failed.
    await db.update(environmentLeases).set({ cleanupStatus: "failed", failureReason: "pending_cleanup_retry",
      metadata: { ...(await lease(id)).metadata, pendingCleanupRetryAttempts: 5 } }).where(eq(environmentLeases.id, id));
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(false);

    const result = await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
    expect(result.destroyed).toBe(1);
    const row = await lease(id);
    expect(row).toMatchObject({ status: "expired", cleanupStatus: "success", failureReason: "ssh_cleanup_reconciled" });
    const audit = row.metadata?.[SSH_CLEANUP_RECONCILIATION_KEY] as Record<string, any>;
    expect(audit).toMatchObject({ state: "settled", source: "observed_remote_exit",
      evidence: { companyId, runId, leaseId: id, provider: "ssh", providerLeaseId, exitCode: 0, runStatus: "succeeded" },
      prior: { status: "pending_cleanup", cleanupStatus: "failed", failureReason: "pending_cleanup_retry", attempts: 5 } });
    expect(row.metadata?.remoteExecutionTermination).toBeUndefined();
    expect(row.metadata?.pendingCleanupInFlight).toBe(false);
    const activity = await db.select().from(activityLog).where(eq(activityLog.entityId, id));
    expect(activity.map(entry => entry.action)).toContain("environment_lease.cleanup_reconciled");

    // The pause predicate now passes; a later pause/resume cycle is not held.
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(true);
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(true);
  });

  it.each([
    ["cancelled run", { status: "cancelled", exitCode: null, signal: "SIGTERM" }, "remote_exit_not_observed"],
    ["timed out run", { status: "timed_out", exitCode: null }, "remote_exit_not_observed"],
    ["signalled ssh client", { status: "failed", exitCode: null, signal: "SIGTERM" }, "remote_exit_not_observed"],
    ["ssh transport failure (255)", { status: "failed", exitCode: 255 }, "remote_exit_not_observed"],
    ["no exit code", { status: "failed", exitCode: null }, "remote_exit_not_observed"],
    ["no recorded process start", { processStartedAt: null }, "execution_generation_mismatch"],
    ["process started before this lease", { processStartedAt: new Date(Date.now() - 55 * 60_000) }, "execution_generation_mismatch"],
  ] as const)("keeps the row unresolved without exact evidence: %s", async (_label, runPatch, reason) => {
    const { companyId, agentId, environmentId } = await seed();
    const runId = await insertRun({ companyId, agentId, ...runPatch });
    const foreignReceipt = { schema: "paperclip.remote-termination.v1", companyId, runId, leaseId: randomUUID(),
      provider: "ssh", providerLeaseId, state: "stopped", confirmedAt: new Date().toISOString() };
    const id = await insertLease({ companyId, agentId, environmentId, runId, failureReason: "pending_cleanup_retry",
      metadata: { remoteExecutionTermination: foreignReceipt } });

    await sweeper().sweepPendingCleanupLeases({ backoffMs: 0 });

    const row = await lease(id);
    expect(row).toMatchObject({ status: "pending_cleanup", cleanupStatus: "failed", failureReason: "pending_cleanup_retry" });
    expect(row.metadata?.[SSH_CLEANUP_RECONCILIATION_KEY]).toMatchObject({ state: "unresolved", reason,
      unsupportedOperation: "ssh_remote_execution_stop" });
    // An unrelated or unbound receipt is neither used nor discarded.
    expect(row.metadata?.remoteExecutionTermination).toEqual(foreignReceipt);
    expect(row.metadata?.pendingCleanupInFlight).toBe(false);
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(false);
  });

  it("does not settle when a newer lease exists for the same run or the lease belongs to another agent", async () => {
    const { companyId, agentId, environmentId } = await seed();
    const runId = await insertRun({ companyId, agentId });
    const older = await insertLease({ companyId, agentId, environmentId, runId });
    await insertLease({ companyId, agentId, environmentId, runId, status: "released", cleanupStatus: null,
      acquiredAt: new Date(Date.now() - 45 * 60_000) });
    const foreignRun = await insertRun({ companyId, agentId });
    const foreign = await insertLease({ companyId, agentId: randomUUID(), environmentId, runId: foreignRun });

    await sweeper().sweepPendingCleanupLeases({ backoffMs: 0 });

    expect((await lease(older)).metadata?.[SSH_CLEANUP_RECONCILIATION_KEY]).toMatchObject({ reason: "newer_lease_for_run" });
    expect((await lease(foreign)).metadata?.[SSH_CLEANUP_RECONCILIATION_KEY]).toMatchObject({ reason: "foreign_run_owner" });
    expect((await lease(older)).status).toBe("pending_cleanup");
    expect((await lease(foreign)).status).toBe("pending_cleanup");
  });

  it("reuses an exact bound termination receipt and preserves it", async () => {
    const { companyId, agentId, environmentId } = await seed();
    const runId = await insertRun({ companyId, agentId, status: "cancelled", exitCode: null, signal: "SIGTERM" });
    const id = randomUUID();
    const receipt = { schema: "paperclip.remote-termination.v1", companyId, runId, leaseId: id, provider: "ssh",
      providerLeaseId, state: "stopped", confirmedAt: new Date().toISOString() };
    await db.insert(environmentLeases).values({ id, companyId, environmentId, heartbeatRunId: runId, status: "pending_cleanup",
      leasePolicy: "ephemeral", provider: "ssh", providerLeaseId, acquiredAt: acquiredAt(), releasedAt: long(),
      cleanupStatus: "failed", failureReason: "pending_cleanup_retry", updatedAt: long(),
      metadata: { driver: "ssh", agentId, remoteExecutionTermination: receipt } });
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(false);

    await sweeper().sweepPendingCleanupLeases({ backoffMs: 0 });

    const row = await lease(id);
    expect(row).toMatchObject({ status: "expired", cleanupStatus: "success" });
    expect(row.metadata?.remoteExecutionTermination).toEqual(receipt);
    expect(row.metadata?.[SSH_CLEANUP_RECONCILIATION_KEY]).toMatchObject({ source: "remote_termination_receipt" });
    // The cancelled run is accepted only because its exact receipt exists.
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(true);
  });

  it("keeps cancelled SSH runs without a receipt blocked after a normal release", async () => {
    const { companyId, agentId, environmentId } = await seed();
    const runId = await insertRun({ companyId, agentId, status: "cancelled", exitCode: null, signal: "SIGTERM" });
    const id = await insertLease({ companyId, agentId, environmentId, runId, status: "active", cleanupStatus: null, failureReason: null });
    await environmentRuntimeService(db).releaseRunLeases(runId, "failed");
    const row = await lease(id);
    expect(row.status).toBe("failed");
    expect(row.metadata?.[SSH_EXECUTION_EXIT_KEY]).toBeUndefined();
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(false);
  });

  it("records exact exit evidence at normal SSH completion for later settlement", async () => {
    const { companyId, agentId, environmentId } = await seed();
    const runId = await insertRun({ companyId, agentId, exitCode: 0 });
    const id = await insertLease({ companyId, agentId, environmentId, runId, status: "active", cleanupStatus: null, failureReason: null });

    const released = await environmentRuntimeService(db).releaseRunLeases(runId, "released");
    expect(released).toHaveLength(1);
    let row = await lease(id);
    expect(row.status).toBe("released");
    expect(row.metadata?.[SSH_EXECUTION_EXIT_KEY]).toMatchObject({ schema: "paperclip.ssh-execution-exit.v1",
      companyId, runId, leaseId: id, providerLeaseId, exitCode: 0, runStatus: "succeeded" });
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(true);

    // Later maintenance marks it for cleanup after process fields were cleared.
    await db.update(heartbeatRuns).set({ processStartedAt: null, processPid: null }).where(eq(heartbeatRuns.id, runId));
    await db.update(environmentLeases).set({ status: "pending_cleanup", cleanupStatus: "failed", updatedAt: long() })
      .where(eq(environmentLeases.id, id));
    await sweeper().sweepPendingCleanupLeases({ backoffMs: 0 });
    row = await lease(id);
    expect(row).toMatchObject({ status: "expired", cleanupStatus: "success" });
    expect(row.metadata?.[SSH_CLEANUP_RECONCILIATION_KEY]).toMatchObject({ evidence: { recordedAtRelease: true } });
  });

  it("rejects recorded exit evidence that no longer matches the run", async () => {
    const { companyId, agentId, environmentId } = await seed();
    const runId = await insertRun({ companyId, agentId, exitCode: 0 });
    const id = await insertLease({ companyId, agentId, environmentId, runId, status: "active", cleanupStatus: null, failureReason: null });
    await environmentRuntimeService(db).releaseRunLeases(runId, "released");
    await db.update(heartbeatRuns).set({ processStartedAt: new Date(Date.now() - 30 * 60_000) }).where(eq(heartbeatRuns.id, runId));
    await db.update(environmentLeases).set({ status: "pending_cleanup", cleanupStatus: "failed", updatedAt: long() })
      .where(eq(environmentLeases.id, id));
    await sweeper().sweepPendingCleanupLeases({ backoffMs: 0 });
    expect((await lease(id)).metadata?.[SSH_CLEANUP_RECONCILIATION_KEY]).toMatchObject({
      state: "unresolved", reason: "execution_generation_mismatch" });
  });

  it("cannot be applied by a stale cleanup attempt or after a newer acquisition", async () => {
    const { companyId, agentId, environmentId } = await seed();
    const runId = await insertRun({ companyId, agentId });
    const id = await insertLease({ companyId, agentId, environmentId, runId,
      metadata: { pendingCleanupAttemptId: "newer-owner", pendingCleanupInFlight: true } });
    const snapshot = await lease(id);
    expect(await reconcileSshPendingCleanup(db, snapshot, { attemptId: "stale-owner" })).toEqual({ outcome: "lost_attempt" });
    expect(await lease(id)).toEqual(snapshot);

    // A newer acquisition for the same run invalidates the older settlement.
    const racing = { ...snapshot };
    await insertLease({ companyId, agentId, environmentId, runId, status: "active", cleanupStatus: null,
      failureReason: null, acquiredAt: new Date(Date.now() - 10 * 60_000) });
    const outcome = await reconcileSshPendingCleanup(db, racing, { attemptId: "newer-owner" });
    expect(outcome).toMatchObject({ outcome: "unresolved", reason: "newer_lease_for_run" });
    expect((await lease(id)).status).toBe("pending_cleanup");
  });

  it("never touches another lease on the same SSH host and workspace", async () => {
    const { companyId, agentId, environmentId } = await seed();
    const runId = await insertRun({ companyId, agentId });
    const id = await insertLease({ companyId, agentId, environmentId, runId });
    const liveRun = await insertRun({ companyId, agentId, status: "running", exitCode: null, finishedAt: null });
    const live = await insertLease({ companyId, agentId, environmentId, runId: liveRun, status: "active",
      cleanupStatus: null, failureReason: null, acquiredAt: new Date(Date.now() - 5 * 60_000) });
    const before = await lease(live);

    await sweeper().sweepPendingCleanupLeases({ backoffMs: 0 });

    expect((await lease(id)).status).toBe("expired");
    expect(await lease(live)).toEqual(before);
    const others = await db.select().from(environmentLeases).where(and(
      eq(environmentLeases.providerLeaseId, providerLeaseId), eq(environmentLeases.status, "active")));
    expect(others.map(row => row.id)).toEqual([live]);
  });
});
