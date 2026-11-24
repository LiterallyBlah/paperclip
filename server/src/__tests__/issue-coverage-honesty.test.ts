import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { listDeferredWakeIdsBehindHold } from "../services/execution-blocker.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres coverage honesty tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * Coverage must describe a path that can actually continue the task. A deferred
 * wake parked behind a recovery hold never runs, so it is not coverage; the
 * same wake without a hold, a live run, a queued wake and a future monitor are.
 */
describeEmbeddedPostgres("issue coverage honesty: deferred wakes behind a recovery hold", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-coverage-honesty-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueThreadInteractions);
    await db.delete(issueRecoveryActions);
    await db.delete(issueRelations);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(prefix: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Coverage ${prefix}`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({ id: agentId, companyId, name: `${prefix} Agent`, role: "engineer", status: "idle" });
    return { companyId, agentId };
  }

  async function insertIssue(input: {
    companyId: string;
    agentId: string;
    identifier: string;
    status: string;
    monitorNextCheckAt?: Date | null;
    executionPolicy?: Record<string, unknown> | null;
  }) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      identifier: input.identifier,
      title: input.identifier,
      status: input.status,
      priority: "medium",
      assigneeAgentId: input.agentId,
      monitorNextCheckAt: input.monitorNextCheckAt ?? null,
      executionPolicy: input.executionPolicy ?? null,
    });
    return id;
  }

  async function deferredWake(companyId: string, agentId: string, issueId: string, status = "deferred_issue_execution") {
    const [row] = await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      reason: "issue_commented",
      status,
      payload: { issueId },
    }).returning({ id: agentWakeupRequests.id });
    return row!.id;
  }

  /**
   * The effective no-replay hold: the recovery bookkeeping is resolved, but its
   * automatic replay stayed blocked, so admission still refuses every wake.
   */
  async function blockingHold(companyId: string, issueId: string) {
    await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: issueId,
      kind: "execution_reconciliation",
      status: "resolved",
      ownerType: "board",
      cause: "uncertain_external_action",
      fingerprint: `hold:${issueId}`,
      evidence: { automaticRecovery: { replay: "blocked" } },
      nextAction: "Reconcile the uncertain external action before continuing.",
      resolvedAt: new Date(),
    });
  }

  async function reviewAttention(companyId: string, issueId: string) {
    return ((await svc.list(companyId, { status: "in_review" })).find((row) => row.id === issueId) as { reviewAttention?: unknown } | undefined)?.reviewAttention;
  }

  async function blockerAttention(companyId: string, issueId: string) {
    return ((await svc.list(companyId, { status: "blocked" })).find((row) => row.id === issueId) as { blockerAttention?: unknown } | undefined)?.blockerAttention;
  }

  it("identifies only the deferred wake a recovery hold keeps from running", async () => {
    const { companyId, agentId } = await seed("CVH");
    const heldIssueId = await insertIssue({ companyId, agentId, identifier: "CVH-1", status: "in_progress" });
    const freeIssueId = await insertIssue({ companyId, agentId, identifier: "CVH-2", status: "in_progress" });
    await blockingHold(companyId, heldIssueId);
    const held = await deferredWake(companyId, agentId, heldIssueId);
    const queuedBehindHold = await deferredWake(companyId, agentId, heldIssueId, "queued");
    const free = await deferredWake(companyId, agentId, freeIssueId);

    const behind = await listDeferredWakeIdsBehindHold(db, companyId, [
      { id: held, issueId: heldIssueId, agentId, status: "deferred_issue_execution" },
      { id: queuedBehindHold, issueId: heldIssueId, agentId, status: "queued" },
      { id: free, issueId: freeIssueId, agentId, status: "deferred_issue_execution" },
    ]);

    expect([...behind]).toEqual([held]);
  });

  describe("review attention", () => {
    it("reports a review whose only path is a deferred wake behind a hold as stalled", async () => {
      const { companyId, agentId } = await seed("CVR");
      const issueId = await insertIssue({ companyId, agentId, identifier: "CVR-1", status: "in_review" });
      await blockingHold(companyId, issueId);
      await deferredWake(companyId, agentId, issueId);

      expect(await reviewAttention(companyId, issueId)).toMatchObject({ state: "stalled", paths: [] });
    });

    it("keeps a deferred wake with no hold as a covered queued_wake path", async () => {
      const { companyId, agentId } = await seed("CVS");
      const issueId = await insertIssue({ companyId, agentId, identifier: "CVS-1", status: "in_review" });
      await deferredWake(companyId, agentId, issueId);

      expect(await reviewAttention(companyId, issueId)).toMatchObject({
        state: "covered",
        paths: [expect.objectContaining({ kind: "queued_wake" })],
      });
    });

    it("keeps a live run, a queued wake and a future monitor covered even behind a hold", async () => {
      const { companyId, agentId } = await seed("CVT");
      const runIssueId = await insertIssue({ companyId, agentId, identifier: "CVT-1", status: "in_review" });
      const queuedIssueId = await insertIssue({ companyId, agentId, identifier: "CVT-2", status: "in_review" });
      const nextCheckAt = new Date(Date.now() + 60 * 60_000);
      const monitorIssueId = await insertIssue({
        companyId,
        agentId,
        identifier: "CVT-3",
        status: "in_review",
        monitorNextCheckAt: nextCheckAt,
        executionPolicy: { monitor: { nextCheckAt: nextCheckAt.toISOString(), notes: "check CI", maxAttempts: 3 } },
      });
      for (const issueId of [runIssueId, queuedIssueId, monitorIssueId]) {
        await blockingHold(companyId, issueId);
        await deferredWake(companyId, agentId, issueId);
      }
      await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", contextSnapshot: { issueId: runIssueId } });
      await deferredWake(companyId, agentId, queuedIssueId, "queued");

      expect(await reviewAttention(companyId, runIssueId)).toMatchObject({
        state: "covered",
        paths: [expect.objectContaining({ kind: "active_run" })],
      });
      expect(await reviewAttention(companyId, queuedIssueId)).toMatchObject({
        state: "covered",
        paths: [expect.objectContaining({ kind: "queued_wake" })],
      });
      expect(await reviewAttention(companyId, monitorIssueId)).toMatchObject({
        state: "covered",
        paths: [expect.objectContaining({ kind: "monitor" })],
      });
    });
  });

  describe("blocker attention", () => {
    it("does not let a held deferred wake cover a blocked task with no open blocker", async () => {
      const { companyId, agentId } = await seed("CVB");
      const issueId = await insertIssue({ companyId, agentId, identifier: "CVB-1", status: "blocked" });
      await blockingHold(companyId, issueId);
      await deferredWake(companyId, agentId, issueId);

      expect(await blockerAttention(companyId, issueId)).toMatchObject({
        state: "needs_attention",
        blockingTreeLive: false,
        terminalBlockerIssueId: issueId,
      });
    });

    it("still covers a blocked task whose deferred wake has no hold", async () => {
      const { companyId, agentId } = await seed("CVC");
      const issueId = await insertIssue({ companyId, agentId, identifier: "CVC-1", status: "blocked" });
      await deferredWake(companyId, agentId, issueId);

      expect(await blockerAttention(companyId, issueId)).toMatchObject({ state: "covered", blockingTreeLive: true });
    });

    it("surfaces a blocker leaf whose only continuation is a held deferred wake", async () => {
      const { companyId, agentId } = await seed("CVD");
      const parentId = await insertIssue({ companyId, agentId, identifier: "CVD-1", status: "blocked" });
      const leafId = await insertIssue({ companyId, agentId, identifier: "CVD-2", status: "todo" });
      await db.insert(issueRelations).values({ companyId, issueId: leafId, relatedIssueId: parentId, type: "blocks" });
      await blockingHold(companyId, leafId);
      await deferredWake(companyId, agentId, leafId);

      expect(await blockerAttention(companyId, parentId)).toMatchObject({
        state: "needs_attention",
        blockingTreeLive: false,
      });

      // The same leaf with a wake the hold does not park stays covered.
      await db.delete(issueRecoveryActions);
      expect(await blockerAttention(companyId, parentId)).toMatchObject({ state: "covered", blockingTreeLive: true });
    });

    it("lists a held-wake blocked task in the blocked inbox, and drops it once the hold clears", async () => {
      const { companyId, agentId } = await seed("CVI");
      const parentId = await insertIssue({ companyId, agentId, identifier: "CVI-1", status: "blocked" });
      const leafId = await insertIssue({ companyId, agentId, identifier: "CVI-2", status: "todo" });
      await db.insert(issueRelations).values({ companyId, issueId: leafId, relatedIssueId: parentId, type: "blocks" });
      await blockingHold(companyId, leafId);
      await deferredWake(companyId, agentId, leafId);

      const held = await svc.list(companyId, { attention: "blocked" });
      expect(held.map((row) => row.id)).toContain(parentId);

      await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, leafId));
      expect(await svc.list(companyId, { attention: "blocked" })).toEqual([]);
    });
  });
});
