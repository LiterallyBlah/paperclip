import { randomUUID } from "node:crypto";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  approvals,
  companies,
  createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRuns,
  issueApprovals,
  issueRecoveryActions,
  issues,
  type Db,
} from "@paperclipai/db";
import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  buildMaintenanceRedispatchKey,
  classifyWindowRun,
  maintenanceRedispatchService,
  TASK_DRAIN_STARTED_ACTION,
  TASK_DRAIN_STOPPED_ACTION,
} from "../services/maintenance-redispatch.js";
import type { WakeupOptions } from "../services/heartbeat/run-preparation.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping maintenance re-dispatch fixtures: ${support.reason}`);

describe("classifyWindowRun", () => {
  it("accepts only recorded maintenance stops", () => {
    expect(classifyWindowRun({ status: "failed", errorCode: "process_lost", resultJson: null }))
      .toEqual({ lost: true, cause: "process_lost" });
    expect(classifyWindowRun({ status: "interrupted", errorCode: "server_shutdown_interrupted", resultJson: null }))
      .toEqual({ lost: true, cause: "shutdown_interrupted" });
    expect(classifyWindowRun({ status: "cancelled", errorCode: "cancelled", resultJson: { cancellation: {
      source: "shutdown", expected: false, initiator: { type: "system" }, reason: "stop", recordedAt: "2026-01-01T00:00:00Z" } } }))
      .toEqual({ lost: true, cause: "cancelled_by_window" });
    expect(classifyWindowRun({ status: "cancelled", errorCode: "cancelled", resultJson: { cancellation: {
      source: "operator", expected: true, initiator: { type: "user", id: "u" }, reason: "stop", recordedAt: "2026-01-01T00:00:00Z" } } }))
      .toEqual({ lost: false, reason: "human_stop" });
    expect(classifyWindowRun({ status: "cancelled", errorCode: "issue_cancelled", resultJson: null }).lost).toBe(false);
    expect(classifyWindowRun({ status: "cancelled", errorCode: "cancelled", resultJson: null }))
      .toEqual({ lost: false, reason: "no_window_cancellation_evidence" });
    expect(classifyWindowRun({ status: "failed", errorCode: "adapter_failed", resultJson: null }).lost).toBe(false);
  });
});

