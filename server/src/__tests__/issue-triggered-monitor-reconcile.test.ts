import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { parseIssueExecutionState } from "../services/issue-execution-policy.js";
import { prepareIssueMonitorUpdate, summarizeIssueMonitor } from "../services/issue-monitors.js";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres triggered monitor tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const NOW = new Date("2026-06-01T12:00:00.000Z");
const LONG_AGO = new Date("2026-06-01T09:00:00.000Z");

function idleState(monitor: Record<string, unknown> | null) {
  return {
    status: "idle",
    currentStageId: null,
    currentStageIndex: null,
    currentStageType: null,
    currentParticipant: null,
    returnAssignee: null,
    reviewRequest: null,
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: null,
    monitor,
  };
}

function triggeredMonitor(input: { attemptCount: number; maxAttempts: number | null; lastTriggeredAt: Date }) {
  return {
    status: "triggered",
    nextCheckAt: null,
    lastTriggeredAt: input.lastTriggeredAt.toISOString(),
    attemptCount: input.attemptCount,
    notes: "Wait for the CI suite",
    scheduledBy: "assignee",
    kind: "external_service",
    serviceName: "ci suite",
    externalRef: null,
    timeoutAt: "2026-06-30T00:00:00.000Z",
    maxAttempts: input.maxAttempts,
    recoveryPolicy: null,
    clearedAt: null,
    clearReason: null,
  };
}

/**
 * A fired monitor stays `triggered` with no nextCheckAt until the run it woke
 * re-arms it. Once nothing can continue the task, the record must stop reading
 * as a wait, without losing cumulative attempts, limits or dispatch history.
 */
