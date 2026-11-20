import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  issueWatchdogs,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { taskWatchdogService } from "../services/task-watchdogs.ts";

// BLA-145 / BLA-146: false "stopped subtree" watchdog reviews during native
// hand-offs. Production evidence (BLA-118, watchdog b00dbcab, 2026-11-10):
// 13 of 21 triggers were dispatched by the issue-route mutation hook
// (queueTaskWatchdogEvaluation, carrying the hand-off actor's run id) within
// ~70-200 ms of the hand-off's issue transition, after the outgoing run had
// been cancelled as `issue_reassigned` and before the successor assignment
// wake (enqueued fire-and-forget by the same route) was visible. 11 of those
// 13 found a healthy queued/running successor. The tests below reproduce that
// snapshot exactly: transition committed, outgoing run terminal, successor
// wake not yet visible, evaluation through the hook entry point.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres task watchdog hand-off tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const HOUR_MS = 60 * 60 * 1000;
// Longer than the hand-off settle window, shorter than one hour.
const PAST_SETTLE_WINDOW_MS = 16_000;

describeEmbeddedPostgres("task watchdog native hand-off settle", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-task-watchdogs-handoff-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.useRealTimers();
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueWatchdogs);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Hand-off Co",
      issuePrefix: `HO${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      issueCounter: 0,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name: string) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return id;
  }

  async function seedIssue(companyId: string, overrides: Partial<typeof issues.$inferInsert> = {}) {
    const id = overrides.id ?? randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: overrides.title ?? "Watched issue",
      status: overrides.status ?? "in_progress",
      priority: "medium",
      identifier: overrides.identifier ?? `HO-${Math.floor(Math.random() * 100_000)}`,
      issueNumber: overrides.issueNumber ?? Math.floor(Math.random() * 100_000),
      parentId: overrides.parentId,
      assigneeAgentId: overrides.assigneeAgentId,
      createdAt: overrides.createdAt ?? new Date(Date.now() - HOUR_MS),
      updatedAt: overrides.updatedAt ?? new Date(Date.now() - HOUR_MS),
    });
    return id;
  }

  async function seedWatchdog(companyId: string, issueId: string, agentId: string) {
    const [row] = await db.insert(issueWatchdogs).values({
      companyId,
      issueId,
      watchdogAgentId: agentId,
      instructions: "Verify stopped work.",
      status: "active",
    }).returning();
    return row!;
  }

  async function seedRun(companyId: string, agentId: string, issueId: string, status: string, extra: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    const [run] = await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status,
      invocationSource: "assignment",
      contextSnapshot: { issueId, taskId: issueId },
      ...(status === "running" || status === "queued" ? {} : { finishedAt: new Date() }),
      ...extra,
    }).returning();
    return run!;
  }

  async function seedWake(companyId: string, agentId: string, issueId: string, status: string) {
    const [wake] = await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      status,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId, taskId: issueId, mutation: "update" },
      ...(status === "queued" || status === "deferred_issue_execution" ? {} : { finishedAt: new Date() }),
    }).returning();
    return wake!;
  }

  /**
   * Commits a native hand-off the way the issue PATCH route does before its
   * watchdog hook: the outgoing run is already terminal (`issue_reassigned`),
   * the issue row carries the new status/assignee and a fresh updatedAt, and
   * the successor wake is not yet visible.
   */
  async function commitHandOff(input: {
    companyId: string;
    issueId: string;
    outgoingRunId: string | null;
    status: string;
    assigneeAgentId: string;
  }) {
    if (input.outgoingRunId) {
      await db.update(heartbeatRuns).set({
        status: "cancelled",
        errorCode: "issue_reassigned",
        finishedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(heartbeatRuns.id, input.outgoingRunId));
    }
    await db.update(issues).set({
      status: input.status,
      assigneeAgentId: input.assigneeAgentId,
      executionRunId: null,
      updatedAt: new Date(),
    }).where(eq(issues.id, input.issueId));
  }

  function createService() {
    const wakes: Array<{ agentId: string; opts: Record<string, unknown> | undefined }> = [];
    const service = taskWatchdogService(db, {
      enqueueWakeup: async (agentId, opts) => {
        wakes.push({ agentId, opts: opts as Record<string, unknown> | undefined });
        return { id: randomUUID() };
      },
    });
    return { service, wakes };
  }

  async function watchdogState(watchedIssueId: string) {
    const [watchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, watchedIssueId));
    const watchdogIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.originKind, "task_watchdog"), eq(issues.originId, watchedIssueId)));
    const triggers = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, watchedIssueId), eq(activityLog.action, "issue.task_watchdog_triggered")));
    return { watchdog: watchdog!, watchdogIssues, triggers };
  }

  /** Advance only the JS clock; postgres keeps running on real timers. */
  function advanceClock(ms: number) {
    const target = Date.now() + ms;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(target);
  }

  async function seedHonchoLikeTree() {
    const companyId = await seedCompany();
    const cto = await seedAgent(companyId, "CTO");
    const developer = await seedAgent(companyId, "Developer");
    const reviewer = await seedAgent(companyId, "Reviewer");
    const rootId = await seedIssue(companyId, { identifier: "HO-115", status: "in_review", assigneeAgentId: cto });
    const sliceId = await seedIssue(companyId, {
      identifier: "HO-116",
      parentId: rootId,
      status: "in_progress",
      assigneeAgentId: developer,
    });
    await seedWatchdog(companyId, rootId, cto);
    return { companyId, cto, developer, reviewer, rootId, sliceId };
  }

  it("regression: does not dispatch a watchdog review in the gap between a review hand-off and its successor wake", async () => {
    const t = await seedHonchoLikeTree();
    const developerRun = await seedRun(t.companyId, t.developer, t.sliceId, "running");
    await db.update(issues).set({ executionRunId: developerRun.id }).where(eq(issues.id, t.sliceId));
    const { service, wakes } = createService();

    // Steady state before the hand-off: live.
    expect(await service.reconcileTaskWatchdogs({ companyId: t.companyId })).toMatchObject({ triggered: 0, live: 1 });

    // Developer submits for review: run cancelled issue_reassigned, issue
    // in_review/Reviewer, reviewer wake still in flight. The route hook runs now.
    await commitHandOff({
      companyId: t.companyId,
      issueId: t.sliceId,
      outgoingRunId: developerRun.id,
      status: "in_review",
      assigneeAgentId: t.reviewer,
    });
    const hook = await service.reconcileForIssueAndAncestors(t.companyId, t.sliceId, { runId: developerRun.id });
    expect(hook).toMatchObject({ checked: 1, triggered: 0 });

    // The fire-and-forget reviewer wake becomes visible; the next reconciler
    // pass (after the settle window) sees a healthy live path.
    await seedWake(t.companyId, t.reviewer, t.sliceId, "queued");
    advanceClock(PAST_SETTLE_WINDOW_MS);
    expect(await service.reconcileTaskWatchdogs({ companyId: t.companyId })).toMatchObject({ triggered: 0, live: 1 });

    const state = await watchdogState(t.rootId);
    expect(wakes).toHaveLength(0);
    expect(state.watchdog.triggerCount).toBe(0);
    expect(state.watchdogIssues).toHaveLength(0);
    expect(state.triggers).toHaveLength(0);
  });

  it("runs a full native review loop (first assignment, review, changes requested, resubmission, approval) without watchdog work", async () => {
    const companyId = await seedCompany();
    const cto = await seedAgent(companyId, "CTO");
    const developer = await seedAgent(companyId, "Developer");
    const reviewer = await seedAgent(companyId, "Reviewer");
    const rootId = await seedIssue(companyId, { identifier: "HO-145", status: "in_progress", assigneeAgentId: cto });
    const ctoRun = await seedRun(companyId, cto, rootId, "running");
    await seedWatchdog(companyId, rootId, cto);
    const { service, wakes } = createService();

    // 1. Normal first assignment: CTO creates the slice for Developer; the
    //    assignment wake is not yet visible when the hook evaluates.
    const sliceId = await seedIssue(companyId, {
      identifier: "HO-146",
      parentId: rootId,
      status: "todo",
      assigneeAgentId: developer,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // The CTO's own run ends right after delegating.
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, ctoRun.id));
    expect(await service.reconcileForIssueAndAncestors(companyId, sliceId, { runId: ctoRun.id }))
      .toMatchObject({ triggered: 0 });
    await seedWake(companyId, developer, sliceId, "completed");
    let developerRun = await seedRun(companyId, developer, sliceId, "running");

    // 2. Review-stage hand-off.
    advanceClock(PAST_SETTLE_WINDOW_MS);
    await commitHandOff({ companyId, issueId: sliceId, outgoingRunId: developerRun.id, status: "in_review", assigneeAgentId: reviewer });
    expect(await service.reconcileForIssueAndAncestors(companyId, sliceId, { runId: developerRun.id }))
      .toMatchObject({ triggered: 0 });
    let reviewerRun = await seedRun(companyId, reviewer, sliceId, "running");

    // 3. Changes-requested return to Developer (queued behind another run).
    advanceClock(PAST_SETTLE_WINDOW_MS);
    await commitHandOff({ companyId, issueId: sliceId, outgoingRunId: reviewerRun.id, status: "in_progress", assigneeAgentId: developer });
    expect(await service.reconcileForIssueAndAncestors(companyId, sliceId, { runId: reviewerRun.id }))
      .toMatchObject({ triggered: 0 });
    await seedWake(companyId, developer, sliceId, "queued");
    advanceClock(PAST_SETTLE_WINDOW_MS);
    expect(await service.reconcileTaskWatchdogs({ companyId })).toMatchObject({ triggered: 0, live: 1 });
    await db.update(agentWakeupRequests).set({ status: "completed", finishedAt: new Date() })
      .where(eq(agentWakeupRequests.agentId, developer));
    developerRun = await seedRun(companyId, developer, sliceId, "running");

    // 4. Resubmission for pass 2.
    advanceClock(PAST_SETTLE_WINDOW_MS);
    await commitHandOff({ companyId, issueId: sliceId, outgoingRunId: developerRun.id, status: "in_review", assigneeAgentId: reviewer });
    expect(await service.reconcileForIssueAndAncestors(companyId, sliceId, { runId: developerRun.id }))
      .toMatchObject({ triggered: 0 });
    reviewerRun = await seedRun(companyId, reviewer, sliceId, "running");
    advanceClock(PAST_SETTLE_WINDOW_MS);
    expect(await service.reconcileTaskWatchdogs({ companyId })).toMatchObject({ triggered: 0, live: 1 });

    // 5. Approval: slice done, parent continuation wake still in flight.
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, reviewerRun.id));
    await db.update(issues).set({ status: "done", updatedAt: new Date() }).where(eq(issues.id, sliceId));
    expect(await service.reconcileForIssueAndAncestors(companyId, sliceId, { runId: reviewerRun.id }))
      .toMatchObject({ triggered: 0 });
    await seedWake(companyId, cto, rootId, "queued");
    advanceClock(PAST_SETTLE_WINDOW_MS);
    expect(await service.reconcileTaskWatchdogs({ companyId })).toMatchObject({ triggered: 0, live: 1 });

    const state = await watchdogState(rootId);
    expect(wakes).toHaveLength(0);
    expect(state.watchdog.triggerCount).toBe(0);
    expect(state.watchdogIssues).toHaveLength(0);
    expect(state.triggers).toHaveLength(0);
  });

  it("does not trigger for a legitimate deferred continuation or a continuation queued after run release", async () => {
    const t = await seedHonchoLikeTree();
    const { service, wakes } = createService();

    // Deferred continuation (issue_execution_deferred) covers the subtree.
    const deferred = await seedWake(t.companyId, t.developer, t.sliceId, "deferred_issue_execution");
    expect(await service.reconcileTaskWatchdogs({ companyId: t.companyId })).toMatchObject({ triggered: 0, live: 1 });
    await db.update(agentWakeupRequests).set({ status: "completed", finishedAt: new Date() })
      .where(eq(agentWakeupRequests.id, deferred.id));

    // Run release: the run ends, the execution lock is released (bumping the
    // issue's updatedAt) and the continuation wake is enqueued afterwards.
    const run = await seedRun(t.companyId, t.developer, t.sliceId, "running");
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
    await db.update(issues).set({ executionRunId: null, updatedAt: new Date() }).where(eq(issues.id, t.sliceId));
    expect(await service.reconcileTaskWatchdogs({ companyId: t.companyId })).toMatchObject({ triggered: 0, settling: 1 });
    await seedWake(t.companyId, t.developer, t.sliceId, "queued");
    advanceClock(PAST_SETTLE_WINDOW_MS);
    expect(await service.reconcileTaskWatchdogs({ companyId: t.companyId })).toMatchObject({ triggered: 0, live: 1 });

    expect(wakes).toHaveLength(0);
    expect((await watchdogState(t.rootId)).watchdog.triggerCount).toBe(0);
  });

  for (const successor of ["skipped", "failed", "unclaimed"] as const) {
    it(`still raises exactly one correctly owned review when the hand-off successor is ${successor}`, async () => {
      const t = await seedHonchoLikeTree();
      const developerRun = await seedRun(t.companyId, t.developer, t.sliceId, "running");
      const { service, wakes } = createService();

      await commitHandOff({
        companyId: t.companyId,
        issueId: t.sliceId,
        outgoingRunId: developerRun.id,
        status: "in_review",
        assigneeAgentId: t.reviewer,
      });
      if (successor === "skipped") {
        await seedWake(t.companyId, t.reviewer, t.sliceId, "skipped");
      } else if (successor === "failed") {
        await seedWake(t.companyId, t.reviewer, t.sliceId, "completed");
        await seedRun(t.companyId, t.reviewer, t.sliceId, "failed", { errorCode: "adapter_failed" });
      }
      // "unclaimed": the successor wake never materialises at all.

      // Hook pass during the settle window: deferred, not silenced.
      const hook = await service.reconcileForIssueAndAncestors(t.companyId, t.sliceId, { runId: developerRun.id });
      expect(hook).toMatchObject({ checked: 1, triggered: 0, settling: 1 });
      expect(wakes).toHaveLength(0);

      // Next native reconciler pass after the window: the stall persists, so
      // it triggers exactly once, owned by the configured watchdog agent.
      advanceClock(PAST_SETTLE_WINDOW_MS);
      const later = await service.reconcileTaskWatchdogs({ companyId: t.companyId });
      expect(later).toMatchObject({ checked: 1, triggered: 1 });
      expect(wakes).toHaveLength(1);
      expect(wakes[0]!.agentId).toBe(t.cto);
      expect(wakes[0]!.opts?.reason).toBe("task_watchdog_stopped_subtree");
      const firstKey = wakes[0]!.opts?.idempotencyKey as string;
      expect(firstKey).toMatch(/^task_watchdog:[^:]+:task_watchdog_stop:/);

      // Further passes do not repeat it (open same-fingerprint review dedup).
      advanceClock(30_000);
      const again = await service.reconcileTaskWatchdogs({ companyId: t.companyId });
      expect(again).toMatchObject({ checked: 1, triggered: 0 });
      expect(wakes).toHaveLength(1);

      const state = await watchdogState(t.rootId);
      expect(state.watchdog.triggerCount).toBe(1);
      expect(state.watchdogIssues).toHaveLength(1);
      expect(state.watchdogIssues[0]).toMatchObject({ assigneeAgentId: t.cto, parentId: t.rootId });
      expect(state.triggers).toHaveLength(1);
      expect(state.triggers[0]!.details).toMatchObject({
        stopFingerprint: firstKey.slice(firstKey.indexOf("task_watchdog_stop:")),
        stoppedLeaves: [expect.objectContaining({ issueId: t.sliceId, status: "in_review", assigneeAgentId: t.reviewer })],
      });
    });
  }

  it("triggers a genuinely idle subtree immediately, with no settle deferral", async () => {
    const t = await seedHonchoLikeTree();
    const { service, wakes } = createService();

    const result = await service.reconcileTaskWatchdogs({ companyId: t.companyId });

    expect(result).toMatchObject({ checked: 1, triggered: 1, settling: 0 });
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.agentId).toBe(t.cto);
    expect((await watchdogState(t.rootId)).watchdog.triggerCount).toBe(1);
  });

  it("R1 regression: repeated metadata touches (including a done sibling) cannot renew the deferral; one owned signal, then no duplicate", async () => {
    // Review pass 1 reproduction: an hour-old in-progress root, an hour-old
    // stalled child and a done sibling; no run or wake anywhere. Before every
    // reconciler pass only the done sibling's updatedAt is refreshed (as a
    // comment on it would do). Stock dispatches at once; an unbounded settle
    // window would defer forever with an unchanged fingerprint.
    const companyId = await seedCompany();
    const cto = await seedAgent(companyId, "CTO");
    const developer = await seedAgent(companyId, "Developer");
    const rootId = await seedIssue(companyId, { identifier: "HO-200", status: "in_progress", assigneeAgentId: cto });
    const stalledId = await seedIssue(companyId, {
      identifier: "HO-201",
      parentId: rootId,
      status: "in_progress",
      assigneeAgentId: developer,
    });
    const doneSiblingId = await seedIssue(companyId, {
      identifier: "HO-202",
      parentId: rootId,
      status: "done",
      assigneeAgentId: developer,
    });
    await seedWatchdog(companyId, rootId, cto);
    const { service, wakes } = createService();

    const results: Array<Record<string, unknown>> = [];
    for (let pass = 0; pass <= 10; pass += 1) {
      if (pass > 0) advanceClock(30_000);
      await db.update(issues).set({ updatedAt: new Date(Date.now() - 1_000) }).where(eq(issues.id, doneSiblingId));
      results.push(await service.reconcileTaskWatchdogs({ companyId }));
    }

    // Pass 0 (t=0) is the first observation: one bounded deferral.
    expect(results[0]).toMatchObject({ checked: 1, triggered: 0, settling: 1 });
    // Pass 1 (t=30 s) is past the bound for the unchanged stopped condition:
    // it dispatches although the sibling was touched one second earlier.
    expect(results[1]).toMatchObject({ checked: 1, triggered: 1, settling: 0 });
    // Passes 2..10 (t=60..300 s): deduplicated, never re-deferred or repeated.
    for (const later of results.slice(2)) {
      expect(later).toMatchObject({ checked: 1, triggered: 0, settling: 0 });
    }

    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.agentId).toBe(cto);
    expect(wakes[0]!.opts?.reason).toBe("task_watchdog_stopped_subtree");
    const key = wakes[0]!.opts?.idempotencyKey as string;
    const state = await watchdogState(rootId);
    expect(state.watchdog.triggerCount).toBe(1);
    expect(state.watchdogIssues).toHaveLength(1);
    expect(state.watchdogIssues[0]).toMatchObject({ assigneeAgentId: cto, parentId: rootId });
    expect(state.triggers).toHaveLength(1);
    expect(state.triggers[0]!.details).toMatchObject({
      stopFingerprint: key.slice(key.indexOf("task_watchdog_stop:")),
      stoppedLeaves: [expect.objectContaining({ issueId: stalledId, status: "in_progress", assigneeAgentId: developer })],
    });
  });

  it("bounds the deferral from the hook's first observation, even when the reconciler pass lands inside the window", async () => {
    const t = await seedHonchoLikeTree();
    const developerRun = await seedRun(t.companyId, t.developer, t.sliceId, "running");
    const { service, wakes } = createService();

    await commitHandOff({
      companyId: t.companyId,
      issueId: t.sliceId,
      outgoingRunId: developerRun.id,
      status: "in_review",
      assigneeAgentId: t.reviewer,
    });
    // Hook (first observation) and a reconciler pass 5 s later: both defer.
    expect(await service.reconcileForIssueAndAncestors(t.companyId, t.sliceId, { runId: developerRun.id }))
      .toMatchObject({ triggered: 0, settling: 1 });
    advanceClock(5_000);
    await db.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, t.sliceId));
    expect(await service.reconcileTaskWatchdogs({ companyId: t.companyId })).toMatchObject({ triggered: 0, settling: 1 });
    // A further touch at 14 s does not extend the bound past 15 s from the
    // first observation: the next pass (20 s) dispatches.
    advanceClock(9_000);
    await db.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, t.sliceId));
    advanceClock(6_000);
    expect(await service.reconcileTaskWatchdogs({ companyId: t.companyId })).toMatchObject({ triggered: 1, settling: 0 });
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.agentId).toBe(t.cto);
  });

  it("starts a fresh bounded window for a new hand-off once the subtree was live again", async () => {
    const t = await seedHonchoLikeTree();
    const { service, wakes } = createService();

    // Hand-off 1: deferred, then the successor becomes live (clears the bound).
    let run = await seedRun(t.companyId, t.developer, t.sliceId, "running");
    await commitHandOff({ companyId: t.companyId, issueId: t.sliceId, outgoingRunId: run.id, status: "in_review", assigneeAgentId: t.reviewer });
    expect(await service.reconcileForIssueAndAncestors(t.companyId, t.sliceId, { runId: run.id }))
      .toMatchObject({ triggered: 0, settling: 1 });
    run = await seedRun(t.companyId, t.reviewer, t.sliceId, "running");
    advanceClock(PAST_SETTLE_WINDOW_MS);
    expect(await service.reconcileTaskWatchdogs({ companyId: t.companyId })).toMatchObject({ triggered: 0, live: 1 });

    // Hand-off 2 much later lands on the same material state (in_review /
    // Reviewer after a reviewer continuation). The old observation must not
    // make it dispatch in the gap.
    advanceClock(10 * 60_000);
    await commitHandOff({ companyId: t.companyId, issueId: t.sliceId, outgoingRunId: run.id, status: "in_review", assigneeAgentId: t.reviewer });
    expect(await service.reconcileForIssueAndAncestors(t.companyId, t.sliceId, { runId: run.id }))
      .toMatchObject({ triggered: 0, settling: 1 });
    await seedWake(t.companyId, t.reviewer, t.sliceId, "queued");
    advanceClock(PAST_SETTLE_WINDOW_MS);
    expect(await service.reconcileTaskWatchdogs({ companyId: t.companyId })).toMatchObject({ triggered: 0, live: 1 });

    expect(wakes).toHaveLength(0);
    expect((await watchdogState(t.rootId)).watchdog.triggerCount).toBe(0);
  });

  it("re-defers within the bound while transitions continue, then triggers once on the first pass past it", async () => {
    const t = await seedHonchoLikeTree();
    const { service, wakes } = createService();

    await db.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, t.sliceId));
    expect(await service.reconcileTaskWatchdogs({ companyId: t.companyId })).toMatchObject({ triggered: 0, settling: 1 });
    advanceClock(10_000);
    // Still within the window of the same transition.
    expect(await service.reconcileTaskWatchdogs({ companyId: t.companyId })).toMatchObject({ triggered: 0, settling: 1 });
    advanceClock(PAST_SETTLE_WINDOW_MS);
    expect(await service.reconcileTaskWatchdogs({ companyId: t.companyId })).toMatchObject({ triggered: 1 });
    expect(wakes).toHaveLength(1);
  });

  it("keeps an already-dispatched watchdog review's mutation scope valid during the settle window", async () => {
    const t = await seedHonchoLikeTree();
    const { service, wakes } = createService();
    expect(await service.reconcileTaskWatchdogs({ companyId: t.companyId })).toMatchObject({ triggered: 1 });
    const { watchdog } = await watchdogState(t.rootId);
    expect(wakes).toHaveLength(1);

    // A metadata-only touch (no material change) refreshes updatedAt.
    await db.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, t.sliceId));

    const scope = await service.revalidateMutationScope({
      kind: "watchdog",
      watchdogId: watchdog.id,
      companyId: t.companyId,
      watchedIssueId: t.rootId,
      stopFingerprint: watchdog.lastObservedFingerprint,
    });
    expect(scope.allowed).toBe(true);
  });
});
