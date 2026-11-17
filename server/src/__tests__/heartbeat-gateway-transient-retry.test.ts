import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
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
import { readHeartbeatRunErrorFamily } from "../services/heartbeat/retries.ts";
import {
  isHermesGatewayTransientBadRequest,
  legacyExecutionNeedsReconciliationWithEvidence,
} from "../services/legacy-execution-recovery.ts";

const GATEWAY_400 = 'HTTP 400 {"detail":"Bad Request"}';
const TEST_ADAPTER = "hermes_gateway_transient_test";
const adapterBehaviour = vi.hoisted(() => ({
  errorCode: "hermes_gateway_run_failed" as string | null,
  errorMessage: 'HTTP 400 {"detail":"Bad Request"}' as string | null,
  postComment: false,
  calls: 0,
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("hermes gateway transient HTTP 400 classification", () => {
  it.each([
    ["hermes_gateway_run_failed", GATEWAY_400, "transient_upstream"],
    ["hermes_gateway_run_failed", "Hermes gateway HTTP 400", "transient_upstream"],
    ["hermes_gateway_run_failed", "HTTP 500 Internal Server Error", null],
    ["hermes_gateway_run_failed", "HTTP 4000 tokens", null],
    ["hermes_gateway_run_failed", null, null],
    ["hermes_gateway_timeout", GATEWAY_400, null],
    ["hermes_gateway_cancelled", GATEWAY_400, null],
    ["hermes_gateway_protocol_error", GATEWAY_400, null],
    ["adapter_failed", GATEWAY_400, null],
  ])("classifies %s with error %j as %s", (errorCode, error, family) => {
    const run = { errorCode, error, resultJson: {} };
    expect(isHermesGatewayTransientBadRequest(run)).toBe(family !== null);
    expect(readHeartbeatRunErrorFamily(run)).toBe(family);
  });

  it("keeps a persisted error family ahead of the gateway rule", () => {
    expect(readHeartbeatRunErrorFamily({ errorCode: "hermes_gateway_run_failed", error: GATEWAY_400,
      resultJson: { errorFamily: "provider_quota" } })).toBe("provider_quota");
  });
});

describeEmbeddedPostgres("bounded retry for a transient hermes gateway HTTP 400", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-gateway-transient-retry-");
    db = createDb(tempDb.connectionString);
    await db.insert(authUsers).values({ id: "responsible-user", name: "Fixture owner", email: "owner@example.test",
      createdAt: new Date(), updatedAt: new Date() });
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: TEST_ADAPTER,
      execute: async (ctx) => {
        adapterBehaviour.calls += 1;
        if (adapterBehaviour.postComment) {
          const issueId = String(ctx.context?.issueId ?? "");
          await db.insert(issueComments).values({ companyId: String(ctx.agent.companyId), issueId,
            authorAgentId: ctx.agent.id, createdByRunId: ctx.runId, body: "Progress note before the gateway failed." });
        }
        return {
          exitCode: adapterBehaviour.errorCode ? 1 : 0,
          signal: null,
          timedOut: false,
          provider: "hermes_gateway",
          ...(adapterBehaviour.errorCode ? { errorCode: adapterBehaviour.errorCode } : {}),
          ...(adapterBehaviour.errorMessage ? { errorMessage: adapterBehaviour.errorMessage } : {}),
        };
      },
      testEnvironment: async () => ({ adapterType: TEST_ADAPTER, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 60_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
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
    Object.assign(adapterBehaviour, { errorCode: "hermes_gateway_run_failed", errorMessage: GATEWAY_400, postComment: false, calls: 0 });
    vi.clearAllMocks();
  });

  afterAll(async () => {
    unregisterServerAdapter(TEST_ADAPTER);
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `G${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user",
      status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Gateway agent", role: "engineer", status: "idle",
      adapterType: TEST_ADAPTER, adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Gateway task", status: "in_progress", priority: "medium",
      assigneeAgentId: agentId, issueNumber: 1, identifier: `${issuePrefix}-1` });
    return { companyId, agentId, issueId };
  }

  async function wakeAndFinish(f: { agentId: string; issueId: string }, reason = "issue_assigned") {
    const run = await heartbeat.wakeup(f.agentId, {
      source: "automation", triggerDetail: "system", reason,
      payload: { issueId: f.issueId },
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: reason },
      requestedByActorType: "user", requestedByActorId: "local-board",
    });
    expect(run).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id)))[0]!;
  }

  async function retriesOf(runId: string) {
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
  }

  async function recoveryActionsFor(issueId: string) {
    return db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
  }

  it("schedules one backed-off transient retry when the failed attempt recorded no effect, and keeps no hold", async () => {
    const f = await seed();
    const before = Date.now();
    const failed = await wakeAndFinish(f);
    expect(failed).toMatchObject({ status: "failed", errorCode: "hermes_gateway_run_failed", error: GATEWAY_400 });
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, failed)).toBe(false);
    const [retry, ...extra] = await retriesOf(failed.id);
    expect(extra).toHaveLength(0);
    expect(retry).toMatchObject({ status: "scheduled_retry", scheduledRetryAttempt: 1, scheduledRetryReason: "transient_failure" });
    const delay = retry!.scheduledRetryAt!.getTime() - before;
    expect(delay).toBeGreaterThanOrEqual(24_000 - 1_000);
    expect(delay).toBeLessThanOrEqual(36_000 + 5_000);
    expect(await recoveryActionsFor(f.issueId)).toHaveLength(0);
    expect(adapterBehaviour.calls).toBe(1);
  });

  it("caps the retries at two with growing backoff, then fails normally with no hold, pause or recovery action", async () => {
    const f = await seed();
    const first = await wakeAndFinish(f);
    const now = new Date();
    // Attempt 2: the first retry also failed with the transient 400.
    const [retry1] = await retriesOf(first.id);
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "hermes_gateway_run_failed", error: GATEWAY_400,
      finishedAt: now }).where(eq(heartbeatRuns.id, retry1!.id));
    const second = await heartbeat.scheduleBoundedRetry(retry1!.id, { now, random: () => 0 });
    expect(second).toMatchObject({ outcome: "scheduled", attempt: 2, run: { scheduledRetryAttempt: 2 } });
    if (second.outcome !== "scheduled") throw new Error("Expected the second retry");
    expect(second.dueAt.getTime() - now.getTime()).toBe(48_000);
    // Attempt 3 is over the cap.
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "hermes_gateway_run_failed", error: GATEWAY_400,
      finishedAt: now }).where(eq(heartbeatRuns.id, second.run!.id));
    const exhausted = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, second.run!.id)))[0]!;
    expect(await heartbeat.scheduleBoundedRetry(exhausted.id, { now, random: () => 0 }))
      .toMatchObject({ outcome: "retry_exhausted", maxAttempts: 2 });
    expect(await heartbeat.scheduleBoundedRetry(exhausted.id, { now, random: () => 0 }))
      .toMatchObject({ outcome: "retry_exhausted" });
    expect(await retriesOf(exhausted.id)).toHaveLength(0);
    // Exhaustion is a plain failed run: no reconciliation hold, no recovery action, agent not paused.
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, exhausted)).toBe(false);
    expect(await recoveryActionsFor(f.issueId)).toHaveLength(0);
    expect((await db.select().from(agents).where(eq(agents.id, f.agentId)))[0]?.status).not.toBe("paused");
  });

  it("does not start the failed attempt again when it already posted a comment (no replay)", async () => {
    const f = await seed();
    adapterBehaviour.postComment = true;
    const failed = await wakeAndFinish(f);
    expect(failed).toMatchObject({ status: "failed", errorCode: "hermes_gateway_run_failed" });
    expect(await db.select().from(issueComments).where(eq(issueComments.createdByRunId, failed.id))).toHaveLength(1);
    expect(await retriesOf(failed.id)).toHaveLength(0);
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, failed)).toBe(true);
    expect(await heartbeat.scheduleBoundedRetry(failed.id, { random: () => 0 }))
      .toMatchObject({ outcome: "not_scheduled", errorCode: "legacy_execution_requires_reconciliation" });
    expect(adapterBehaviour.calls).toBe(1);
  });

  it("treats recorded agent activity as an effect, but not a repeatable read", async () => {
    const f = await seed();
    Object.assign(adapterBehaviour, { errorCode: null, errorMessage: null });
    const ok = await wakeAndFinish(f);
    const failedRun = async (id: string) => {
      await db.insert(heartbeatRuns).values({ id, companyId: f.companyId, agentId: f.agentId, invocationSource: "assignment",
        status: "failed", errorCode: "hermes_gateway_run_failed", error: GATEWAY_400, startedAt: new Date(), finishedAt: new Date(),
        contextSnapshot: { issueId: f.issueId, wakeReason: "issue_assigned" } });
      return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;
    };
    const readOnly = await failedRun(randomUUID());
    await db.insert(activityLog).values({ companyId: f.companyId, actorType: "agent", actorId: f.agentId, agentId: f.agentId,
      runId: readOnly.id, action: "tool_gateway.discovery", entityType: "issue", entityId: f.issueId });
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, readOnly)).toBe(false);
    const changed = await failedRun(randomUUID());
    await db.insert(activityLog).values({ companyId: f.companyId, actorType: "agent", actorId: f.agentId, agentId: f.agentId,
      runId: changed.id, action: "issue.updated", entityType: "issue", entityId: f.issueId });
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, changed)).toBe(true);
    expect(ok.status).toBe("succeeded");
  });

  it.each([
    ["hermes_gateway_run_failed", "HTTP 500 Internal Server Error"],
    ["hermes_gateway_timeout", GATEWAY_400],
    ["adapter_failed", GATEWAY_400],
  ])("leaves %s (%s) as it is today: no automatic retry", async (errorCode, errorMessage) => {
    const f = await seed();
    Object.assign(adapterBehaviour, { errorCode, errorMessage });
    const failed = await wakeAndFinish(f);
    expect(failed).toMatchObject({ status: "failed", errorCode });
    expect(await retriesOf(failed.id)).toHaveLength(0);
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, failed)).toBe(true);
  });

  it("runs the whole chain: two backed-off retries, then a plain failure that lets the next comment wake through", async () => {
    const f = await seed();
    const first = await wakeAndFinish(f);
    const chain = [first];
    for (const attempt of [1, 2]) {
      const [retry, ...extra] = await retriesOf(chain.at(-1)!.id);
      expect(extra).toHaveLength(0);
      expect(retry).toMatchObject({ status: "scheduled_retry", scheduledRetryAttempt: attempt, scheduledRetryReason: "transient_failure" });
      const promotion = await heartbeat.promoteDueScheduledRetries(retry!.scheduledRetryAt!);
      expect(promotion.runIds).toContain(retry!.id);
      await heartbeat.resumeQueuedRunsForAgent(f.companyId, f.agentId);
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      const ran = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retry!.id)))[0]!;
      expect(ran).toMatchObject({ status: "failed", errorCode: "hermes_gateway_run_failed" });
      chain.push(ran);
    }
    // Three provider attempts in total; no third retry and no loop.
    expect(adapterBehaviour.calls).toBe(3);
    const last = chain.at(-1)!;
    expect(await retriesOf(last.id)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      eq(heartbeatRuns.status, "scheduled_retry")))).toHaveLength(0);
    // Exhaustion is a normal failed run: no hold on the issue, no recovery action, agent not paused.
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, last)).toBe(false);
    expect(await recoveryActionsFor(f.issueId)).toHaveLength(0);
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]?.executionRunId).toBeNull();
    expect((await db.select().from(agents).where(eq(agents.id, f.agentId)))[0]?.status).not.toBe("paused");
    // The next genuine event is dispatched, not deferred behind a hold.
    Object.assign(adapterBehaviour, { errorCode: null, errorMessage: null });
    const next = await wakeAndFinish(f, "issue_commented");
    expect(next.status).toBe("succeeded");
    expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId, f.agentId),
      eq(agentWakeupRequests.status, "deferred_issue_execution")))).toHaveLength(0);
  });
});
