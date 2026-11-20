import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issueComments, issueRecoveryActions, issues } from "@paperclipai/db";
import { recoveryService } from "../services/recovery/service.js";
import { settleUnrecoverableExecutions } from "../services/execution-recovery-resolution.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const INBOX_POLICY = { mode: "normal", commentRequired: true, stages: [], standingEventInbox: true };

/**
 * A scheduled run that the dispatch gate cancelled before it was ever claimed
 * (`startedAt` null) executed nothing, so it has no unverified work to protect.
 */
describe("cancelled, never-started run: no legacy-execution hold", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("never-started-hold-"); db = createDb(temporary.connectionString); }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await temporary?.cleanup(); });

  async function fixture(input: {
    marked: boolean;
    status?: "todo" | "in_progress";
    errorCode?: string;
    started?: boolean;
  }) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), priorRunId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Hold fixture", issuePrefix: `H${companyId.slice(0, 6)}`, defaultResponsibleUserId: "fixture-owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Inbox owner", role: "engineer", status: "idle", adapterType: "codex_local", runtimeConfig: { heartbeat: { wakeOnDemand: true } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Synthetic issue", description: "Synthetic fixture.", status: input.status ?? "in_progress", assigneeAgentId: agentId, responsibleUserId: "fixture-owner", executionPolicy: input.marked ? INBOX_POLICY : null });
    const t0 = new Date(Date.now() - 120_000);
    // An earlier quiet run handled a delivered notice.
    await db.insert(heartbeatRuns).values({ id: priorRunId, companyId, agentId, invocationSource: "on_demand", status: "succeeded", runtimeMode: "legacy", contextSnapshot: { issueId, wakeReason: "issue_commented" }, livenessState: "advanced", startedAt: t0, finishedAt: t0, createdAt: t0 });
    // The scheduled disposition-repair retry, cancelled by the scheduled-retry
    // gate exactly as `cancelSuppressedRetryInTx` writes it.
    const t1 = new Date(Date.now() - 60_000);
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, invocationSource: "automation", runtimeMode: "legacy",
      status: "cancelled", errorCode: input.errorCode ?? "issue_disposition_repair_superseded",
      error: "Scheduled disposition repair suppressed because the source state changed or gained a durable path",
      scheduledRetryAttempt: 2, scheduledRetryReason: "issue_disposition_repair", scheduledRetryAt: t1, retryOfRunId: priorRunId,
      startedAt: input.started ? t1 : null, finishedAt: t1, createdAt: t1,
      contextSnapshot: { issueId, wakeReason: "issue_continuation_needed", retryReason: "issue_disposition_repair", dispositionRepairAttempt: 2 },
    });
    const recovery = () => recoveryService(db, {
      enqueueWakeup: async (targetAgentId, opts) => db.transaction(async tx => {
        const [wake] = await tx.insert(agentWakeupRequests).values({ companyId, agentId: targetAgentId, source: "automation", reason: opts?.reason, payload: opts?.payload, idempotencyKey: opts?.idempotencyKey, status: "queued" }).returning();
        const [run] = await tx.insert(heartbeatRuns).values({ companyId, agentId: targetAgentId, invocationSource: "automation", status: "queued", runtimeMode: "legacy", wakeupRequestId: wake.id, contextSnapshot: opts?.contextSnapshot }).returning();
        await tx.update(agentWakeupRequests).set({ runId: run.id }).where(eq(agentWakeupRequests.id, wake.id));
        return run;
      }),
    });
    const wakes = () => db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    const runs = () => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    const holds = async () => (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, companyId)))
      .filter(a => a.cause === "legacy_execution_requires_reconciliation");
    const issue = async () => (await db.select().from(issues).where(eq(issues.id, issueId)))[0]!;
    /** One stranded sweep followed by the automatic no-replay settler. */
    async function sweep() {
      await recovery().reconcileStrandedAssignedIssues();
      await settleUnrecoverableExecutions(db);
    }
    return { companyId, agentId, issueId, runId, recovery, wakes, runs, holds, issue, sweep };
  }

  it.each(["in_progress", "todo"] as const)("marked %s inbox: a superseded repair retry that never started opens no hold, keeps status and wakes nobody", async status => {
    const f = await fixture({ marked: true, status });
    const before = await f.issue();
    for (let i = 0; i < 3; i += 1) await f.sweep();
    expect(await f.holds()).toHaveLength(0);
    expect((await f.wakes()).map(w => ({ reason: w.reason, payload: w.payload }))).toEqual([]);
    expect(await f.runs()).toHaveLength(2);
    expect(await f.issue()).toMatchObject({ status, assigneeAgentId: before.assigneeAgentId, executionRunId: null, checkoutRunId: null });
  });

  it.each(["issue_reassigned", "issue_paused", "budget_blocked", "issue_execution_lock_changed"])(
    "marked inbox: a never-started cancellation with sibling gate code %s opens no hold",
    async errorCode => {
      const f = await fixture({ marked: true, errorCode });
      await f.sweep();
      expect(await f.holds()).toHaveLength(0);
      expect((await f.issue()).status).toBe("in_progress");
    },
  );

  it("unmarked issue: the general rule also opens no hold and leaves status unchanged", async () => {
    const f = await fixture({ marked: false });
    await f.sweep();
    expect(await f.holds()).toHaveLength(0);
    expect((await f.issue()).status).toBe("in_progress");
    // Unmarked issues keep ordinary bounded disposition repair (agent-owned,
    // attempt 1), not a board-owned no-replay hold.
    const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId));
    expect(actions.map(a => ({ kind: a.kind, ownerType: a.ownerType, status: a.status, attemptCount: a.attemptCount })))
      .toEqual([{ kind: "deliberate_wait_without_target", ownerType: "agent", status: "active", attemptCount: 1 }]);
    expect((await f.wakes()).map(w => w.reason)).toEqual(["issue_disposition_repair"]);
  });

  it("regression: a repair run that started and was then cancelled still gets the no-replay hold and block", async () => {
    for (const marked of [true, false]) {
      const f = await fixture({ marked, started: true });
      await f.sweep();
      const holds = await f.holds();
      expect(holds).toHaveLength(1);
      expect(holds[0]).toMatchObject({ kind: "active_run_watchdog", ownerType: "board", fingerprint: `legacy-execution:${f.runId}`, status: "resolved", outcome: "blocked" });
      expect((holds[0].evidence as Record<string, any>).automaticRecovery).toMatchObject({ policy: "preserve_without_replay_v1", replay: "blocked" });
      expect((await f.issue()).status).toBe("blocked");
    }
  });

  it("regression: a never-started cancelled run with a recorded agent effect keeps the hold", async () => {
    const f = await fixture({ marked: true });
    await db.insert(activityLog).values({ companyId: f.companyId, actorType: "agent", actorId: f.agentId, agentId: f.agentId, runId: f.runId, action: "issue.updated", entityType: "issue", entityId: f.issueId, details: {} });
    await f.sweep();
    expect(await f.holds()).toHaveLength(1);
    expect((await f.issue()).status).toBe("blocked");
  });

  it("regression: a never-started cancelled run with a comment it wrote keeps the hold", async () => {
    const f = await fixture({ marked: false });
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorAgentId: f.agentId, createdByRunId: f.runId, body: "Synthetic comment." });
    await f.sweep();
    expect(await f.holds()).toHaveLength(1);
  });

  it("an existing no-replay hold on a never-started gate cancellation no longer blocks admission; a started run's hold still does", async () => {
    for (const started of [false, true]) {
      const f = await fixture({ marked: true, started });
      // The resolved, blocked hold the base release recorded before the fix.
      await db.insert(issueRecoveryActions).values({
        companyId: f.companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog", ownerType: "board",
        returnOwnerAgentId: f.agentId, cause: "legacy_execution_requires_reconciliation", fingerprint: `legacy-execution:${f.runId}`,
        status: "resolved", outcome: "blocked", attemptCount: 1, resolvedAt: new Date(), nextAction: "Synthetic hold.",
        evidence: { runId: f.runId, originalFailureCode: "issue_disposition_repair_superseded",
          automaticRecovery: { policy: "preserve_without_replay_v1", runId: f.runId, replay: "blocked", actionOutcome: "unknown" } },
      });
      const blocker = await getExecutionBlocker(db, f.companyId, f.issueId, { admittingAgentId: f.agentId });
      if (started) expect(blocker).not.toBeNull();
      else expect(blocker).toBeNull();
    }
  });
});
