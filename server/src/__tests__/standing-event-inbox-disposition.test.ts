import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { recoveryService } from "../services/recovery/service.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { LEGACY_DISPOSITION_SUPPRESSION_KEY } from "../services/legacy-execution-recovery.js";

const INBOX_POLICY = { mode: "normal", commentRequired: true, stages: [], standingEventInbox: true };

describe("standing event inbox disposition", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("standing-inbox-"); db = createDb(temporary.connectionString); }, 20_000);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await temporary?.cleanup(); });

  async function fixture(input: { marked: boolean; status?: "todo" | "in_progress" }) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Inbox fixture", issuePrefix: `S${companyId.slice(0, 6)}`, defaultResponsibleUserId: "fixture-owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Inbox owner", role: "engineer", status: "idle", adapterType: "codex_local", runtimeConfig: { heartbeat: { wakeOnDemand: true } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Synthetic standing inbox", description: "Synthetic fixture.", status: input.status ?? "in_progress", assigneeAgentId: agentId, responsibleUserId: "fixture-owner", executionPolicy: input.marked ? INBOX_POLICY : null });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", status: "succeeded", runtimeMode: "legacy", contextSnapshot: { issueId, wakeReason: "issue_commented" }, livenessState: "advanced", resultJson: { summary: "Handled the delivered notice. Waiting for the next one." } });
    const recovery = () => recoveryService(db, {
      enqueueWakeup: async (targetAgentId, opts) => db.transaction(async tx => {
        const [wake] = await tx.insert(agentWakeupRequests).values({ companyId, agentId: targetAgentId, source: "automation", reason: opts?.reason, payload: opts?.payload, idempotencyKey: opts?.idempotencyKey, status: "queued" }).returning();
        const [run] = await tx.insert(heartbeatRuns).values({ companyId, agentId: targetAgentId, invocationSource: "automation", status: "queued", runtimeMode: "legacy", wakeupRequestId: wake.id, contextSnapshot: opts?.contextSnapshot }).returning();
        await tx.update(agentWakeupRequests).set({ runId: run.id }).where(eq(agentWakeupRequests.id, wake.id));
        return run;
      }),
    });
    const runs = () => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    const wakes = () => db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    const actions = () => db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, companyId));
    const issue = async () => (await db.select().from(issues).where(eq(issues.id, issueId)))[0]!;
    const mark = () => db.update(issues).set({ executionPolicy: INBOX_POLICY }).where(eq(issues.id, issueId));
    async function finish(run: typeof heartbeatRuns.$inferSelect) {
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
      if (run.wakeupRequestId) await db.update(agentWakeupRequests).set({ status: "completed" }).where(eq(agentWakeupRequests.id, run.wakeupRequestId));
    }
    async function quietRun(context: Record<string, unknown> = {}) {
      const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "on_demand", status: "succeeded", runtimeMode: "legacy", contextSnapshot: { issueId, wakeReason: "issue_commented", ...context }, livenessState: "advanced", finishedAt: new Date() }).returning();
      return run;
    }
    /** Drives the unmarked base loop to exhaustion: two repair attempts, then board escalation. */
    async function exhaust() {
      expect(await recovery().reconcileLegacyContinuation(runId)).toBe("queued");
      const first = (await runs()).find(r => r.id !== runId)!;
      await finish(first);
      expect(await recovery().reconcileLegacyContinuation(first.id)).toBe("queued");
      const second = (await runs()).find(r => r.status === "scheduled_retry")!;
      await finish(second);
      expect(await recovery().reconcileLegacyContinuation(second.id)).toBe("escalated");
      return { first, second };
    }
    return { companyId, agentId, issueId, runId, recovery, runs, wakes, actions, issue, mark, finish, quietRun, exhaust };
  }

  it("repro (unmarked, base behaviour): quiet success opens a repair, exhaustion escalates, the next quiet success opens a fresh repair", async () => {
    const f = await fixture({ marked: false });
    await f.exhaust();
    expect((await f.issue()).status).toBe("blocked");
    const escalated = (await f.actions()).find(a => a.status === "escalated" || a.status === "active")!;
    expect(escalated).toMatchObject({ kind: "deliberate_wait_without_target", ownerType: "board", attemptCount: 2 });
    // The exhausted escalation is settled and the inbox goes back to
    // in_progress; the next delivered notice produces another quiet run.
    await db.update(issueRecoveryActions).set({ status: "resolved", outcome: "restored", resolvedAt: new Date() }).where(eq(issueRecoveryActions.id, escalated.id));
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, f.issueId));
    const next = await f.quietRun();
    const runsBefore = (await f.runs()).length;
    expect(await f.recovery().reconcileLegacyContinuation(next.id)).toBe("queued");
    const active = (await f.actions()).filter(a => a.status === "active");
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ kind: "deliberate_wait_without_target", ownerType: "agent", attemptCount: 1 });
    expect(active[0].id).not.toBe(escalated.id);
    expect((await f.runs()).length).toBe(runsBefore + 1);
  });

  it.each(["in_progress", "todo"] as const)("marked %s inbox: a quiet successful run opens no action, wakes nobody and keeps status", async status => {
    const f = await fixture({ marked: true, status });
    const before = await f.issue();
    expect(await f.recovery().reconcileLegacyContinuation(f.runId)).toBe("covered");
    await f.recovery().reconcileStrandedAssignedIssues();
    expect(await f.actions()).toHaveLength(0);
    expect(await f.wakes()).toHaveLength(0);
    expect(await f.runs()).toHaveLength(1);
    const after = await f.issue();
    expect(after).toMatchObject({ status, assigneeAgentId: before.assigneeAgentId, assigneeUserId: null, description: before.description, parentId: before.parentId });
  });

  it("marked inbox: repeated quiet successes never regenerate a repair", async () => {
    const f = await fixture({ marked: true });
    for (let i = 0; i < 4; i += 1) {
      const run = i === 0 ? { id: f.runId } : await f.quietRun();
      expect(await f.recovery().reconcileLegacyContinuation(run.id)).toBe("covered");
      await f.recovery().reconcileStrandedAssignedIssues();
    }
    expect(await f.actions()).toHaveLength(0);
    expect(await f.wakes()).toHaveLength(0);
    expect((await f.issue()).status).toBe("in_progress");
  });

  it("stale loop: an open agent-owned repair settles on marking, its queued retry is suppressed and nothing regenerates", async () => {
    const f = await fixture({ marked: false });
    expect(await f.recovery().reconcileLegacyContinuation(f.runId)).toBe("queued");
    const first = (await f.runs()).find(r => r.id !== f.runId)!;
    expect((await f.actions())[0]).toMatchObject({ status: "active", ownerType: "agent", attemptCount: 1 });
    await f.mark();
    // The already-queued repair retry is refused at dispatch.
    expect(await f.recovery().legacyRepairDispatchBlock(first.id)).toBe("durable_wait");
    // Recovery-action sweep settles it without a board step.
    // Mirror the dispatcher's suppression write for a never-started legacy repair.
    const controllerBootId = randomUUID();
    await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "legacy_disposition_repair_suppressed", error: "Disposition repair suppressed: durable_wait", finishedAt: new Date(), controllerBootId, executionStage: "dispatching", processPid: null, processGroupId: null,
      runnerProfileJson: { [LEGACY_DISPOSITION_SUPPRESSION_KEY]: { version: 1, runId: first.id, controllerBootId, providerDispatchStarted: false, reason: "durable_wait" } } }).where(eq(heartbeatRuns.id, first.id));
    if (first.wakeupRequestId) await db.update(agentWakeupRequests).set({ status: "skipped", finishedAt: new Date() }).where(eq(agentWakeupRequests.id, first.wakeupRequestId));
    await f.recovery().reconcileStrandedAssignedIssues();
    expect((await f.actions())[0]).toMatchObject({ status: "resolved", outcome: "restored", resolutionNote: "durable_path_restored:standing_event_inbox" });
    const runCount = (await f.runs()).length;
    await f.recovery().reconcileStrandedAssignedIssues();
    expect(await f.recovery().reconcileLegacyContinuation((await f.quietRun()).id)).toBe("covered");
    expect((await f.actions()).filter(a => a.status === "active" || a.status === "escalated")).toHaveLength(0);
    expect((await f.runs()).length).toBe(runCount + 1);
    expect((await f.issue()).status).toBe("in_progress");
  });

  it("stale loop: a later successful notice-handling run settles an open repair", async () => {
    const f = await fixture({ marked: false });
    await f.recovery().reconcileLegacyContinuation(f.runId);
    const first = (await f.runs()).find(r => r.id !== f.runId)!;
    await f.mark();
    await f.finish(first);
    const runCount = (await f.runs()).length;
    expect(await f.recovery().reconcileLegacyContinuation(first.id)).toBe("covered");
    expect((await f.actions())[0]).toMatchObject({ status: "resolved", outcome: "restored" });
    expect((await f.runs()).length).toBe(runCount);
    expect((await f.issue()).status).toBe("in_progress");
  });

  it("stale loop: an exhausted board-owned repair settles once the owner reopens the marked inbox, with no fresh action", async () => {
    const f = await fixture({ marked: false });
    await f.exhaust();
    await f.mark();
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, f.issueId));
    await f.recovery().reconcileStrandedAssignedIssues();
    expect((await f.actions()).filter(a => a.status === "active" || a.status === "escalated")).toHaveLength(0);
    const runCount = (await f.runs()).length;
    expect(await f.recovery().reconcileLegacyContinuation((await f.quietRun()).id)).toBe("covered");
    await f.recovery().reconcileStrandedAssignedIssues();
    expect((await f.actions()).filter(a => a.status === "active" || a.status === "escalated")).toHaveLength(0);
    expect((await f.runs()).length).toBe(runCount + 1);
    expect((await f.issue()).status).toBe("in_progress");
  });

  it("stale loop: the next quiet run alone settles an exhausted repair on a reopened marked inbox", async () => {
    const f = await fixture({ marked: false });
    await f.exhaust();
    await f.mark();
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, f.issueId));
    expect(await f.recovery().reconcileLegacyContinuation((await f.quietRun()).id)).toBe("covered");
    expect((await f.actions()).filter(a => a.status === "active" || a.status === "escalated")).toHaveLength(0);
  });

  it("marked inbox: a parked continuation cancellation is a quiet wait in the stranded sweep", async () => {
    const f = await fixture({ marked: true });
    await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "issue_continuation_waiting_on_review", resultJson: { stopReason: "issue_continuation_waiting_on_review", timeoutSource: "stale_queued_run_gate" }, contextSnapshot: { issueId: f.issueId, wakeReason: "issue_continuation_needed" } }).where(eq(heartbeatRuns.id, f.runId));
    await f.recovery().reconcileStrandedAssignedIssues();
    expect(await f.actions()).toHaveLength(0);
    expect(await f.wakes()).toHaveLength(0);
    expect((await f.issue()).status).toBe("in_progress");
  });

  it("regression: an unmarked parked continuation cancellation still opens a disposition repair", async () => {
    const f = await fixture({ marked: false });
    await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "issue_continuation_waiting_on_review", resultJson: { stopReason: "issue_continuation_waiting_on_review", timeoutSource: "stale_queued_run_gate" }, contextSnapshot: { issueId: f.issueId, wakeReason: "issue_continuation_needed" } }).where(eq(heartbeatRuns.id, f.runId));
    await f.recovery().reconcileStrandedAssignedIssues();
    expect((await f.actions()).find(a => a.status === "active")).toMatchObject({ kind: "deliberate_wait_without_target", ownerType: "agent" });
  });

  it.each(["failed", "timed_out"] as const)("regression: a %s run on a marked inbox still recovers normally", async status => {
    const marked = await fixture({ marked: true });
    const unmarked = await fixture({ marked: false });
    for (const f of [marked, unmarked]) {
      await db.update(heartbeatRuns).set({ status, errorCode: status === "failed" ? "adapter_failed" : "timeout", error: "synthetic failure", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    }
    await marked.recovery().reconcileStrandedAssignedIssues();
    const outcome = async (f: typeof marked) => ({
      wakes: (await f.wakes()).map(w => w.reason).sort(),
      actions: (await f.actions()).map(a => `${a.kind}:${a.status}`).sort(),
      status: (await f.issue()).status,
    });
    // The marker does not hide a failed run: both issues get identical recovery.
    const markedOutcome = await outcome(marked);
    expect(markedOutcome).toEqual(await outcome(unmarked));
    expect(markedOutcome.wakes.length + markedOutcome.actions.length + (markedOutcome.status === "in_progress" ? 0 : 1)).toBeGreaterThan(0);
  });
});
