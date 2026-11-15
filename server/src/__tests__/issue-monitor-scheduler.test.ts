import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PROVIDER_QUOTA_MONITOR_SERVICE_NAME } from "@paperclipai/shared";
import {
  costEvents,
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueDocuments,
  issues,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { normalizeIssueExecutionPolicy, parseIssueExecutionState } from "../services/issue-execution-policy.ts";
import { PaperclipRunnerToolAuthority } from "../services/native-runtime/paperclip-runner-tool-authority.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue monitor scheduler tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue monitor scheduler", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const seededAgentIds = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-monitor-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  async function waitForHeartbeatIdle(timeoutMs = 3_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const active = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`);
      if (active.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for issue monitor heartbeat runs to settle");
  }

  async function heartbeatSideEffectFingerprint() {
    const [active, events, activity, leases, runtimeServices] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)` })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`),
      db.select({ count: sql<number>`count(*)` }).from(heartbeatRunEvents),
      db.select({ count: sql<number>`count(*)` }).from(activityLog),
      db.select({ count: sql<number>`count(*)` }).from(environmentLeases),
      db.select({ count: sql<number>`count(*)` }).from(workspaceRuntimeServices),
    ]);

    return [
      active[0]?.count ?? 0,
      events[0]?.count ?? 0,
      activity[0]?.count ?? 0,
      leases[0]?.count ?? 0,
      runtimeServices[0]?.count ?? 0,
    ].join(":");
  }

  async function waitForHeartbeatSideEffectsSettled(timeoutMs = 5_000, quietMs = 500) {
    const deadline = Date.now() + timeoutMs;
    let previous = "";
    let stableSince = Date.now();
    while (Date.now() < deadline) {
      const current = await heartbeatSideEffectFingerprint();
      const activeCount = Number(current.split(":")[0] ?? 0);
      if (current !== previous || activeCount > 0) {
        previous = current;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= quietMs) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for issue monitor heartbeat side effects to settle");
  }

  async function cleanupRows() {
    await waitForHeartbeatSideEffectsSettled();
    await db.delete(heartbeatRunEvents);
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(documentRevisions);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(activityLog);
    await db.delete(environmentLeases);
    await db.delete(workspaceRuntimeServices);
    await db.delete(issues);
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  }

  afterEach(async () => {
    // The no-op process fixtures deliberately leave no task disposition. The
    // real lifecycle can now leave a bounded, scheduled repair after the
    // monitor assertions. Cancel that remaining work only during teardown.
    const heartbeat = heartbeatService(db);
    await heartbeat.drainActiveRunExecutions();
    const pending = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`);
    for (const run of pending) await heartbeat.cancelRun(run.id, "Monitor fixture teardown", { suppressImmediateRecovery: true });
    await heartbeat.drainActiveRunExecutions();
    seededAgentIds.clear();
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await cleanupRows();
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw lastError;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture(input?: {
    agentStatus?: "active" | "paused";
    issueStatus?: "in_progress" | "in_review";
    monitorAttemptCount?: number;
    monitor?: Record<string, unknown>;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const nextCheckAt = new Date("2026-04-11T12:30:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    const monitorAttemptCount = input?.monitorAttemptCount ?? 0;
    const monitor = {
      nextCheckAt: nextCheckAt.toISOString(),
      notes: "Check deploy",
      scheduledBy: "assignee",
      ...(input?.monitor ?? {}),
    };

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Monitor Bot",
      role: "engineer",
      status: input?.agentStatus ?? "active",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", ""],
        cwd: process.cwd(),
      },
      runtimeConfig: {
        heartbeat: {
          enabled: false,
          wakeOnDemand: true,
        },
      },
      permissions: {},
    });
    seededAgentIds.add(agentId);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Watch external deploy",
      status: input?.issueStatus ?? "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [],
        monitor,
      },
      executionState: {
        status: "idle",
        currentStageId: null,
        currentStageIndex: null,
        currentStageType: null,
        currentParticipant: null,
        returnAssignee: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: {
          status: "scheduled",
          nextCheckAt: nextCheckAt.toISOString(),
          lastTriggeredAt: null,
          attemptCount: monitorAttemptCount,
          notes: "Check deploy",
          scheduledBy: "assignee",
          serviceName: typeof monitor.serviceName === "string" ? monitor.serviceName : null,
          externalRef: typeof monitor.externalRef === "string" ? monitor.externalRef : null,
          timeoutAt: typeof monitor.timeoutAt === "string" ? monitor.timeoutAt : null,
          maxAttempts: typeof monitor.maxAttempts === "number" ? monitor.maxAttempts : null,
          recoveryPolicy: typeof monitor.recoveryPolicy === "string" ? monitor.recoveryPolicy : null,
          clearedAt: null,
          clearReason: null,
        },
      },
      monitorNextCheckAt: nextCheckAt,
      monitorAttemptCount,
      monitorNotes: "Check deploy",
      monitorScheduledBy: "assignee",
    });

    return { companyId, agentId, issueId, nextCheckAt };
  }

  it("triggers due issue monitors once and clears the one-shot schedule", async () => {
    const { issueId, agentId } = await seedFixture();
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");
    const [before] = await db.select().from(issues).where(eq(issues.id, issueId));
    const unrelatedPolicy = { commentRequired: false, futureAuthorization: { preserve: true } };
    await db.update(issues).set({ executionPolicy: { ...before.executionPolicy, ...unrelatedPolicy } }).where(eq(issues.id, issueId));

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(issue.executionPolicy).toMatchObject(unrelatedPolicy);
    expect(issue.monitorAttemptCount).toBe(1);
    expect(issue.monitorLastTriggeredAt?.toISOString()).toBe(tickAt.toISOString());
    expect(normalizeIssueExecutionPolicy(issue.executionPolicy ?? null)?.monitor ?? null).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "triggered",
      lastTriggeredAt: tickAt.toISOString(),
      attemptCount: 1,
    });

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.reason).toBe("issue_monitor_due");

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity).toContain("issue.monitor_triggered");
  });

  it("preserves a due monitor through native execution and dispatches once after release", async () => {
    const { companyId, issueId, agentId, nextCheckAt } = await seedFixture();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId,
      runtimeMode: "native", status: "running", contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const heartbeat = heartbeatService(db);
    expect((await heartbeat.tickTimers(new Date("2026-04-11T12:31:00.000Z"))).enqueued).toBe(0);
    const [waiting] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(waiting.monitorNextCheckAt).toEqual(nextCheckAt);
    expect(waiting.monitorWakeRequestedAt).toBeNull();
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, issueId));
    expect((await heartbeat.tickTimers(new Date("2026-04-11T12:32:00.000Z"))).enqueued).toBe(1);
    expect((await heartbeat.tickTimers(new Date("2026-04-11T12:33:00.000Z"))).enqueued).toBe(0);
    const [triggered] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(triggered.monitorNextCheckAt).toBeNull();
    expect(triggered.monitorAttemptCount).toBe(1);
    expect((await db.select().from(agentWakeupRequests)).filter(wake => wake.reason === "issue_monitor_due")).toHaveLength(1);
  });

  it("explains held monitor dispatch without replaying uncertain execution", async () => {
    const { companyId, issueId, agentId, nextCheckAt } = await seedFixture();
    const sourceRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId,
      runtimeMode: "legacy", status: "interrupted", errorCode: "process_lost",
      finishedAt: new Date(), contextSnapshot: { issueId } });
    const [hold] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", status: "active", ownerType: "board",
      cause: "legacy_execution_requires_reconciliation", fingerprint: sourceRunId,
      evidence: { runId: sourceRunId }, nextAction: "Inspect the interrupted execution before continuing." }).returning();
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");
    expect((await heartbeat.tickTimers(tickAt)).enqueued).toBe(0);
    expect((await heartbeat.tickTimers(new Date(tickAt.getTime() + 30_000))).enqueued).toBe(0);
    const [waiting] = await db.select().from(issues).where(eq(issues.id, issueId));
    // The held fire counts one attempt and backs off instead of re-firing every tick.
    expect(waiting.monitorNextCheckAt).toEqual(new Date(tickAt.getTime() + 60_000));
    expect(waiting.monitorWakeRequestedAt).toBeNull();
    expect(waiting.monitorAttemptCount).toBe(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).toHaveLength(1);
    const diagnostics = (await db.select().from(activityLog).where(eq(activityLog.entityId, issueId)))
      .filter(row => row.action === "issue.monitor_deferred");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.details).toMatchObject({ nextCheckAt: nextCheckAt.toISOString(),
      rescheduledNextCheckAt: new Date(tickAt.getTime() + 60_000).toISOString(), deferredCount: 1,
      reason: "execution_reconciliation_required", blockerCause: "legacy_execution_requires_reconciliation", attemptCount: 1 });
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, hold!.id)))[0]?.status).toBe("active");
    await db.update(issueRecoveryActions).set({ status: "resolved", resolvedAt: new Date(),
      evidence: { runId: sourceRunId, executionReconciliation: { action: "continue" } } }).where(eq(issueRecoveryActions.id, hold!.id));
    expect((await heartbeat.tickTimers(new Date(tickAt.getTime() + 60_000))).enqueued).toBe(1);
    expect((await heartbeat.tickTimers(new Date(tickAt.getTime() + 90_000))).enqueued).toBe(0);
    const [triggered] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(triggered.monitorAttemptCount).toBe(2);
    expect(triggered.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(triggered.executionState)?.monitor).toMatchObject({ status: "triggered", attemptCount: 2 });
    expect(parseIssueExecutionState(triggered.executionState)?.monitor?.deferredCount).toBeUndefined();
  });

  async function holdIssueExecution(input: { companyId: string; agentId: string; issueId: string }) {
    const sourceRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId: input.companyId, agentId: input.agentId,
      runtimeMode: "legacy", status: "interrupted", errorCode: "process_lost",
      finishedAt: new Date(), contextSnapshot: { issueId: input.issueId } });
    await db.insert(issueRecoveryActions).values({ companyId: input.companyId, sourceIssueId: input.issueId,
      kind: "active_run_watchdog", status: "active", ownerType: "board",
      cause: "legacy_execution_requires_reconciliation", fingerprint: sourceRunId,
      evidence: { runId: sourceRunId }, nextAction: "Inspect the interrupted execution before continuing." });
  }

  async function readIssue(issueId: string) {
    return db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
  }

  it("counts and backs off held monitor fires until maxAttempts clears them through recovery", async () => {
    const fixture = await seedFixture({ monitor: { maxAttempts: 3, recoveryPolicy: "wake_owner" } });
    const { issueId, agentId, nextCheckAt } = fixture;
    await holdIssueExecution(fixture);
    const heartbeat = heartbeatService(db);

    let dueAt = new Date(nextCheckAt.getTime() + 60_000);
    let previousDelay = 0;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect((await heartbeat.tickTimers(dueAt)).enqueued).toBe(0);
      const issue = await readIssue(issueId);
      expect(issue.monitorAttemptCount).toBe(attempt);
      expect(issue.monitorWakeRequestedAt).toBeNull();
      expect(issue.monitorNextCheckAt!.getTime()).toBeGreaterThan(dueAt.getTime());
      const delay = issue.monitorNextCheckAt!.getTime() - dueAt.getTime();
      expect(delay).toBeGreaterThanOrEqual(previousDelay);
      previousDelay = delay;
      expect(normalizeIssueExecutionPolicy(issue.executionPolicy)?.monitor?.nextCheckAt)
        .toBe(issue.monitorNextCheckAt!.toISOString());
      expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
        status: "scheduled", attemptCount: attempt, nextCheckAt: issue.monitorNextCheckAt!.toISOString(),
      });
      // A tick before the backed-off time is a no-op: the row is no longer due every tick.
      await heartbeat.tickTimers(new Date(dueAt.getTime() + 1_000));
      expect((await readIssue(issueId)).monitorAttemptCount).toBe(attempt);
      dueAt = issue.monitorNextCheckAt!;
    }

    await heartbeat.tickTimers(dueAt);
    const cleared = await readIssue(issueId);
    expect(cleared.monitorNextCheckAt).toBeNull();
    expect(normalizeIssueExecutionPolicy(cleared.executionPolicy)?.monitor ?? null).toBeNull();
    expect(parseIssueExecutionState(cleared.executionState)?.monitor).toMatchObject({
      status: "cleared", clearReason: "max_attempts_exhausted",
    });
    // The owner recovery wake goes through the unchanged recovery path; the active
    // execution hold still gates it (coalesced into the hold's skipped request).
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes.filter((wake) => wake.status !== "skipped")).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).toHaveLength(1);
    const actions = (await db.select().from(activityLog).where(eq(activityLog.entityId, issueId))).map((row) => row.action);
    expect(actions.filter((action) => action === "issue.monitor_deferred")).toHaveLength(3);
    expect(actions).toContain("issue.monitor_exhausted");
    expect(actions).toContain("issue.monitor_recovery_wake_queued");
    expect(actions).not.toContain("issue.monitor_triggered");
  });

  it("bounds held monitor fires without maxAttempts or timeoutAt", async () => {
    const fixture = await seedFixture();
    const { issueId, agentId, nextCheckAt } = fixture;
    await holdIssueExecution(fixture);
    const heartbeat = heartbeatService(db);

    let dueAt = new Date(nextCheckAt.getTime() + 60_000);
    let fires = 0;
    for (; fires < 40; fires += 1) {
      await heartbeat.tickTimers(dueAt);
      const issue = await readIssue(issueId);
      if (!issue.monitorNextCheckAt) break;
      expect(issue.monitorNextCheckAt.getTime()).toBeGreaterThan(dueAt.getTime());
      expect(issue.monitorNextCheckAt.getTime() - dueAt.getTime()).toBeLessThanOrEqual(30 * 60_000);
      dueAt = issue.monitorNextCheckAt;
    }
    expect(fires).toBeLessThan(40);
    const cleared = await readIssue(issueId);
    expect(cleared.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(cleared.executionState)?.monitor).toMatchObject({
      status: "cleared", clearReason: "dispatch_deferred_exhausted",
    });
    // The owner recovery wake goes through the unchanged recovery path; the active
    // execution hold still gates it (coalesced into the hold's skipped request).
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes.filter((wake) => wake.status !== "skipped")).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).toHaveLength(1);
    const actions = (await db.select().from(activityLog).where(eq(activityLog.entityId, issueId))).map((row) => row.action);
    expect(actions.filter((action) => action === "issue.monitor_deferred")).toHaveLength(10);
    expect(actions).toContain("issue.monitor_exhausted");
    expect(actions).toContain("issue.monitor_recovery_wake_queued");
    expect(fires).toBe(10);
  });

  it("does not clobber a monitor replaced while a held fire is being deferred", async () => {
    const fixture = await seedFixture();
    const { issueId } = fixture;
    await holdIssueExecution(fixture);
    const replacementAt = new Date("2026-04-11T13:30:00.000Z");
    let replaced = false;
    const racingDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "transaction") return Reflect.get(target, property, receiver);
        return async (callback: Parameters<typeof db.transaction>[0]) => {
          const result = await db.transaction(callback);
          const row = result as { id?: string; monitorWakeRequestedAt?: Date | null } | null;
          if (!replaced && row?.id === issueId && row.monitorWakeRequestedAt) {
            replaced = true;
            await db.update(issues).set({ monitorNextCheckAt: replacementAt, monitorWakeRequestedAt: null,
              executionPolicy: { monitor: { nextCheckAt: replacementAt.toISOString(), notes: "New check", scheduledBy: "assignee" } },
            }).where(eq(issues.id, issueId));
          }
          return result;
        };
      },
    });
    await heartbeatService(racingDb).tickTimers(new Date("2026-04-11T12:31:00.000Z"));
    expect(replaced).toBe(true);
    const issue = await readIssue(issueId);
    expect(issue.monitorNextCheckAt).toEqual(replacementAt);
    expect(issue.monitorAttemptCount).toBe(0);
    expect(normalizeIssueExecutionPolicy(issue.executionPolicy)?.monitor?.nextCheckAt).toBe(replacementAt.toISOString());
  });

  it("recovers a rejected native monitor call and delivers the corrected schedule once", async () => {
    const { companyId, issueId, agentId } = await seedFixture();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId,
      runtimeMode: "native", status: "running", contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: runId, executionPolicy: null, executionState: null,
      monitorNextCheckAt: null, monitorNotes: null, monitorScheduledBy: null }).where(eq(issues.id, issueId));
    const authority = new PaperclipRunnerToolAuthority(db, { companyId, issueId, agentId, runId });
    const monitor = { nextCheckAt: new Date(Date.now() + 60_000).toISOString(), notes: "Inspect pending CI." };
    const call = (arguments_: Record<string, unknown>) => authority.execute({
      tool: "set_task_monitor", callId: randomUUID(), arguments: arguments_,
    });
    try {
      await expect(call({ idempotencyKey: "check-ci", ...monitor })).rejects.toThrow();
      const [unchanged] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(unchanged.monitorNextCheckAt).toBeNull();
      expect(unchanged.executionPolicy).toBeNull();
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(run.resultJson?.semanticToolReceipts).toBeUndefined();
      expect(await db.select().from(activityLog).where(eq(activityLog.entityId, issueId))).toHaveLength(0);
      expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);

      const corrected = { idempotencyKey: "check-ci", monitor };
      await expect(call(corrected)).resolves.toMatchObject({ monitor: { ...monitor, status: "scheduled" }, replayed: false });
      await expect(call(corrected)).resolves.toMatchObject({ replayed: true });
      const [scheduled] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(scheduled.monitorNextCheckAt?.toISOString()).toBe(monitor.nextCheckAt);
      expect(scheduled.monitorScheduledBy).toBe("assignee");
      const activity = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
      expect(activity.filter(row => row.action === "issue.monitor_scheduled")).toHaveLength(1);
    } finally {
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
      await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, issueId));
    }

    const heartbeat = heartbeatService(db);
    const tickAt = new Date(Date.parse(monitor.nextCheckAt) + 1_000);
    expect((await heartbeat.tickTimers(tickAt)).enqueued).toBe(1);
    expect((await heartbeat.tickTimers(new Date(tickAt.getTime() + 1_000))).enqueued).toBe(0);
    const [triggered] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(triggered.monitorNextCheckAt).toBeNull();
    expect(triggered.monitorAttemptCount).toBe(1);
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes.filter(wake => wake.reason === "issue_monitor_due")).toHaveLength(1);
  });

  it.each(["replaced", "cleared", "reassigned", "completed"] as const)("fences a monitor %s after claim but before wake admission", async (change) => {
    const { companyId, issueId, agentId } = await seedFixture();
    const replacementAt = new Date("2026-04-11T13:30:00.000Z");
    let raced = false;
    const racingDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "transaction") return Reflect.get(target, property, receiver);
        return async (callback: Parameters<typeof db.transaction>[0]) => {
          const result = await db.transaction(callback);
          const claimed = result as { id?: string; monitorWakeRequestedAt?: Date } | undefined;
          if (!raced && claimed?.id === issueId && claimed.monitorWakeRequestedAt) {
            raced = true;
            await db.update(issues).set(change === "replaced" ? {
              monitorNextCheckAt: replacementAt, monitorWakeRequestedAt: null,
              executionPolicy: { monitor: { nextCheckAt: replacementAt.toISOString(), notes: "Replacement check", scheduledBy: "assignee" } },
            } : change === "cleared" ? { monitorNextCheckAt: null, monitorWakeRequestedAt: null, executionPolicy: null }
              : change === "reassigned" ? { assigneeAgentId: null } : { status: "done" })
              .where(eq(issues.id, issueId));
          }
          return result;
        };
      },
    });
    expect((await heartbeatService(racingDb).tickTimers(new Date("2026-04-11T12:31:00.000Z"))).enqueued).toBe(0);
    expect(raced).toBe(true);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)))
      .filter(wake => wake.reason === "issue_monitor_due")).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).toHaveLength(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    if (change === "replaced") expect(issue.monitorNextCheckAt).toEqual(replacementAt);
    if (change === "cleared") expect(issue.monitorNextCheckAt).toBeNull();
  });

  it("does not erase a replacement scheduled after wake admission", async () => {
    const { companyId, issueId } = await seedFixture();
    const nextCheckAt = new Date("2026-04-11T13:30:00.000Z");
    let replaced = false;
    const racingDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "transaction") return Reflect.get(target, property, receiver);
        return async (callback: Parameters<typeof db.transaction>[0]) => {
          const result = await db.transaction(callback);
          if (!replaced && (result as { kind?: string } | undefined)?.kind === "queued") {
            replaced = true;
            await db.update(issues).set({ monitorNextCheckAt: nextCheckAt, monitorWakeRequestedAt: null,
              executionPolicy: { monitor: { nextCheckAt: nextCheckAt.toISOString(), notes: "New check", scheduledBy: "assignee" } },
            }).where(eq(issues.id, issueId));
          }
          return result;
        };
      },
    });
    await heartbeatService(racingDb).tickTimers(new Date("2026-04-11T12:31:00.000Z"));
    expect(replaced).toBe(true);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.monitorNextCheckAt).toEqual(nextCheckAt);
    expect(issue.monitorWakeRequestedAt).toBeNull();
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)))
      .filter(wake => wake.reason === "issue_monitor_due")).toHaveLength(1);
  });

  it.each(["unknown", "exhausted"] as const)("does not replay a quota monitor with %s execution evidence", async (kind) => {
    const sourceRunId = randomUUID();
    const { companyId, issueId, agentId } = await seedFixture({
      monitor: { serviceName: PROVIDER_QUOTA_MONITOR_SERVICE_NAME, externalRef: sourceRunId },
    });
    await db.insert(heartbeatRuns).values({
      id: sourceRunId, companyId, agentId, status: "failed", errorCode: "provider_quota",
      finishedAt: new Date("2026-04-11T12:00:00.000Z"), contextSnapshot: { issueId },
      scheduledRetryAttempt: kind === "exhausted" ? 2 : 0,
      resultJson: kind === "exhausted" ? { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } : null,
    });
    await heartbeatService(db).tickTimers(new Date("2026-04-11T12:31:00.000Z"));
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
    expect(await db.select().from(issueRecoveryActions)).toMatchObject([{ ownerType: "board", evidence: { runId: sourceRunId } }]);
  });

  it("wakes a cross-agent review participant for provider quota monitors", async () => {
    const sourceRunId = randomUUID();
    const { companyId, issueId, agentId: assigneeAgentId } = await seedFixture({
      issueStatus: "in_review",
      monitor: { serviceName: PROVIDER_QUOTA_MONITOR_SERVICE_NAME, externalRef: sourceRunId },
    });
    const participantAgentId = randomUUID();
    await db.insert(agents).values({
      id: participantAgentId,
      companyId,
      name: "Quota-limited reviewer",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", ""],
        cwd: process.cwd(),
      },
      runtimeConfig: {
        heartbeat: {
          enabled: false,
          wakeOnDemand: true,
        },
      },
      permissions: {},
    });
    seededAgentIds.add(participantAgentId);
    const monitorState = await db
      .select({ executionState: issues.executionState })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => parseIssueExecutionState(rows[0]?.executionState ?? null)?.monitor ?? null);
    await db.update(issues).set({
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: participantAgentId, userId: null },
        returnAssignee: { type: "agent", agentId: assigneeAgentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: monitorState,
      },
    }).where(eq(issues.id, issueId));
    await db.insert(heartbeatRuns).values({
      id: sourceRunId, companyId, agentId: participantAgentId, status: "failed",
      errorCode: "provider_quota", finishedAt: new Date("2026-04-11T12:00:00.000Z"),
      contextSnapshot: { issueId },
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");
    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(1);
    const wakeups = await db.select().from(agentWakeupRequests);
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      agentId: participantAgentId,
      reason: "execution_review_participant_recovery",
    });
    const [scheduled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, sourceRunId));
    expect(scheduled).toMatchObject({ status: "scheduled_retry", scheduledRetryAttempt: 1 });
    expect(await heartbeat.promoteDueScheduledRetries(scheduled.scheduledRetryAt!)).toMatchObject({ promoted: 1 });
    await heartbeat.resumeQueuedRuns();
    await waitForHeartbeatIdle();
    const participantRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, participantAgentId));
    expect(participantRuns).toHaveLength(2);
    expect(participantRuns.find((run) => run.id === scheduled.id)?.errorCode).not.toBe("issue_assignee_changed");
  });

  it("lets the board trigger a scheduled issue monitor immediately", async () => {
    const { issueId, agentId, nextCheckAt } = await seedFixture();
    const heartbeat = heartbeatService(db);
    const triggeredAt = new Date("2026-04-11T12:00:00.000Z");

    const result = await heartbeat.triggerIssueMonitor(issueId, {
      now: triggeredAt,
      actorType: "user",
      actorId: "local-board",
    });

    expect(result.outcome).toBe("triggered");

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(issue.monitorLastTriggeredAt?.toISOString()).toBe(triggeredAt.toISOString());
    expect(issue.monitorAttemptCount).toBe(1);
    expect(normalizeIssueExecutionPolicy(issue.executionPolicy ?? null)?.monitor ?? null).toBeNull();

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.reason).toBe("issue_monitor_due");
    expect(wakeup?.payload).toMatchObject({
      issueId,
      nextCheckAt: nextCheckAt.toISOString(),
      source: "manual",
    });

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .orderBy(activityLog.createdAt);
    expect(activity.map((row) => row.action)).toContain("issue.monitor_triggered");
    const triggerEvent = activity.find((row) => row.action === "issue.monitor_triggered");
    expect(triggerEvent?.actorType).toBe("user");
    expect(triggerEvent?.actorId).toBe("local-board");
    expect(triggerEvent?.details).toMatchObject({
      nextCheckAt: nextCheckAt.toISOString(),
      source: "manual",
    });
  });

  it("clears due monitors that cannot be dispatched and records a skip", async () => {
    const { issueId } = await seedFixture({ agentStatus: "paused" });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.skipped).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "dispatch_skipped",
    });

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity).toContain("issue.monitor_skipped");
  });

  it("clears exhausted monitors and queues bounded owner recovery instead of another due check", async () => {
    const { issueId, agentId } = await seedFixture({
      monitorAttemptCount: 1,
      monitor: {
        maxAttempts: 1,
        recoveryPolicy: "wake_owner",
      },
    });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(0);
    expect(result.skipped).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "max_attempts_exhausted",
    });

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.reason).toBe("issue_monitor_recovery");
    expect(wakeup?.payload).toMatchObject({
      issueId,
      clearReason: "max_attempts_exhausted",
      maxAttempts: 1,
    });

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity).toContain("issue.monitor_exhausted");
    expect(activity).toContain("issue.monitor_recovery_wake_queued");
    expect(activity).not.toContain("issue.monitor_triggered");
  });

  it("clears timed-out monitors and creates a visible recovery issue when requested", async () => {
    const { issueId, companyId } = await seedFixture({
      monitor: {
        timeoutAt: "2026-04-11T12:00:00.000Z",
        recoveryPolicy: "create_recovery_issue",
      },
    });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(0);
    expect(result.skipped).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "timeout_exceeded",
    });

    const recoveryIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.originId, issueId))
      .then((rows) => rows.find((row) => row.companyId === companyId && row.originKind === "stranded_issue_recovery") ?? null);
    expect(recoveryIssue).toMatchObject({
      parentId: issueId,
      priority: "high",
      assigneeAdapterOverrides: null,
    });
    expect(["todo", "in_progress"]).toContain(recoveryIssue?.status);
  });

  it("omits external monitor refs from wake payloads and activity details", async () => {
    const { issueId, agentId } = await seedFixture({
      monitor: {
        serviceName: "Deploy provider",
        externalRef: "https://provider.example/deploy/123?token=secret",
      },
    });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    await heartbeat.tickTimers(tickAt);

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(JSON.stringify(wakeup?.payload)).not.toContain("provider.example");
    expect(wakeup?.payload).not.toHaveProperty("externalRef");

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    expect(JSON.stringify(activity.map((row) => row.details))).not.toContain("provider.example");
    expect(activity.find((row) => row.action === "issue.monitor_triggered")?.details).not.toHaveProperty("externalRef");
  });
});