describeEmbeddedPostgres("triggered monitor reconciliation", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-triggered-monitor-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueRecoveryActions);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(prefix: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Monitor ${prefix}`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({ id: agentId, companyId, name: `${prefix} Agent`, role: "engineer", status: "idle" });
    return { companyId, agentId };
  }

  async function insertTriggered(input: {
    companyId: string;
    agentId: string;
    identifier: string;
    attemptCount?: number;
    maxAttempts?: number | null;
    lastTriggeredAt?: Date;
  }) {
    const id = randomUUID();
    const lastTriggeredAt = input.lastTriggeredAt ?? LONG_AGO;
    const attemptCount = input.attemptCount ?? 12;
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      identifier: input.identifier,
      title: input.identifier,
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: input.agentId,
      executionPolicy: null,
      executionState: idleState(triggeredMonitor({
        attemptCount,
        maxAttempts: input.maxAttempts === undefined ? 20 : input.maxAttempts,
        lastTriggeredAt,
      })),
      monitorNextCheckAt: null,
      monitorLastTriggeredAt: lastTriggeredAt,
      monitorAttemptCount: attemptCount,
      monitorNotes: "Wait for the CI suite",
      monitorScheduledBy: "assignee",
      updatedAt: lastTriggeredAt,
    });
    return id;
  }

  async function read(issueId: string) {
    const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
    return row!;
  }

  it("settles a triggered monitor with no continuation, keeping attempts, limits and history", async () => {
    const { companyId, agentId } = await seed("TMA");
    const issueId = await insertTriggered({ companyId, agentId, identifier: "TMA-1", attemptCount: 12, maxAttempts: 20 });
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "heartbeat_scheduler",
      action: "issue.monitor_triggered",
      entityType: "issue",
      entityId: issueId,
      details: { attemptCount: 12 },
    });

    const before = summarizeIssueMonitor(await read(issueId), null);
    expect(before).toMatchObject({ status: "triggered", nextCheckAt: null });

    expect(await heartbeat.reconcileTriggeredIssueMonitors(NOW)).toEqual({ checked: 1, cleared: 1 });

    const row = await read(issueId);
    expect(parseIssueExecutionState(row.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "triggered",
      nextCheckAt: null,
      attemptCount: 12,
      maxAttempts: 20,
      timeoutAt: "2026-06-30T00:00:00.000Z",
      lastTriggeredAt: LONG_AGO.toISOString(),
      serviceName: "ci suite",
      notes: "Wait for the CI suite",
    });
    expect(row.monitorAttemptCount).toBe(12);
    expect(row.monitorLastTriggeredAt?.toISOString()).toBe(LONG_AGO.toISOString());
    expect(row.status).toBe("in_progress");
    expect(summarizeIssueMonitor(row, normalizeIssueExecutionPolicy(row.executionPolicy))).toMatchObject({
      status: "cleared",
      nextCheckAt: null,
      attemptCount: 12,
    });

    const activity = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    expect(activity.map((entry) => entry.action).sort()).toEqual(["issue.monitor_cleared", "issue.monitor_triggered"]);
    expect(activity.find((entry) => entry.action === "issue.monitor_cleared")?.details).toMatchObject({
      reason: "triggered",
      attemptCount: 12,
      maxAttempts: 20,
    });

    // Idempotent: a second pass finds nothing to settle.
    expect(await heartbeat.reconcileTriggeredIssueMonitors(NOW)).toEqual({ checked: 0, cleared: 0 });
  });

  it("leaves a triggered monitor alone while its woken run is still live", async () => {
    const { companyId, agentId } = await seed("TMB");
    const runningId = await insertTriggered({ companyId, agentId, identifier: "TMB-1" });
    const queuedRunId = await insertTriggered({ companyId, agentId, identifier: "TMB-2" });
    const queuedWakeId = await insertTriggered({ companyId, agentId, identifier: "TMB-3" });
    await db.insert(heartbeatRuns).values([
      { companyId, agentId, status: "running", contextSnapshot: { issueId: runningId, source: "issue.monitor" } },
      { companyId, agentId, status: "queued", contextSnapshot: { issueId: queuedRunId, source: "issue.monitor" } },
    ]);
    await db.insert(agentWakeupRequests).values({
      companyId, agentId, source: "automation", reason: "issue_monitor_due", status: "queued", payload: { issueId: queuedWakeId },
    });

    expect(await heartbeat.reconcileTriggeredIssueMonitors(NOW)).toEqual({ checked: 0, cleared: 0 });
    for (const issueId of [runningId, queuedRunId, queuedWakeId]) {
      expect(parseIssueExecutionState((await read(issueId)).executionState)?.monitor?.status).toBe("triggered");
    }
  });

  it("waits out the settle window after a fire before treating the record as stale", async () => {
    const { companyId, agentId } = await seed("TMC");
    const issueId = await insertTriggered({
      companyId, agentId, identifier: "TMC-1", lastTriggeredAt: new Date(NOW.getTime() - 60_000),
    });

    expect(await heartbeat.reconcileTriggeredIssueMonitors(NOW)).toEqual({ checked: 0, cleared: 0 });
    expect(parseIssueExecutionState((await read(issueId)).executionState)?.monitor?.status).toBe("triggered");
  });

  it("never touches a healthy scheduled monitor", async () => {
    const { companyId, agentId } = await seed("TMD");
    const nextCheckAt = new Date(NOW.getTime() + 30 * 60_000);
    const id = randomUUID();
    const scheduled = {
      ...triggeredMonitor({ attemptCount: 2, maxAttempts: 5, lastTriggeredAt: LONG_AGO }),
      status: "scheduled",
      nextCheckAt: nextCheckAt.toISOString(),
    };
    await db.insert(issues).values({
      id, companyId, identifier: "TMD-1", title: "TMD-1", status: "in_progress", priority: "medium",
      assigneeAgentId: agentId,
      executionPolicy: { monitor: { nextCheckAt: nextCheckAt.toISOString(), notes: "Wait for the CI suite", scheduledBy: "assignee", maxAttempts: 5 } },
      executionState: idleState(scheduled),
      monitorNextCheckAt: nextCheckAt,
      monitorLastTriggeredAt: LONG_AGO,
      monitorAttemptCount: 2,
      updatedAt: LONG_AGO,
    });

    expect(await heartbeat.reconcileTriggeredIssueMonitors(NOW)).toEqual({ checked: 0, cleared: 0 });
    const row = await read(id);
    expect(parseIssueExecutionState(row.executionState)?.monitor).toMatchObject({ status: "scheduled", attemptCount: 2 });
    expect(row.monitorNextCheckAt?.toISOString()).toBe(nextCheckAt.toISOString());
  });

  it("counts a deferred wake as a continuation only when no recovery hold parks it", async () => {
    const { companyId, agentId } = await seed("TME");
    const freeId = await insertTriggered({ companyId, agentId, identifier: "TME-1" });
    const heldId = await insertTriggered({ companyId, agentId, identifier: "TME-2" });
    for (const issueId of [freeId, heldId]) {
      await db.insert(agentWakeupRequests).values({
        companyId, agentId, source: "automation", reason: "issue_commented", status: "deferred_issue_execution", payload: { issueId },
      });
    }
    await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: heldId,
      kind: "execution_reconciliation",
      status: "resolved",
      ownerType: "board",
      cause: "uncertain_external_action",
      fingerprint: `hold:${heldId}`,
      evidence: { automaticRecovery: { replay: "blocked" } },
      nextAction: "Reconcile the uncertain external action before continuing.",
      resolvedAt: LONG_AGO,
    });

    expect(await heartbeat.reconcileTriggeredIssueMonitors(NOW)).toEqual({ checked: 2, cleared: 1 });
    expect(parseIssueExecutionState((await read(freeId)).executionState)?.monitor?.status).toBe("triggered");
    expect(parseIssueExecutionState((await read(heldId)).executionState)?.monitor?.status).toBe("cleared");
  });

  it("keeps cumulative attempts binding when the owner re-arms a settled one-shot monitor", async () => {
    const { companyId, agentId } = await seed("TMF");
    const issueId = await insertTriggered({ companyId, agentId, identifier: "TMF-1", attemptCount: 1, maxAttempts: 1 });
    await heartbeat.reconcileTriggeredIssueMonitors(NOW);
    const settled = await read(issueId);
    const actor = { type: "agent" as const, agentId, companyId, runId: randomUUID(), source: "agent_jwt" as const };
    const future = new Date(Date.now() + 60 * 60_000).toISOString();

    expect(() => prepareIssueMonitorUpdate(settled, {
      nextCheckAt: future, notes: "Check again", maxAttempts: 1,
    } as never, actor as never)).toThrow(/exhaust|attempt/i);

    const rearmed = prepareIssueMonitorUpdate(settled, {
      nextCheckAt: future, notes: "Check again", maxAttempts: 3,
    } as never, actor as never);
    expect(parseIssueExecutionState(rearmed.executionState)?.monitor).toMatchObject({ status: "scheduled", attemptCount: 1 });
  });

  it("does not reconcile terminal tasks", async () => {
    const { companyId, agentId } = await seed("TMG");
    const issueId = await insertTriggered({ companyId, agentId, identifier: "TMG-1" });
    await db.update(issues).set({ status: "done", updatedAt: LONG_AGO }).where(and(eq(issues.id, issueId)));

    expect(await heartbeat.reconcileTriggeredIssueMonitors(NOW)).toEqual({ checked: 0, cleared: 0 });
  });
});
