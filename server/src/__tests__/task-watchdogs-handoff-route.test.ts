import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  costEvents,
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issueWatchdogs,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { runningProcesses } from "../adapters/index.ts";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { taskWatchdogService } from "../services/task-watchdogs.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

// BLA-145 / BLA-146 route-level regression. The issue PATCH route commits the
// hand-off, dispatches the successor wake fire-and-forget (`void (async () =>
// { ... heartbeat.wakeup(...) })()`), and then awaits the task-watchdog hook
// (`queueTaskWatchdogEvaluation`). In production the hook repeatedly read its
// snapshot before the successor wake was committed. Here the successor wake is
// held until the PATCH response has been sent, which makes that observed
// ordering deterministic without changing any route code.

const wakeGate = vi.hoisted(() => {
  let release!: () => void;
  let promise = Promise.resolve();
  return {
    hold() {
      promise = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release() {
      release?.();
    },
    wait() {
      return promise;
    },
  };
});

vi.mock("../services/index.js", async () => {
  const actual = await vi.importActual<typeof import("../services/index.js")>("../services/index.js");
  return {
    ...actual,
    heartbeatService: (...args: Parameters<typeof actual.heartbeatService>) => {
      const heartbeat = actual.heartbeatService(...args);
      return {
        ...heartbeat,
        wakeup: async (...wakeArgs: Parameters<typeof heartbeat.wakeup>) => {
          await wakeGate.wait();
          return heartbeat.wakeup(...wakeArgs);
        },
      };
    },
  };
});

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Hand-off route test run.",
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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres watchdog hand-off route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("task watchdog hand-off through the issue PATCH route", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-task-watchdogs-handoff-route-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    wakeGate.release();
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(heartbeatRunEvents);
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(issueRelations);
    await db.delete(issueWatchdogs);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Hand-off route Co",
      issuePrefix: `H${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "cloud-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: "cloud-user-1",
      membershipRole: "owner",
      grantedByUserId: null,
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

  async function seedIssue(companyId: string, overrides: Partial<typeof issues.$inferInsert>) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: overrides.title ?? "Watched task",
      status: overrides.status ?? "todo",
      priority: "medium",
      parentId: overrides.parentId,
      assigneeAgentId: overrides.assigneeAgentId,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    return id;
  }

  function createApp(companyId: string, watchdogWakes: string[]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "cloud-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, {
      taskWatchdogEnqueueWakeup: async (agentId) => {
        watchdogWakes.push(agentId);
        return { id: randomUUID() };
      },
    }));
    app.use(errorHandler);
    return app;
  }

  async function waitForWake(companyId: string, agentId: string) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const rows = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId)));
      if (rows.length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("successor wake never appeared");
  }

  it("regression: a reassignment hand-off does not dispatch watchdog work while its successor wake is in flight", async () => {
    const companyId = await seedCompany();
    const cto = await seedAgent(companyId, "CTO");
    const developer = await seedAgent(companyId, "Developer");
    const reviewer = await seedAgent(companyId, "Reviewer");
    const rootId = await seedIssue(companyId, { title: "Watched root", status: "in_progress", assigneeAgentId: cto });
    const sliceId = await seedIssue(companyId, {
      title: "Slice",
      parentId: rootId,
      status: "in_progress",
      assigneeAgentId: developer,
    });
    // The CTO's run on the root keeps the subtree live until the hand-off.
    const [ctoRun] = await db.insert(heartbeatRuns).values({
      companyId,
      agentId: cto,
      status: "running",
      invocationSource: "assignment",
      contextSnapshot: { issueId: rootId, taskId: rootId },
    }).returning();
    await db.insert(issueWatchdogs).values({
      companyId,
      issueId: rootId,
      watchdogAgentId: cto,
      instructions: "Verify stopped work.",
      status: "active",
    });
    expect(await taskWatchdogService(db).reconcileTaskWatchdogs({ companyId }))
      .toMatchObject({ checked: 1, triggered: 0, live: 1 });
    // The CTO run ends; the slice owner hands the work to the reviewer.
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, ctoRun!.id));

    const watchdogWakes: string[] = [];
    const app = createApp(companyId, watchdogWakes);
    wakeGate.hold();
    const res = await request(app)
      .patch(`/api/issues/${sliceId}`)
      .send({ assigneeAgentId: reviewer, status: "todo" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ assigneeAgentId: reviewer });

    // The hook has already run (it is awaited before the response).
    const [afterHook] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, rootId));
    expect(afterHook?.triggerCount).toBe(0);
    expect(watchdogWakes).toHaveLength(0);

    // Successor wake lands; the subtree is healthy.
    wakeGate.release();
    await waitForWake(companyId, reviewer);
    const [settled] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, rootId));
    expect(settled?.triggerCount).toBe(0);
    const watchdogIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "task_watchdog")));
    expect(watchdogIssues).toHaveLength(0);
    const triggers = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(eq(activityLog.entityId, rootId), eq(activityLog.action, "issue.task_watchdog_triggered")));
    expect(triggers).toHaveLength(0);
  });
});