describePostgres("maintenance-exit re-dispatch", () => {
  let db: Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let companyId: string;
  let worker: string;
  let reviewer: string;
  let wakeCalls: Array<{ agentId: string; opts: WakeupOptions }>;
  // Each test gets its own later, non-overlapping maintenance window.
  let windowIndex = 0;
  let t0: Date, inWindow: Date, stopAt: Date, afterWindow: Date;
  let operationId: string;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-maintenance-redispatch-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await database?.cleanup(); });

  /** Inserts the wake row exactly as admission would, so the DB fence is exercised. */
  const fakeWakeup = async (agentId: string, opts: WakeupOptions) => {
    wakeCalls.push({ agentId, opts });
    const [row] = await db.insert(agentWakeupRequests).values({
      companyId, agentId, source: opts.source ?? "automation", triggerDetail: opts.triggerDetail ?? null,
      reason: opts.reason ?? null, payload: opts.payload ?? null, status: "queued",
      idempotencyKey: opts.idempotencyKey ?? null, requestedByActorType: opts.requestedByActorType ?? null,
      requestedByActorId: opts.requestedByActorId ?? null,
    }).returning();
    return row;
  };
  const service = () => maintenanceRedispatchService(db, { wakeup: fakeWakeup });

  async function addDrain(opts: { stopped: boolean }) {
    operationId = randomUUID();
    await db.insert(activityLog).values({ companyId, actorType: "user", actorId: "board", action: TASK_DRAIN_STARTED_ACTION,
      entityType: "instance_settings", entityId: "default", createdAt: t0,
      details: { startedAt: t0.toISOString(), expiresAt: null, operationId } });
    if (opts.stopped) {
      await db.insert(activityLog).values({ companyId, actorType: "user", actorId: "board", action: TASK_DRAIN_STOPPED_ACTION,
        entityType: "instance_settings", entityId: "default", createdAt: stopAt, details: { wasActive: true, operationId } });
    }
  }

  let issueCounter = 0;
  async function addIssue(over: Partial<typeof issues.$inferInsert> = {}) {
    const id = randomUUID();
    issueCounter += 1;
    await db.insert(issues).values({ id, companyId, title: `Fixture ${issueCounter}`, status: "in_progress",
      assigneeAgentId: worker, identifier: `MRD-${issueCounter}`, ...over });
    return id;
  }
  async function addRun(issueId: string, over: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({ id, companyId, agentId: worker, issueId, status: "failed",
      errorCode: "process_lost", runtimeMode: "legacy", invocationSource: "automation",
      contextSnapshot: { issueId }, startedAt: t0, finishedAt: inWindow, createdAt: t0, ...over });
    return id;
  }

  function reviewState(stageId: string) {
    return {
      status: "pending", currentStageId: stageId, currentStageIndex: 0, currentStageType: "review",
      currentParticipant: { type: "agent", agentId: reviewer, userId: null },
      returnAssignee: { type: "agent", agentId: worker, userId: null },
      reviewRequest: null, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
      monitor: null, changesRequestedCount: 0,
    };
  }

  beforeEach(async () => {
    companyId = randomUUID(); worker = randomUUID(); reviewer = randomUUID();
    wakeCalls = [];
    windowIndex += 1;
    t0 = new Date(Date.now() - (20 - windowIndex * 2) * 60 * 60_000);
    inWindow = new Date(t0.getTime() + 5 * 60_000);
    stopAt = new Date(t0.getTime() + 20 * 60_000);
    afterWindow = new Date(t0.getTime() + 40 * 60_000);
    // Each test gets its own company and its own drain; earlier drains are older.
    await db.delete(activityLog).where(like(activityLog.action, "instance.task_drain.%"));
    await db.insert(companies).values({ id: companyId, name: "Fixture", issuePrefix: `M${Math.random().toString(36).slice(2, 7).toUpperCase()}` });
    await db.insert(agents).values([
      { id: worker, companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "process" },
      { id: reviewer, companyId, name: "Reviewer", role: "engineer", status: "idle", adapterType: "process" },
    ]);
  });

  it("dispatches once for cancelled-by-window and process_lost-by-window runs, and never twice", async () => {
    await addDrain({ stopped: true });
    const lost = await addIssue();
    await addRun(lost);
    const cancelled = await addIssue();
    await addRun(cancelled, { status: "cancelled", errorCode: "cancelled", resultJson: { cancellation: {
      source: "shutdown", expected: false, initiator: { type: "system" }, reason: "maintenance", recordedAt: inWindow.toISOString() } } });

    const dry = await service().run({ operationId });
    expect(dry?.dryRun).toBe(true);
    expect(dry?.counts.would_dispatch).toBe(2);
    expect(wakeCalls).toHaveLength(0);

    const first = await service().run({ operationId, apply: true });
    expect(first?.counts).toMatchObject({ dispatched: 2, skipped: 0 });
    expect(wakeCalls.map((c) => c.agentId)).toEqual([worker, worker]);
    expect(wakeCalls[0]!.opts.idempotencyKey).toMatch(/^maintenance_redispatch:/);
    expect(wakeCalls[0]!.opts.issueStateGuard).toEqual({ statuses: ["in_progress"], assigneeAgentId: worker });
    for (const entry of first!.entries) expect(entry.wakeId).toBeTruthy();

    // Repeated exit (and a crash-restart re-run) finds the stored wake and does nothing.
    const again = await service().run({ operationId, apply: true });
    expect(again?.counts).toMatchObject({ dispatched: 0, already_dispatched: 2 });
    expect(wakeCalls).toHaveLength(2);
    const keyed = await db.select().from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), like(agentWakeupRequests.idempotencyKey, "maintenance_redispatch:%")));
    expect(keyed).toHaveLength(2);

    // The database fence holds even if a caller skipped the pre-check.
    await expect(fakeWakeup(worker, { idempotencyKey: buildMaintenanceRedispatchKey(operationId, lost) }))
      .rejects.toMatchObject({ cause: expect.objectContaining({ code: "23505" }) });
  });

  it("wakes a pending review participant whose stage wake the window ended", async () => {
    await addDrain({ stopped: true });
    const stageId = randomUUID();
    const issueId = await addIssue({ status: "in_review", executionState: reviewState(stageId) });
    await db.insert(agentWakeupRequests).values({ companyId, agentId: reviewer, source: "assignment",
      reason: "execution_review_requested", status: "skipped", requestedAt: inWindow, updatedAt: inWindow,
      payload: { issueId, executionStage: { stageId } }, error: "execution_reconciliation_required" });

    const result = await service().run({ operationId, apply: true });
    expect(result?.entries).toEqual([expect.objectContaining({ issueId, kind: "review_participant", decision: "dispatched", agentId: reviewer })]);
    expect(wakeCalls).toHaveLength(1);
    expect(wakeCalls[0]!.agentId).toBe(reviewer);
    expect(wakeCalls[0]!.opts.reason).toBe("execution_review_requested");
    expect((wakeCalls[0]!.opts.payload as { executionStage: { stageId: string } }).executionStage.stageId).toBe(stageId);
    expect((await service().run({ operationId, apply: true }))?.counts.already_dispatched).toBe(1);
    expect(wakeCalls).toHaveLength(1);
  });

  it("wakes a review participant whose deferred wake the window held", async () => {
    await addDrain({ stopped: true });
    const stageId = randomUUID();
    const issueId = await addIssue({ status: "in_review", executionState: reviewState(stageId) });
    await db.insert(agentWakeupRequests).values({ companyId, agentId: reviewer, source: "assignment",
      reason: "execution_review_requested", status: "deferred_issue_execution", requestedAt: inWindow, updatedAt: inWindow,
      payload: { issueId, executionStage: { stageId } } });
    const result = await service().run({ operationId, apply: true });
    expect(result?.entries).toEqual([expect.objectContaining({ issueId, decision: "dispatched" })]);
  });

  it("skips intentional stops: human cancel, agent cancel, issue cancel, reassignment and terminal status", async () => {
    await addDrain({ stopped: true });
    const human = await addIssue();
    await addRun(human, { status: "cancelled", errorCode: "cancelled", resultJson: { cancellation: {
      source: "operator", expected: true, initiator: { type: "user", id: "board" }, reason: "stop", recordedAt: inWindow.toISOString() } } });
    const agentStop = await addIssue();
    await addRun(agentStop, { status: "cancelled", errorCode: "cancelled", resultJson: { cancellation: {
      source: "control_plane", expected: true, initiator: { type: "agent", id: worker }, reason: "pause", recordedAt: inWindow.toISOString() } } });
    const issueCancelled = await addIssue();
    await addRun(issueCancelled, { status: "cancelled", errorCode: "issue_cancelled" });
    const reassigned = await addIssue({ assigneeAgentId: reviewer });
    await addRun(reassigned);
    const done = await addIssue({ status: "done" });
    await addRun(done);

    const result = await service().run({ operationId, apply: true });
    const reasons = Object.fromEntries(result!.entries.map((e) => [e.issueId, e.skipReason]));
    expect(reasons).toEqual({
      [human]: "human_stop",
      [agentStop]: "intentional_stop:agent",
      [issueCancelled]: "intentional_stop:issue_cancelled",
      [reassigned]: "owner_changed_since_run",
      [done]: "issue_status:done",
    });
    expect(result!.counts.skipped).toBe(5);
    expect(wakeCalls).toHaveLength(0);
  });

  it("leaves healthy waits alone: live run, queued continuation, later run and runs outside the window", async () => {
    await addDrain({ stopped: true });
    const live = await addIssue();
    await addRun(live);
    await addRun(live, { status: "running", errorCode: null, finishedAt: null, createdAt: t0 });
    const queued = await addIssue();
    await addRun(queued);
    await db.insert(agentWakeupRequests).values({ companyId, agentId: worker, source: "automation", status: "queued",
      payload: { issueId: queued } });
    const retried = await addIssue();
    await addRun(retried, { createdAt: t0 });
    await addRun(retried, { status: "succeeded", errorCode: null, createdAt: stopAt, finishedAt: afterWindow });
    const outside = await addIssue();
    await addRun(outside, { finishedAt: afterWindow });

    const result = await service().run({ operationId, apply: true });
    const reasons = Object.fromEntries(result!.entries.map((e) => [e.issueId, e.skipReason]));
    expect(reasons[live]).toBe("live_run_or_scheduled_retry");
    expect(reasons[queued]).toBe("queued_continuation");
    expect(reasons[retried]).toBe("superseded_by_later_run");
    expect(reasons[outside]).toBeUndefined();
    expect(wakeCalls).toHaveLength(0);
  });

  it("skips and lists gated tasks: agent pause, pending approval and an active no-replay hold", async () => {
    await addDrain({ stopped: true });
    const pausedAgent = randomUUID();
    await db.insert(agents).values({ id: pausedAgent, companyId, name: "Paused", role: "engineer", status: "paused",
      adapterType: "process", pausedAt: inWindow, pauseReason: "manual" });
    const paused = await addIssue({ assigneeAgentId: pausedAgent });
    await addRun(paused, { agentId: pausedAgent });
    const approval = await addIssue();
    await addRun(approval);
    const approvalId = randomUUID();
    await db.insert(approvals).values({ id: approvalId, companyId, type: "approve_ceo_strategy", status: "pending", payload: {} });
    await db.insert(issueApprovals).values({ companyId, issueId: approval, approvalId });
    const held = await addIssue();
    const heldRun = await addRun(held);
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: held, kind: "reconciliation",
      cause: "uncertain_provider_action", status: "active", ownerType: "agent", ownerAgentId: worker,
      fingerprint: `fixture:${held}`, nextAction: "reconcile", evidence: { runId: heldRun } });

    const result = await service().run({ operationId, apply: true });
    const reasons = Object.fromEntries(result!.entries.map((e) => [e.issueId, e.skipReason]));
    expect(reasons[paused]).toBe("agent_paused");
    expect(reasons[approval]).toBe("pending_approval");
    expect(reasons[held]).toBe("no_replay_hold");
    expect(wakeCalls).toHaveLength(0);
  });

  it("refuses to apply while the drain is still active, and closes a drain a restart ended at boot", async () => {
    await addDrain({ stopped: false });
    const lost = await addIssue();
    await addRun(lost);
    await expect(service().run({ operationId, activeOperationId: operationId, apply: true }))
      .rejects.toThrow(/still active/);
    const preview = await service().run({ operationId, activeOperationId: operationId });
    expect(preview?.operation.endedAt).toBeNull();
    expect(preview?.counts.would_dispatch).toBe(1);

    const boot = await service().closeDrainEndedByRestart([companyId]);
    expect(boot.marked).toBe(true);
    expect(boot.operation?.endedBy).toBe("restart");
    expect(boot.manifest?.counts.dispatched).toBe(1);
    const second = await service().closeDrainEndedByRestart([companyId]);
    expect(second.marked).toBe(false);
    expect(wakeCalls).toHaveLength(1);
  });
});
