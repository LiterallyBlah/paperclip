import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import {
  issueTreeControlService,
  SUBTREE_CANCEL_OPERATION_WAKE_CANCEL_REASON,
  SUBTREE_PAUSE_HOLD_WAKE_CANCEL_REASON,
} from "../services/issue-tree-control.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Pause-hold review stage run.",
    provider: "test",
    model: "test-model",
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
  console.warn(`Skipping pause-hold stage wake tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

const STAGE_WAKE_REASON = "execution_review_requested";
const HOLD_CAUSE = "legacy_execution_requires_reconciliation";
const AGENT_WAIT = {
  reason: "execution_recovery", message: "Waiting for execution recovery. Your message is saved.",
} as const;
const USER_WAIT = {
  reason: "source_unavailable",
  message: "The previous execution has not finished or its owner changed. Your message is saved.",
} as const;

type CommentAuthor = "agent" | "user";

/**
 * Two stranded first-pass reviews, each built from the rows of a live task.
 * The reviewer's stage wake was ended `skipped` by the executor's no-replay
 * hold. Comment wakes for the reviewer were then parked behind that hold. A
 * subtree pause hold on the parent tree cancelled every parked comment wake
 * (no run), and was later released. A newer comment wake is parked now.
 *
 * - `one-cancelled-agent-comment`: one cancelled agent comment wake.
 * - `four-cancelled-mixed-comments`: four cancelled comment wakes from a board
 *   user and the executor, alternating wait reasons.
 */
const SHAPES: Array<{ name: string; cancelled: CommentAuthor[]; current: CommentAuthor }> = [
  { name: "one-cancelled-agent-comment", cancelled: ["agent"], current: "agent" },
  { name: "four-cancelled-mixed-comments", cancelled: ["user", "agent", "agent", "user"], current: "user" },
];

describeEmbeddedPostgres("lost review stage wake behind pause-hold-cancelled comment wakes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-review-stage-pause-hold-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
    mockAdapterExecute.mockClear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedLostStageWake() {
    const companyId = randomUUID();
    const executorId = randomUUID();
    const participantId = randomUUID();
    const rootIssueId = randomUUID();
    const issueId = randomUUID();
    const executorRunId = randomUUID();
    const stageId = randomUUID();
    const holdId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Pause Hold Co", issuePrefix: `P${companyId.slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const agentRow = (id: string, name: string, role: string) => ({
      id, companyId, name, role, status: "idle", adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true } },
      permissions: { canCreateAgents: false, canAssignTasks: true },
    });
    await db.insert(agents).values([agentRow(executorId, "Executor", "cto"), agentRow(participantId, "Reviewer", "qa")]);
    const ownerId = `owner-${companyId}`;
    await db.insert(authUsers).values({ id: ownerId, name: "Fixture owner", email: `${ownerId}@example.test`,
      createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: ownerId, status: "active", membershipRole: "owner",
    });
    const participant = { type: "agent", userId: null, agentId: participantId };
    const returnAssignee = { type: "agent", userId: null, agentId: executorId };
    const executionState = {
      status: "pending", monitor: null, reviewRequest: null, currentStageId: stageId, lastDecisionId: null,
      returnAssignee, currentStageType: "review", completedStageIds: [], currentStageIndex: 0,
      currentParticipant: participant, lastDecisionOutcome: null, changesRequestedCount: 0,
    };
    await db.insert(issues).values({
      id: rootIssueId, companyId, title: "Parent tree", status: "in_progress", priority: "high",
      assigneeAgentId: executorId, createdByUserId: ownerId,
    });
    await db.insert(issues).values({
      id: issueId, companyId, parentId: rootIssueId, title: "First-pass review", status: "in_review",
      priority: "high", assigneeAgentId: participantId, createdByUserId: ownerId, executionState,
      executionPolicy: {
        mode: "normal", commentRequired: true,
        stages: [{ id: stageId, type: "review", approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: participantId, userId: null }] }],
      },
    });
    // The executor's run, stopped by its own hand-off (no process, stop confirmed).
    const startedAt = new Date(Date.now() - 60 * 60_000);
    const stoppedAt = new Date(Date.now() - 55 * 60_000);
    await db.insert(heartbeatRuns).values({
      id: executorRunId, companyId, agentId: executorId, issueId, status: "cancelled", runtimeMode: "legacy",
      invocationSource: "automation", triggerDetail: "system", startedAt, finishedAt: stoppedAt,
      createdAt: startedAt, updatedAt: stoppedAt, errorCode: "issue_reassigned", error: "Cancelled before issue reassignment",
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_children_completed" },
      resultJson: {
        issueMutationStopId: randomUUID(), reassignmentStopConfirmed: true,
        executionCancellation: { state: "requested", requestedAt: stoppedAt.toISOString() },
      },
    });
    await db.insert(issueRecoveryActions).values({
      id: holdId, companyId, sourceIssueId: issueId, kind: "active_run_watchdog", status: "resolved",
      outcome: "blocked", ownerType: "board", returnOwnerAgentId: executorId, cause: HOLD_CAUSE,
      fingerprint: `legacy-execution:${executorRunId}`, attemptCount: 1, maxAttempts: 3,
      evidence: { runId: executorRunId, attempt: 1, adapterRecovery: "unsupported_or_unknown",
        originalFailureCode: "issue_reassigned",
        automaticRecovery: { runId: executorRunId, policy: "preserve_without_replay_v1", replay: "blocked",
          actionOutcome: "unknown", recordedAt: stoppedAt.toISOString() } },
      nextAction: "Automatic recovery stopped. Recorded work is preserved; actions with unverified outcomes will not be repeated.",
      resolvedAt: stoppedAt, lastAttemptAt: stoppedAt, createdAt: stoppedAt, updatedAt: stoppedAt,
    });
    const executionStage = {
      stageId, wakeRole: "reviewer", stageType: "review", reviewRequest: null,
      allowedActions: ["approve", "request_changes"], returnAssignee, currentParticipant: participant,
      lastDecisionOutcome: null,
    };
    const [lost] = await db.insert(agentWakeupRequests).values({
      companyId, agentId: participantId, source: "assignment", triggerDetail: "system",
      reason: "execution_reconciliation_required", status: "skipped",
      error: "Automatic recovery stopped. Recorded work is preserved; actions with unverified outcomes will not be repeated.",
      requestedByActorType: "agent", requestedByActorId: executorId,
      requestedAt: stoppedAt, finishedAt: stoppedAt, createdAt: stoppedAt, updatedAt: stoppedAt,
      payload: {
        issueId, mutation: "update", interruptedRunId: executorRunId, executionStage,
        executionWait: { ...AGENT_WAIT, recoveryActionId: holdId, requestedIdempotencyKey: null },
        _paperclipWakeContext: { source: "issue.execution_stage", taskId: issueId, issueId, taskKey: issueId,
          wakeReason: STAGE_WAKE_REASON, wakeSource: "assignment", executionStage },
      },
    }).returning();
    return { companyId, executorId, participantId, ownerId, rootIssueId, issueId, executorRunId, stageId, holdId,
      executionState, lostWakeId: lost!.id, minutesAgo: 50 };
  }

  type Seeded = Awaited<ReturnType<typeof seedLostStageWake>>;

  /** A comment wake for the reviewer, parked behind the executor's hold. */
  async function parkCommentWake(s: Seeded, author: CommentAuthor) {
    const commentedAt = new Date(Date.now() - s.minutesAgo-- * 60_000);
    const [comment] = await db.insert(issueComments).values({
      companyId: s.companyId, issueId: s.issueId, body: "A note for the review.",
      createdAt: commentedAt, updatedAt: commentedAt,
      ...(author === "agent" ? { authorAgentId: s.executorId, authorType: "agent" }
        : { authorUserId: s.ownerId, authorType: "user" }),
    }).returning();
    const [wake] = await db.insert(agentWakeupRequests).values({
      companyId: s.companyId, agentId: s.participantId, source: "automation", triggerDetail: "system",
      reason: "issue_commented", status: "deferred_issue_execution",
      requestedByActorType: author, requestedByActorId: author === "agent" ? s.executorId : s.ownerId,
      requestedAt: commentedAt, createdAt: commentedAt, updatedAt: commentedAt,
      payload: {
        issueId: s.issueId, mutation: "comment", commentId: comment!.id,
        executionWait: { ...(author === "agent" ? AGENT_WAIT : USER_WAIT), recoveryActionId: s.holdId },
        _paperclipWakeContext: { source: "issue.comment", taskId: s.issueId, issueId: s.issueId, taskKey: s.issueId,
          commentId: comment!.id, wakeReason: "issue_commented", wakeSource: "automation",
          wakeCommentId: comment!.id, wakeCommentIds: [comment!.id], wakeTriggerDetail: "system" },
      },
    }).returning();
    return wake!;
  }

  const actor = (s: Seeded) => ({ actorType: "user" as const, actorId: s.ownerId, userId: s.ownerId });

  /**
   * What creating a subtree hold does to the parked wakes: the route cancels
   * every unclaimed wake in the tree with the mode's reason.
   */
  async function createSubtreeHold(s: Seeded, mode: "pause" | "cancel") {
    const treeControl = issueTreeControlService(db);
    const { hold } = await treeControl.createHold(s.companyId, s.rootIssueId, { mode, actor: actor(s) });
    const cancelled = await treeControl.cancelUnclaimedWakeupsForTree(s.companyId, s.rootIssueId,
      mode === "pause" ? SUBTREE_PAUSE_HOLD_WAKE_CANCEL_REASON : SUBTREE_CANCEL_OPERATION_WAKE_CANCEL_REASON);
    return { hold, cancelled };
  }

  async function releaseSubtreeHold(s: Seeded, holdId: string) {
    await issueTreeControlService(db).releaseHold(s.companyId, s.rootIssueId, holdId, { actor: actor(s) });
  }

  /** Lost stage wake, pause-hold-cancelled comment wakes, hold released, a current parked comment wake. */
  async function seedShape(shape: (typeof SHAPES)[number]) {
    const s = await seedLostStageWake();
    const parked = [];
    for (const author of shape.cancelled) parked.push(await parkCommentWake(s, author));
    const { hold, cancelled } = await createSubtreeHold(s, "pause");
    expect(cancelled.map(row => row.id).sort()).toEqual(parked.map(row => row.id).sort());
    await releaseSubtreeHold(s, hold.id);
    const current = await parkCommentWake(s, shape.current);
    return { ...s, cancelledIds: parked.map(row => row.id), currentId: current.id };
  }

  const runsFor = (s: Seeded, agentId: string) => db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, s.companyId), eq(heartbeatRuns.agentId, agentId),
    sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${s.issueId}`,
  ));
  const stageRunsFor = async (s: Seeded) => (await runsFor(s, s.participantId))
    .filter(run => (run.contextSnapshot as Record<string, unknown>).source === "issue.execution_stage");
  const readmitsFor = (s: Seeded) => db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, s.companyId),
    eq(agentWakeupRequests.idempotencyKey, `execution-stage-readmit:${s.lostWakeId}`),
  ));
  const holdsFor = (s: Seeded) => db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, s.companyId), eq(issueRecoveryActions.sourceIssueId, s.issueId),
  ));
  const issueRow = async (s: Seeded) => (await db.select().from(issues).where(eq(issues.id, s.issueId)))[0]!;
  const wakeRow = async (id: string) => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id)))[0]!;

  describe.each(SHAPES)("$name", (shape) => {
    it("re-admits the lost stage wake exactly once, and a second sweep admits nothing", async () => {
      const s = await seedShape(shape);
      const heartbeat = heartbeatService(db);
      for (const id of s.cancelledIds) {
        expect(await wakeRow(id)).toMatchObject({ status: "cancelled", runId: null,
          error: SUBTREE_PAUSE_HOLD_WAKE_CANCEL_REASON });
      }
      const before = await issueRow(s);
      const holdBefore = await holdsFor(s);
      const lostBefore = await wakeRow(s.lostWakeId);
      expect(before).toMatchObject({ executionRunId: null, checkoutRunId: null });
      expect(await getExecutionBlocker(db, s.companyId, s.issueId)).toMatchObject({ cause: HOLD_CAUSE });
      expect(await getExecutionBlocker(db, s.companyId, s.issueId, { admittingAgentId: s.participantId })).toBeNull();

      await heartbeat.reconcileStrandedAssignedIssues();
      const runs = await stageRunsFor(s);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.contextSnapshot).toMatchObject({ wakeReason: STAGE_WAKE_REASON,
        executionStage: { stageId: s.stageId, currentParticipant: { agentId: s.participantId } } });
      expect(await readmitsFor(s)).toHaveLength(1);

      // Stage, participant, counter, hold, the lost receipt and the cancelled wakes are unchanged.
      const after = await issueRow(s);
      expect(after).toMatchObject({ status: "in_review", assigneeAgentId: s.participantId });
      expect(after.executionState).toEqual(before.executionState);
      expect(await holdsFor(s)).toEqual(holdBefore);
      expect(await wakeRow(s.lostWakeId)).toEqual(lostBefore);
      for (const id of s.cancelledIds) {
        expect(await wakeRow(id)).toMatchObject({ status: "cancelled", runId: null });
      }
      // No replay: the executor gets no run.
      expect((await runsFor(s, s.executorId)).map(run => run.id)).toEqual([s.executorRunId]);

      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      expect((await stageRunsFor(s)).map(run => [run.status, run.errorCode])).toEqual([["succeeded", null]]);
      // The current parked comment is delivered by a reviewer run, not stranded.
      const current = await wakeRow(s.currentId);
      expect(current.status).not.toBe("deferred_issue_execution");
      expect(current.runId).not.toBeNull();

      await heartbeat.reconcileStrandedAssignedIssues();
      await heartbeat.resumeQueuedRuns();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      expect(await stageRunsFor(s)).toHaveLength(1);
      expect(await readmitsFor(s)).toHaveLength(1);
    });
  });

  it("keeps deferring while the subtree pause hold is active, then re-admits once after release", async () => {
    const s = await seedLostStageWake();
    const parked = await parkCommentWake(s, "agent");
    const { hold } = await createSubtreeHold(s, "pause");
    expect(await wakeRow(parked.id)).toMatchObject({ status: "cancelled", error: SUBTREE_PAUSE_HOLD_WAKE_CANCEL_REASON });
    const heartbeat = heartbeatService(db);

    await heartbeat.reconcileStrandedAssignedIssues();
    await heartbeat.reconcileStrandedAssignedIssues();
    expect(await stageRunsFor(s)).toHaveLength(0);
    expect(await readmitsFor(s)).toHaveLength(0);

    await releaseSubtreeHold(s, hold.id);
    await heartbeat.reconcileStrandedAssignedIssues();
    expect(await stageRunsFor(s)).toHaveLength(1);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await heartbeat.reconcileStrandedAssignedIssues();
    expect(await stageRunsFor(s)).toHaveLength(1);
    expect(await readmitsFor(s)).toHaveLength(1);
  });

  it("does not re-admit when a subtree cancel operation cancelled the later wake", async () => {
    const s = await seedLostStageWake();
    const parked = await parkCommentWake(s, "agent");
    // Only the wake rows of the cancel operation; the issue stays in review.
    await issueTreeControlService(db).cancelUnclaimedWakeupsForTree(s.companyId, s.rootIssueId,
      SUBTREE_CANCEL_OPERATION_WAKE_CANCEL_REASON);
    expect(await wakeRow(parked.id)).toMatchObject({ status: "cancelled", runId: null,
      error: SUBTREE_CANCEL_OPERATION_WAKE_CANCEL_REASON });
    await heartbeatService(db).reconcileStrandedAssignedIssues();
    expect(await stageRunsFor(s)).toHaveLength(0);
    expect(await readmitsFor(s)).toHaveLength(0);
  });

  const supersedingCancellations: Array<[string, string | null]> = [
    ["an operator Stop", "Cancelled by operator"],
    ["a budget pause", "Cancelled due to budget pause"],
    ["an agent cancellation", "Cancelled because the agent was paused"],
    ["a cancellation with no recorded reason", null],
    ["a near-copy of the pause hold reason", `${SUBTREE_PAUSE_HOLD_WAKE_CANCEL_REASON}.`],
  ];

  it.each(supersedingCancellations)("does not re-admit when %s cancelled the later wake", async (_label, error) => {
    const s = await seedLostStageWake();
    const parked = await parkCommentWake(s, "agent");
    await db.update(agentWakeupRequests).set({ status: "cancelled", error, finishedAt: new Date() })
      .where(eq(agentWakeupRequests.id, parked.id));
    await heartbeatService(db).reconcileStrandedAssignedIssues();
    expect(await stageRunsFor(s)).toHaveLength(0);
    expect(await readmitsFor(s)).toHaveLength(0);
  });

  it("does not re-admit when the pause-hold-cancelled wake had a run", async () => {
    const s = await seedLostStageWake();
    const parked = await parkCommentWake(s, "agent");
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: s.companyId, agentId: s.participantId, status: "cancelled", runtimeMode: "legacy",
      invocationSource: "automation", triggerDetail: "system", errorCode: "operator_interrupted",
      contextSnapshot: { issueId: randomUUID(), wakeReason: "issue_commented" },
    }).returning();
    await db.update(agentWakeupRequests).set({ status: "cancelled", runId: run!.id, finishedAt: new Date(),
      error: SUBTREE_PAUSE_HOLD_WAKE_CANCEL_REASON }).where(eq(agentWakeupRequests.id, parked.id));
    await heartbeatService(db).reconcileStrandedAssignedIssues();
    expect(await stageRunsFor(s)).toHaveLength(0);
    expect(await readmitsFor(s)).toHaveLength(0);
  });

  it("does not re-admit when the reviewer ran on the task after the lost stage wake", async () => {
    const s = await seedLostStageWake();
    await parkCommentWake(s, "agent");
    const { hold } = await createSubtreeHold(s, "pause");
    await releaseSubtreeHold(s, hold.id);
    const ranAt = new Date(Date.now() - 20 * 60_000);
    await db.insert(heartbeatRuns).values({
      companyId: s.companyId, agentId: s.participantId, status: "succeeded", runtimeMode: "legacy",
      invocationSource: "automation", triggerDetail: "system", startedAt: ranAt, finishedAt: ranAt,
      createdAt: ranAt, updatedAt: ranAt,
      contextSnapshot: { issueId: s.issueId, taskId: s.issueId, wakeReason: "issue_commented" },
    });
    await heartbeatService(db).reconcileStrandedAssignedIssues();
    expect(await stageRunsFor(s)).toHaveLength(0);
    expect(await readmitsFor(s)).toHaveLength(0);
  });
});
