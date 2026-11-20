import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { truncateTablesWithDeadlockRetry } from "./helpers/truncate-with-deadlock-retry.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { legacyExecutionNeedsReconciliationWithEvidence } from "../services/legacy-execution-recovery.ts";
import {
  readPlannedShutdownMarkers,
  writePlannedShutdownMarker,
} from "../services/planned-shutdown-marker.ts";
import { resolveShutdownRunCompletionGraceMs } from "../shutdown.ts";

// The real adapter type: the no-replay gate trusts only gateway stop evidence.
const GATEWAY = "hermes_gateway";

type StopState = "acknowledged" | "unverified";
const gateway = {
  calls: 0,
  postComment: false,
  stopState: "acknowledged" as StopState,
  // Finish every later turn at once (for follow-up runs the platform starts).
  autoComplete: false,
  entered: [] as Array<() => void>,
  release: [] as Array<() => void>,
};

function waitForAdapterEntry() {
  return new Promise<void>((resolve) => gateway.entered.push(resolve));
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("planned shutdown helpers", () => {
  it("bounds the completion grace window", () => {
    expect(resolveShutdownRunCompletionGraceMs({})).toBe(10_000);
    expect(resolveShutdownRunCompletionGraceMs({ PAPERCLIP_SHUTDOWN_RUN_GRACE_MS: "0" })).toBe(0);
    expect(resolveShutdownRunCompletionGraceMs({ PAPERCLIP_SHUTDOWN_RUN_GRACE_MS: "2500" })).toBe(2500);
    expect(resolveShutdownRunCompletionGraceMs({ PAPERCLIP_SHUTDOWN_RUN_GRACE_MS: "999999" })).toBe(60_000);
    expect(resolveShutdownRunCompletionGraceMs({ PAPERCLIP_SHUTDOWN_RUN_GRACE_MS: "-1" })).toBe(10_000);
    expect(resolveShutdownRunCompletionGraceMs({ PAPERCLIP_SHUTDOWN_RUN_GRACE_MS: "soon" })).toBe(10_000);
  });

  it("writes, reads and expires planned shutdown markers", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "planned-shutdown-marker-"));
    try {
      const bootId = randomUUID();
      writePlannedShutdownMarker({ bootId, pid: 42, signal: "SIGTERM", at: new Date("2026-01-01T00:00:00Z") }, home);
      expect(readPlannedShutdownMarkers(new Date("2026-01-01T01:00:00Z"), home).get(bootId))
        .toMatchObject({ bootId, pid: 42, signal: "SIGTERM" });
      expect(() => writePlannedShutdownMarker({ bootId: "../escape", pid: 1, signal: "SIGTERM" }, home)).toThrow();
      // Past the retention window the marker is ignored and removed.
      expect(readPlannedShutdownMarkers(new Date("2026-01-03T00:00:00Z"), home).size).toBe(0);
      expect(readPlannedShutdownMarkers(new Date("2026-01-01T01:00:00Z"), home).size).toBe(0);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

describeEmbeddedPostgres("planned shutdown of hermes gateway runs", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let home = "";
  let previousHome: string | undefined;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-planned-shutdown-gateway-");
    db = createDb(tempDb.connectionString);
    await db.insert(authUsers).values({ id: "responsible-user", name: "Fixture owner", email: "owner@example.test",
      createdAt: new Date(), updatedAt: new Date() });
    registerServerAdapter({
      type: GATEWAY,
      execute: async (ctx) => {
        gateway.calls += 1;
        if (gateway.postComment) {
          await db.insert(issueComments).values({ companyId: String(ctx.agent.companyId),
            issueId: String(ctx.context?.issueId ?? ""), authorAgentId: ctx.agent.id, createdByRunId: ctx.runId,
            body: "Progress note written before the restart." });
        }
        await ctx.onCancellationReady?.();
        const outcome = await new Promise<"done" | "aborted">((resolve) => {
          if (ctx.signal?.aborted) return resolve("aborted");
          if (gateway.autoComplete) return resolve("done");
          ctx.signal?.addEventListener("abort", () => resolve("aborted"), { once: true });
          gateway.release.push(() => resolve("done"));
          gateway.entered.shift()?.();
        });
        if (outcome === "done") {
          return { exitCode: 0, signal: null, timedOut: false, provider: GATEWAY, summary: "finished" };
        }
        const at = new Date().toISOString();
        return {
          exitCode: null, signal: null, timedOut: false, provider: GATEWAY,
          errorCode: "cancelled", errorMessage: "Hermes gateway run was cancelled",
          resultJson: {
            run_id: "remote-run",
            executionCancellation: gateway.stopState === "acknowledged"
              ? { state: "acknowledged", acknowledgedAt: at, gatewayStatus: "cancelled" }
              : { state: "unverified", checkedAt: at, gatewayStatus: null },
          },
        };
      },
      testEnvironment: async () => ({ adapterType: GATEWAY, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 60_000);

  afterEach(async () => {
    for (const release of gateway.release.splice(0)) release();
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    await truncateTablesWithDeadlockRetry(
      db,
      `
        TRUNCATE TABLE
          "issue_recovery_actions",
          "issue_comments",
          "issues",
          "heartbeat_run_events",
          "cost_events",
          "activity_log",
          "heartbeat_runs",
          "agent_wakeup_requests",
          "agent_runtime_state",
          "agents",
          "companies"
        RESTART IDENTITY CASCADE
      `,
      { attempts: 10, delayMs: () => 100 },
    );
    Object.assign(gateway, { calls: 0, postComment: false, stopState: "acknowledged", autoComplete: false, entered: [], release: [] });
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    if (home) await fs.rm(home, { recursive: true, force: true });
    home = "";
  });

  afterAll(async () => {
    unregisterServerAdapter(GATEWAY);
    await tempDb?.cleanup();
  });

  async function useTempHome() {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "planned-shutdown-home-"));
    previousHome = process.env.PAPERCLIP_HOME;
    process.env.PAPERCLIP_HOME = home;
    return home;
  }

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user",
      status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Gateway agent", role: "engineer", status: "idle",
      adapterType: GATEWAY, adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Gateway task", status: "in_progress", priority: "medium",
      assigneeAgentId: agentId, issueNumber: 1, identifier: `${issuePrefix}-1` });
    return { companyId, agentId, issueId };
  }

  function wake(heartbeat: ReturnType<typeof heartbeatService>, f: { agentId: string; issueId: string }) {
    return heartbeat.wakeup(f.agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId: f.issueId },
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "user", requestedByActorId: "local-board",
    });
  }

  async function startLiveRun(heartbeat: ReturnType<typeof heartbeatService>, f: { agentId: string; issueId: string }) {
    const entered = waitForAdapterEntry();
    const run = await wake(heartbeat, f);
    expect(run).not.toBeNull();
    await entered;
    return run!.id;
  }

  async function getRun(id: string) {
    return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;
  }

  async function continuationsOf(runId: string) {
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
  }

  async function holdsFor(issueId: string) {
    return db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
  }

  it("lets a run that finishes inside the grace window complete, with no interruption or continuation", async () => {
    await useTempHome();
    const f = await seed();
    const heartbeat = heartbeatService(db);
    const runId = await startLiveRun(heartbeat, f);
    heartbeat.beginShutdownAdmissionStop();
    setTimeout(() => gateway.release.shift()?.(), 300);
    const drain = await heartbeat.drainRunningRunsForShutdown("SIGTERM", new Date(), null, { completionGraceMs: 5_000 });
    expect(drain).toMatchObject({ interruptedRunIds: [], retryRunIds: [], completedDuringGrace: 1 });
    expect(await getRun(runId)).toMatchObject({ status: "succeeded" });
    expect(await continuationsOf(runId)).toHaveLength(0);
    expect(gateway.calls).toBe(1);
  });

  it("interrupts an effect-free run through the gateway stop and leaves exactly one retryable continuation", async () => {
    await useTempHome();
    const f = await seed();
    const heartbeat = heartbeatService(db);
    const runId = await startLiveRun(heartbeat, f);
    heartbeat.beginShutdownAdmissionStop();
    const drain = await heartbeat.drainRunningRunsForShutdown("SIGTERM", new Date(), null, { completionGraceMs: 0 });
    expect(drain.interruptedRunIds).toEqual([runId]);
    expect(drain.retryRunIds).toHaveLength(1);
    const interrupted = await getRun(runId);
    expect(interrupted).toMatchObject({ status: "interrupted", errorCode: "server_shutdown_interrupted", signal: "SIGTERM" });
    expect(interrupted.errorCode).not.toBe("process_lost");
    expect(interrupted.resultJson).toMatchObject({ executionCancellation: { state: "acknowledged" } });
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, interrupted)).toBe(false);
    const continuations = await continuationsOf(runId);
    expect(continuations).toHaveLength(1);
    expect(continuations[0]).toMatchObject({ agentId: f.agentId, companyId: f.companyId });
    expect(continuations[0]!.contextSnapshot).toMatchObject({ issueId: f.issueId });
    // The interrupted write held the run before the stop was confirmed; the
    // confirmed effect-free stop retires that hold instead of leaving it open.
    expect((await holdsFor(f.issueId)).filter((h) => h.status === "active" || h.status === "escalated")).toHaveLength(0);
    // Admission is stopped: the continuation waits for the next process.
    expect(gateway.calls).toBe(1);
  });

  it("does not replay a stopped run that already recorded an external effect", async () => {
    await useTempHome();
    const f = await seed();
    gateway.postComment = true;
    const heartbeat = heartbeatService(db);
    const runId = await startLiveRun(heartbeat, f);
    heartbeat.beginShutdownAdmissionStop();
    const drain = await heartbeat.drainRunningRunsForShutdown("SIGTERM", new Date(), null, { completionGraceMs: 0 });
    expect(drain.interruptedRunIds).toEqual([runId]);
    expect(drain.retryRunIds).toHaveLength(0);
    const interrupted = await getRun(runId);
    expect(interrupted).toMatchObject({ status: "interrupted", errorCode: "server_shutdown_interrupted" });
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, interrupted)).toBe(true);
    expect(await continuationsOf(runId)).toHaveLength(0);
    expect((await holdsFor(f.issueId)).map((h) => [h.cause, h.status]))
      .toEqual([["legacy_execution_requires_reconciliation", "active"]]);
    expect(gateway.calls).toBe(1);
  });

  it("does not replay a run whose gateway stop could not be confirmed", async () => {
    await useTempHome();
    const f = await seed();
    gateway.stopState = "unverified";
    const heartbeat = heartbeatService(db);
    const runId = await startLiveRun(heartbeat, f);
    heartbeat.beginShutdownAdmissionStop();
    const drain = await heartbeat.drainRunningRunsForShutdown("SIGTERM", new Date(), null, { completionGraceMs: 0 });
    expect(drain.interruptedRunIds).toEqual([runId]);
    expect(drain.retryRunIds).toHaveLength(0);
    const interrupted = await getRun(runId);
    expect(interrupted.resultJson).toMatchObject({ executionCancellation: { state: "unverified" } });
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, interrupted)).toBe(true);
    expect(await continuationsOf(runId)).toHaveLength(0);
  });

  it("leaves one continuation when shutdown is signalled twice", async () => {
    await useTempHome();
    const f = await seed();
    const heartbeat = heartbeatService(db);
    const runId = await startLiveRun(heartbeat, f);
    heartbeat.beginShutdownAdmissionStop();
    heartbeat.beginShutdownAdmissionStop();
    const [first, second] = await Promise.all([
      heartbeat.drainRunningRunsForShutdown("SIGTERM", new Date(), null, { completionGraceMs: 0 }),
      heartbeat.drainRunningRunsForShutdown("SIGINT", new Date(), null, { completionGraceMs: 0 }),
    ]);
    const third = await heartbeat.drainRunningRunsForShutdown("SIGTERM", new Date(), null, { completionGraceMs: 0 });
    expect([...first.interruptedRunIds, ...second.interruptedRunIds, ...third.interruptedRunIds]).toEqual([runId]);
    expect(await continuationsOf(runId)).toHaveLength(1);
    expect((await getRun(runId)).errorCode).toBe("server_shutdown_interrupted");
  });

  it("holds new run starts once shutdown begins, keeping the wake queued for the next process", async () => {
    await useTempHome();
    const f = await seed();
    const heartbeat = heartbeatService(db);
    heartbeat.beginShutdownAdmissionStop();
    const run = await wake(heartbeat, f);
    expect(run).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await getRun(run!.id)).toMatchObject({ status: "queued" });
    expect(gateway.calls).toBe(0);
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agentId));
    expect(wakes.map((w) => w.status)).not.toContain("skipped");
    // The next process (no shutdown in progress) starts the held run normally.
    const next = heartbeatService(db);
    const entered = waitForAdapterEntry();
    await next.resumeQueuedRunsForAgent(f.companyId, f.agentId);
    await entered;
    // The issue is still open after the held run, so the platform may start a
    // follow-up turn; let it finish instead of waiting on the stub.
    gateway.autoComplete = true;
    gateway.release.shift()?.();
    await drainHeartbeatRunsToQuiescence(db, next);
    expect(await getRun(run!.id)).toMatchObject({ status: "succeeded" });
  }, 60_000);

  async function seedLeftoverFromStoppedBoot(f: { companyId: string; agentId: string; issueId: string }, bootId: string,
    executionStage: "preparing" | "dispatching" = "dispatching", leaseExpired = true) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId,
      invocationSource: "assignment", status: "running", runtimeMode: "legacy", startedAt: new Date(),
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "issue_assigned" } });
    await db.update(heartbeatRuns).set({
      controllerBootId: bootId,
      controllerLeaseExpiresAt: leaseExpired
        ? sql`clock_timestamp() - interval '1 second'`
        : sql`clock_timestamp() + interval '5 minutes'`,
      executionStage,
    }).where(eq(heartbeatRuns.id, runId));
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, f.issueId));
    return runId;
  }

  it("keeps an unplanned crash on the unchanged process_lost path", async () => {
    await useTempHome();
    const f = await seed();
    const runId = await seedLeftoverFromStoppedBoot(f, randomUUID());
    await heartbeatService(db).reapOrphanedRuns();
    const reaped = await getRun(runId);
    expect(reaped).toMatchObject({ status: "failed", errorCode: "process_lost" });
    expect(reaped.resultJson).not.toHaveProperty("plannedShutdownRecovery");
  });

  it("records a planned-restart leftover as interrupted, not process_lost, and keeps the no-replay hold", async () => {
    await useTempHome();
    const f = await seed();
    const bootId = randomUUID();
    writePlannedShutdownMarker({ bootId, pid: 4242, signal: "SIGTERM" });
    const runId = await seedLeftoverFromStoppedBoot(f, bootId, "dispatching");
    await heartbeatService(db).reapOrphanedRuns();
    const reaped = await getRun(runId);
    expect(reaped).toMatchObject({ status: "interrupted", errorCode: "server_shutdown_interrupted", signal: "SIGTERM" });
    expect(reaped.resultJson).toMatchObject({ plannedShutdownRecovery: { signal: "SIGTERM" } });
    // The stop of the remote turn was never confirmed: no blind retry.
    expect(await continuationsOf(runId)).toHaveLength(0);
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, reaped)).toBe(true);
    expect(gateway.calls).toBe(0);
  });

  it("retries a planned-restart leftover once when it never reached the gateway", async () => {
    await useTempHome();
    const f = await seed();
    const bootId = randomUUID();
    writePlannedShutdownMarker({ bootId, pid: 4242, signal: "SIGTERM" });
    const runId = await seedLeftoverFromStoppedBoot(f, bootId, "preparing");
    const heartbeat = heartbeatService(db);
    heartbeat.beginShutdownAdmissionStop();
    await heartbeat.reapOrphanedRuns();
    await heartbeat.reapOrphanedRuns();
    const reaped = await getRun(runId);
    expect(reaped).toMatchObject({ status: "interrupted", errorCode: "server_shutdown_interrupted" });
    expect(reaped.resultJson).toMatchObject({ executionRecovery: { kind: "bootstrap", providerWorkStarted: false } });
    expect(await continuationsOf(runId)).toHaveLength(1);
  });

  it("does not touch a run still owned by a live controller, even with a planned-shutdown marker", async () => {
    await useTempHome();
    const f = await seed();
    const bootId = randomUUID();
    writePlannedShutdownMarker({ bootId, pid: 4242, signal: "SIGTERM" });
    const runId = await seedLeftoverFromStoppedBoot(f, bootId, "dispatching", false);
    await heartbeatService(db).reapOrphanedRuns();
    expect(await getRun(runId)).toMatchObject({ status: "running", errorCode: null });
    expect(await continuationsOf(runId)).toHaveLength(0);
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() })
      .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.status, "running")));
  });
});
