import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { truncateTablesWithDeadlockRetry } from "./helpers/truncate-with-deadlock-retry.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Stranded dependency wake test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stranded dependency wake tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}


// Backport of upstream #19457 and #20180 onto the 2026.1106 base: a deferred
// dependency wake (issue_blockers_resolved or issue_children_completed) that
// the release drain missed is started by the stranded-queue resume once the
// issue has no live run, like a saved comment.
describeEmbeddedPostgres("stranded dependency wakes after the release drain missed them", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-stranded-dependency-wake-");
    db = createDb(tempDb.connectionString);
    await db.insert(authUsers).values({ id: "responsible-user", name: "Fixture owner", email: "owner@example.test",
      createdAt: new Date(), updatedAt: new Date() });
    heartbeat = heartbeatService(db);
  }, 60_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await truncateTablesWithDeadlockRetry(
      db,
      `
        TRUNCATE TABLE
          "issue_relations",
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
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(wakeReason: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const parentId = randomUUID();
    const childId = randomUUID();
    const sourceRunId = randomUUID();
    const issuePrefix = `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user",
      status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Parent owner", role: "engineer", status: "idle",
      adapterType: "process", adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    // The parent's run finished (the agent set the parent blocked before it
    // saw the children's results); the lock is already released.
    await db.insert(issues).values({ id: parentId, companyId, title: "Parent", status: "blocked", priority: "medium",
      assigneeAgentId: agentId, executionRunId: null, issueNumber: 1, identifier: `${issuePrefix}-1` });
    await db.insert(issues).values({ id: childId, companyId, title: "Part 1", status: "done", priority: "medium",
      parentId, completedAt: new Date(), issueNumber: 2, identifier: `${issuePrefix}-2` });
    if (wakeReason === "issue_blockers_resolved") {
      await db.execute(sql`insert into issue_relations (company_id, issue_id, related_issue_id, type)
        values (${companyId}, ${childId}, ${parentId}, 'blocks')`);
    }
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId, invocationSource: "assignment",
      triggerDetail: "system", status: "succeeded", startedAt: new Date(Date.now() - 60_000), finishedAt: new Date(),
      responsibleUserId: "responsible-user", issueId: parentId,
      contextSnapshot: { issueId: parentId, taskId: parentId, wakeReason: "issue_assigned" } });
    const [receipt] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation",
      triggerDetail: "system", reason: "issue_execution_deferred", status: "deferred_issue_execution",
      requestedByActorType: "system", idempotencyKey: `${wakeReason}:${parentId}`,
      payload: { issueId: parentId, childIssueIds: [childId], _paperclipWakeContext: { issueId: parentId,
        taskId: parentId, wakeReason, source: "issue.status_change", childIssueIds: [childId] } },
    }).returning();
    return { companyId, agentId, parentId, childId, sourceRunId, receipt: receipt! };
  }

  it.each(["issue_children_completed", "issue_blockers_resolved"])(
    "starts a %s wake left deferred after the parent's run ended", async (wakeReason) => {
      const f = await seed(wakeReason);
      await heartbeat.resumeQueuedRuns();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      const [saved] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receipt.id));
      expect(saved?.status).not.toBe("deferred_issue_execution");
      const runs = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
        .filter((run) => run.contextSnapshot?.wakeReason === wakeReason);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.wakeupRequestId).toBe(f.receipt.id);
      // A second sweep finds nothing left to start: one continuation only.
      await heartbeat.resumeQueuedRuns();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
        .filter((run) => run.contextSnapshot?.wakeReason === wakeReason)).toHaveLength(1);
    });

  it("leaves a deferred wake of another reason to its own owner", async () => {
    const f = await seed("issue_status_changed");
    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const [saved] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receipt.id));
    expect(saved?.status).toBe("deferred_issue_execution");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
      .filter((run) => run.wakeupRequestId === f.receipt.id)).toHaveLength(0);
  });
});
