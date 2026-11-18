import { randomUUID } from "node:crypto";
import fs from "node:fs";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0, signal: null, timedOut: false, errorMessage: null,
    summary: "Stage guard test run.", provider: "test", model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping stage-participant guard tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

type Actor = Record<string, unknown>;

/** Set STAGE_GUARD_REPRO_LOG to a file path to record each variant's outcome (base-vs-fix evidence). */
function reproLog(...parts: unknown[]) {
  const file = process.env.STAGE_GUARD_REPRO_LOG;
  if (file) fs.appendFileSync(file, `${parts.map(String).join(" ")}\n`);
}
type AgentKey = "developer" | "reviewer" | "other" | "manager";

/**
 * BLA-1616 Part A: while a stage is pending or changes_requested, only the
 * board, the current participant, or (for an agent participant) a manager of
 * that agent may clear the policy, remove the current stage, or drop the
 * current participant. Every variant logs `[stage-guard]` lines with the
 * status and resulting execution state, so a run on the base records the
 * bypass and a run on the fix records the refusal.
 */
describeEmbeddedPostgres("execution stage participant guard (routes, real database)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stage-guard-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(actor: Actor) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use(errorHandler);
    return testApp;
  }

  const boardActor = (companyId: string, userId: string, extra: Actor = {}): Actor => ({
    type: "board", userId, source: "session", companyIds: [companyId], isInstanceAdmin: false,
    memberships: [{ companyId, status: "active", membershipRole: "owner" }], ...extra,
  });
  const agentActor = (companyId: string, agentId: string, runId: string): Actor => ({
    type: "agent", agentId, runId, companyId, source: "agent_jwt",
    companyIds: [companyId], memberships: [], isInstanceAdmin: false,
  });

  async function seed(options: { holder: "user" | "agent"; status?: "pending" | "changes_requested" }) {
    const companyId = randomUUID();
    const ids: Record<AgentKey, string> = {
      developer: randomUUID(), reviewer: randomUUID(), other: randomUUID(), manager: randomUUID(),
    };
    const issueId = randomUUID();
    const stageId = randomUUID();
    const ownerUserId = `owner-${companyId}`;
    const reviewerUserId = `reviewer-${companyId}`;
    await db.insert(companies).values({
      id: companyId, name: "G Co", issuePrefix: `G${companyId.slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const agentRow = (id: string, name: string, role: string, extra: Record<string, unknown> = {}) => ({
      id, companyId, name, role, status: "idle", adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true } },
      permissions: { canCreateAgents: false, canAssignTasks: true }, ...extra,
    });
    await db.insert(agents).values([
      agentRow(ids.manager, "Manager", "cto"),
      agentRow(ids.developer, "Developer", "engineer", { reportsTo: ids.manager }),
      agentRow(ids.reviewer, "Reviewer", "qa", { reportsTo: ids.manager }),
      agentRow(ids.other, "Other", "engineer"),
    ]);
    for (const userId of [ownerUserId, reviewerUserId]) {
      await db.insert(authUsers).values({ id: userId, name: userId, email: `${userId}@example.test`,
        createdAt: new Date(), updatedAt: new Date() });
    }
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: ownerUserId, status: "active", membershipRole: "owner" },
      { companyId, principalType: "user", principalId: reviewerUserId, status: "active", membershipRole: "member" },
    ]);
    const participant = options.holder === "user"
      ? { type: "user", agentId: null, userId: reviewerUserId }
      : { type: "agent", agentId: ids.reviewer, userId: null };
    const status = options.status ?? "pending";
    const returnAssignee = { type: "agent", agentId: ids.developer, userId: null };
    const executionState = {
      status, currentStageId: stageId, currentStageIndex: 0, currentStageType: "review",
      currentParticipant: participant, returnAssignee,
      reviewRequest: null, completedStageIds: [], lastDecisionId: null,
      lastDecisionOutcome: status === "changes_requested" ? "changes_requested" : null,
      monitor: null, changesRequestedCount: status === "changes_requested" ? 1 : 0,
    };
    const executionPolicy = {
      mode: "normal", commentRequired: true,
      stages: [{ id: stageId, type: "review", approvalsNeeded: 1,
        participants: [{ id: randomUUID(), ...participant }] }],
    };
    const assignee = status === "pending"
      ? (participant.type === "user" ? { assigneeUserId: reviewerUserId } : { assigneeAgentId: ids.reviewer })
      : { assigneeAgentId: ids.developer };
    await db.insert(issues).values({
      id: issueId, companyId, title: "Pending review", status: status === "pending" ? "in_review" : "in_progress",
      priority: "high", createdByAgentId: ids.manager, executionPolicy, executionState, ...assignee,
    });
    const runs: Record<string, string> = {};
    for (const key of ["developer", "reviewer", "other", "manager"] as const) {
      runs[key] = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runs[key], companyId, agentId: ids[key], status: "running", runtimeMode: "legacy",
        invocationSource: "assignment", triggerDetail: "system", startedAt: new Date(),
        contextSnapshot: { wakeReason: "issue_assigned" },
      });
    }
    const as = {
      board: () => app(boardActor(companyId, ownerUserId)),
      mcp: () => app(boardActor(companyId, ownerUserId, { source: "mcp_oauth" })),
      reviewerUser: () => app(boardActor(companyId, reviewerUserId, {
        memberships: [{ companyId, status: "active", membershipRole: "member" }] })),
      agent: (key: AgentKey) => app(agentActor(companyId, ids[key], runs[key]!)),
    };
    return { companyId, ids, issueId, stageId, executionState, executionPolicy, participant, as };
  }

  type Seeded = Awaited<ReturnType<typeof seed>>;

  const readIssue = async (s: Seeded) => (await db.select().from(issues).where(eq(issues.id, s.issueId)))[0]!;
  const snapshot = async (s: Seeded) => {
    const row = await readIssue(s);
    return JSON.stringify({
      status: row.status, assigneeAgentId: row.assigneeAgentId, assigneeUserId: row.assigneeUserId,
      executionState: row.executionState, executionPolicy: row.executionPolicy,
    });
  };

  const variants = (s: Seeded) => ({
    policy_cleared: null,
    stage_removed: {
      ...s.executionPolicy,
      stages: [{ ...s.executionPolicy.stages[0]!, id: randomUUID() }],
    },
    participant_removed: {
      ...s.executionPolicy,
      stages: [{ ...s.executionPolicy.stages[0]!,
        participants: [{ id: randomUUID(), type: "agent", agentId: s.ids.other, userId: null }] }],
    },
  });

  async function expectRefused(s: Seeded, actorApp: express.Express, label: string, policy: unknown, reason: string) {
    const before = await snapshot(s);
    const res = await request(actorApp).patch(`/api/issues/${s.issueId}`).send({ executionPolicy: policy });
    const after = await readIssue(s);
    reproLog("[stage-guard]", label, res.status, JSON.stringify(res.body?.details ?? null),
      JSON.stringify({ status: after.status, assigneeAgentId: after.assigneeAgentId,
        assigneeUserId: after.assigneeUserId, executionState: after.executionState }));
    // Soft, so a run on the base records every variant instead of stopping at the first.
    expect.soft(res.status, `${label}: ${JSON.stringify(res.body)}`).toBe(403);
    expect.soft(res.body.details ?? null, label).toMatchObject({ code: "execution_stage_participant_required", reason, stageId: s.stageId });
    expect.soft(await snapshot(s), label).toBe(before);
  }

  it("refuses a non-participant agent all three variants on a user-held pending stage", async () => {
    for (const reason of ["policy_cleared", "stage_removed", "participant_removed"] as const) {
      const s = await seed({ holder: "user" });
      await expectRefused(s, s.as.agent("other"), `user-held/${reason}`, variants(s)[reason], reason);
    }
  });

  it("refuses a non-participant agent clearing an agent-held stage and a changes_requested stage", async () => {
    const agentHeld = await seed({ holder: "agent" });
    await expectRefused(agentHeld, agentHeld.as.agent("other"), "agent-held/policy_cleared", null, "policy_cleared");
    const cr = await seed({ holder: "user", status: "changes_requested" });
    // The executor itself may not drop the re-review before resubmitting.
    await expectRefused(cr, cr.as.agent("developer"), "changes_requested/policy_cleared(executor)", null, "policy_cleared");
    // (Another agent is already stopped there by the executor's run lock, 409 issue_write_assignee_run_lock.)
    // MCP OAuth is not a board override.
    const mcp = await seed({ holder: "agent" });
    await expectRefused(mcp, mcp.as.mcp(), "agent-held/policy_cleared(mcp_oauth)", null, "policy_cleared");
    // A manager of someone other than the participant (the user) has no override on a user-held stage.
    const userHeld = await seed({ holder: "user" });
    await expectRefused(userHeld, userHeld.as.agent("manager"), "user-held/policy_cleared(manager)", null, "policy_cleared");
  });

  it("allows the board, the participant user, the participant agent and its manager", async () => {
    const cases: Array<[string, (s: Seeded) => express.Express, "user" | "agent"]> = [
      ["board", (s) => s.as.board(), "user"],
      ["participant user", (s) => s.as.reviewerUser(), "user"],
      ["participant agent", (s) => s.as.agent("reviewer"), "agent"],
      ["manager of participant agent", (s) => s.as.agent("manager"), "agent"],
    ];
    for (const [label, actorApp, holder] of cases) {
      const s = await seed({ holder });
      const res = await request(actorApp(s)).patch(`/api/issues/${s.issueId}`).send({ executionPolicy: null });
      expect(res.status, `${label}: ${JSON.stringify(res.body)}`).toBe(200);
      const after = await readIssue(s);
      expect(after.executionState, label).toBeNull();
      expect(after.executionPolicy, label).toBeNull();
    }
  });

  it("keeps edits that leave the current stage and participant in place", async () => {
    const s = await seed({ holder: "user" });
    const before = await readIssue(s);
    const laterStageId = randomUUID();
    const res = await request(s.as.agent("other")).patch(`/api/issues/${s.issueId}`).send({
      executionPolicy: {
        ...s.executionPolicy,
        stages: [
          { ...s.executionPolicy.stages[0]!,
            participants: [...s.executionPolicy.stages[0]!.participants,
              { id: randomUUID(), type: "agent", agentId: s.ids.other, userId: null }] },
          { id: laterStageId, type: "approval", approvalsNeeded: 1,
            participants: [{ id: randomUUID(), type: "agent", agentId: s.ids.manager, userId: null }] },
        ],
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = await readIssue(s);
    expect(after.executionState).toEqual(before.executionState);
    expect((after.executionPolicy as any).stages.map((stage: any) => stage.id)).toEqual([s.stageId, laterStageId]);

    // Monitor-only edit sent with the full policy, by the board (monitor management is gated separately).
    const m = await seed({ holder: "agent" });
    const mBefore = await readIssue(m);
    const nextCheckAt = new Date(Date.now() + 3_600_000).toISOString();
    const monitorRes = await request(m.as.board()).patch(`/api/issues/${m.issueId}`).send({
      executionPolicy: { ...m.executionPolicy, monitor: { nextCheckAt, notes: "check later" } },
    });
    expect(monitorRes.status, JSON.stringify(monitorRes.body)).toBe(200);
    const mAfter = await readIssue(m);
    expect((mAfter.executionState as any).currentStageId).toBe(m.stageId);
    expect((mAfter.executionState as any).currentParticipant).toEqual((mBefore.executionState as any).currentParticipant);
    expect((mAfter.executionPolicy as any).stages).toEqual(m.executionPolicy.stages);
  });
});
