import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  deliverReconciledExecutions,
  markExecutionReconciliation,
  settleUnrecoverableExecutions,
  validateExecutionReconciliation,
} from "../services/execution-recovery-resolution.js";
import { LEGACY_RECOVERY_CAUSE, terminalizeLegacyExecution } from "../services/legacy-execution-recovery.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping legacy conversation hold loop tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

/**
 * A restart interrupts a claude_local (legacy) run. Two periodic passes then
 * meet the same run: stranded-work recovery (terminalizeLegacyExecution) opens
 * a board hold, and the conversation fold (settleUnrecoverableExecutions)
 * settles it as "send a new message to continue". The passes must agree that
 * the fold is the run's recorded decision, or the hold is re-created forever.
 */
describeEmbeddedPostgres("legacy conversation hold after a restart-interrupted run", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-legacy-conversation-hold-loop-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedInterruptedConversationRun() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Loop Co", issuePrefix: `L${companyId.slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Developer", role: "engineer", status: "idle", adapterType: "claude_local",
      adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true } },
      permissions: { canCreateAgents: false, canAssignTasks: true },
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Interrupted by restart", status: "in_progress", priority: "high",
      assigneeAgentId: agentId,
    });
    const startedAt = new Date(Date.now() - 120_000);
    // The shape observed live: interrupted by shutdown, no process, no
    // conversation-continuation policy on the result, adapter claimed at dispatch.
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, status: "interrupted", errorCode: "server_shutdown_interrupted",
      runtimeMode: "legacy", invocationSource: "assignment", triggerDetail: "system",
      startedAt, finishedAt: new Date(Date.now() - 60_000), processPid: null, processGroupId: null,
      runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
    });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    return { companyId, agentId, issueId, runId, run: run! };
  }

  const holdsFor = (companyId: string, issueId: string) => db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issueId),
  ));

  /** One stranded-work revisit, exactly as recovery/service.ts re-asserts the run. */
  async function strandedWorkPass(runId: string) {
    const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    await terminalizeLegacyExecution({ db, run: current!, status: current!.status, fromStatuses: [current!.status] });
  }

  it("settles the hold once and does not re-create it on later cycles, without replaying the run", async () => {
    const { companyId, issueId, runId } = await seedInterruptedConversationRun();

    for (let cycle = 0; cycle < 3; cycle += 1) {
      await strandedWorkPass(runId);
      await settleUnrecoverableExecutions(db);
    }

    const holds = await holdsFor(companyId, issueId);
    expect(holds).toHaveLength(1);
    expect(holds.filter(hold => ["active", "escalated"].includes(hold.status))).toHaveLength(0);
    expect(holds[0]).toMatchObject({
      status: "resolved",
      outcome: "cancelled",
      cause: LEGACY_RECOVERY_CAUSE,
      fingerprint: `legacy-execution:${runId}`,
      nextAction: "Automatic attempts stopped. Send a new message to continue the conversation.",
    });
    expect(holds[0]!.evidence).toMatchObject({
      runId,
      conversationSettlement: { runId, policy: "continue_conversation_v1", replay: "not_replayed" },
    });
    expect(holds[0]!.evidence.executionReconciliation).toBeUndefined();

    // No-replay: nothing re-ran the interrupted run's tool calls.
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    expect(runs.map(run => run.id)).toEqual([runId]);
    const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(task).toMatchObject({ status: "in_progress", executionRunId: null, checkoutRunId: null });
  });

  it("still opens a hold for a different interrupted run of the same task", async () => {
    const { companyId, agentId, issueId, runId } = await seedInterruptedConversationRun();
    await strandedWorkPass(runId);
    await settleUnrecoverableExecutions(db);

    const laterRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: laterRunId, companyId, agentId, status: "interrupted", errorCode: "server_shutdown_interrupted",
      runtimeMode: "legacy", invocationSource: "assignment", triggerDetail: "system",
      startedAt: new Date(), finishedAt: new Date(),
      runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented" },
    });
    await strandedWorkPass(laterRunId);

    const active = (await holdsFor(companyId, issueId)).filter(hold => hold.status === "active");
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ fingerprint: `legacy-execution:${laterRunId}` });
  });

  it("keeps the board's restored reconciliation and still delivers its continuation", async () => {
    const { companyId, agentId, issueId, runId } = await seedInterruptedConversationRun();
    await strandedWorkPass(runId);
    const [hold] = await holdsFor(companyId, issueId);
    expect(hold).toMatchObject({ status: "active" });

    // What the board resolve route does for `restored` + `todo` + executionReconciliation.
    const decision = {
      runId, providerStopped: true, actionOutcome: "not_performed" as const,
      outcomeEvidence: "Board verified the stopped provider and its actions.",
    };
    await validateExecutionReconciliation({ db, companyId, issueId, agentId, sourceRunId: runId, decision });
    await markExecutionReconciliation(db, hold!, decision, "board-operator");
    await db.update(issueRecoveryActions).set({ status: "resolved", outcome: "restored", resolvedAt: new Date() })
      .where(eq(issueRecoveryActions.id, hold!.id));
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, issueId));

    for (let cycle = 0; cycle < 2; cycle += 1) {
      await strandedWorkPass(runId);
      await settleUnrecoverableExecutions(db);
    }

    const holds = await holdsFor(companyId, issueId);
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ id: hold!.id, status: "resolved", outcome: "restored" });
    expect(holds[0]!.evidence).toMatchObject({ continuationDelivery: "pending", executionReconciliation: { runId } });
    expect(holds[0]!.evidence.conversationSettlement).toBeUndefined();

    const wakes: unknown[] = [];
    await deliverReconciledExecutions(db, (async (...args: unknown[]) => {
      wakes.push(args);
      return null;
    }) as never);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject([agentId, { reason: "issue_recovery_action_restored",
      contextSnapshot: { issueId, previousRunId: runId } }]);
  });
});
