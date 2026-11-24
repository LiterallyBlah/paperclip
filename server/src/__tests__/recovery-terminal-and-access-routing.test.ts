import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { createSystemRecovery } from "../services/system-recovery-state.js";
import { OWNER_UNPROVABLE_CAUSE } from "../services/recovery/owner-gone-attestation.js";
import { issueService } from "../services/issues.js";
import { recoveryService } from "../services/recovery/service.js";
import { resolveRecoveryOwner } from "../services/recovery/recovery-owner-routing.js";
import { backfillRecoveryCoordinatorOwners } from "../services/recovery/recovery-owner-backfill.js";

async function seedCompanyUser(
  db: ReturnType<typeof createDb>,
  companyId: string,
  membershipRole: string,
  userId = `user-${randomUUID()}`,
) {
  await db.insert(authUsers).values({ id: userId, name: "Synthetic user", email: `${randomUUID()}@example.test`, createdAt: new Date(), updatedAt: new Date() });
  await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole, status: "active" });
  return userId;
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("recovery actions: terminal source closure and readable owner routing", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-recovery-terminal-access-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await tempDb?.cleanup();
  });

  function agentRow(id: string, companyId: string, name: string, role: string, reportsTo: string | null = null) {
    return {
      id,
      companyId,
      name,
      role,
      status: "idle",
      reportsTo,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    } satisfies typeof agents.$inferInsert;
  }

  let issueCounter = 0;
  async function insertIssue(
    companyId: string,
    prefix: string,
    input: { assigneeAgentId: string | null; visibility?: "open" | "private"; responsibleUserId?: string | null; status?: string; parentId?: string | null },
  ) {
    const id = randomUUID();
    issueCounter += 1;
    await db.insert(issues).values({
      id,
      companyId,
      title: `Synthetic task ${issueCounter}`,
      status: input.status ?? "blocked",
      priority: "medium",
      assigneeAgentId: input.assigneeAgentId,
      visibility: input.visibility ?? "open",
      privacyRootIssueId: input.visibility === "private" ? id : null,
      responsibleUserId: input.responsibleUserId ?? null,
      parentId: input.parentId ?? null,
      issueNumber: issueCounter,
      identifier: `${prefix}-${issueCounter}`,
    });
    return id;
  }

  async function seed(input: { visibility?: "open" | "private"; responsibleUserId?: string | null } = {}) {
    const companyId = randomUUID();
    const ceoId = randomUUID();
    const workerId = randomUUID();
    const prefix = `RT${companyId.replace(/[^A-F0-9]/gi, "").slice(0, 4).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Synthetic Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    // Dispatch acts on behalf of a responsible user; with no direct one it
    // falls back to the company owner, so every synthetic company has one.
    const ownerUserId = await seedCompanyUser(db, companyId, "owner");
    await db.insert(agents).values([
      agentRow(ceoId, companyId, "Chief", "ceo"),
      agentRow(workerId, companyId, "Worker", "engineer", ceoId),
    ]);
    const sourceIssueId = await insertIssue(companyId, prefix, {
      assigneeAgentId: workerId,
      visibility: input.visibility,
      // A private task carries the user it runs for; that user is one of
      // its implicit principals.
      responsibleUserId: input.responsibleUserId !== undefined
        ? input.responsibleUserId
        : input.visibility === "private" ? ownerUserId : null,
    });
    return { companyId, ceoId, workerId, prefix, sourceIssueId, ownerUserId };
  }

  type Fixture = Awaited<ReturnType<typeof seed>>;

  function boardUpsert(fixture: Fixture, overrides: { sourceIssueId?: string; cause?: string } = {}) {
    const sourceIssueId = overrides.sourceIssueId ?? fixture.sourceIssueId;
    return issueRecoveryActionService(db).upsertSourceScoped({
      companyId: fixture.companyId,
      sourceIssueId,
      kind: "active_run_watchdog",
      ownerType: "board",
      previousOwnerAgentId: fixture.workerId,
      returnOwnerAgentId: fixture.workerId,
      cause: overrides.cause ?? "process_lost",
      fingerprint: `synthetic:${sourceIssueId}`,
      evidence: { runId: randomUUID() },
      nextAction: "Inspect the lost run and decide the next step.",
    });
  }

  async function actionRow(id: string) {
    return db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, id)).then((rows) => rows[0]!);
  }

  async function issueRow(id: string) {
    return db.select().from(issues).where(eq(issues.id, id)).then((rows) => rows[0]!);
  }

  describe("case 1: terminal source issue", () => {
    for (const [terminal, status, outcome] of [
      ["cancelled", "cancelled", "cancelled"],
      ["done", "resolved", "owner_completed"],
    ] as const) {
      it(`closes open actions when the source moves to ${terminal}, and no coordinator wake follows`, async () => {
        const fixture = await seed();
        const action = await boardUpsert(fixture);
        expect(action).toMatchObject({ ownerType: "agent", ownerAgentId: fixture.ceoId });

        await issueService(db).update(fixture.sourceIssueId, { status: terminal });

        const closed = await actionRow(action.id);
        expect(closed).toMatchObject({
          status,
          outcome,
          resolutionNote: "source_issue_terminal",
          ownerAgentId: fixture.ceoId,
          returnOwnerAgentId: fixture.workerId,
        });
        expect(closed.resolvedAt).toBeInstanceOf(Date);

        const enqueueWakeup = vi.fn(async (_agentId: string, _opts?: unknown) => null);
        await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();
        expect(enqueueWakeup.mock.calls.some(([agentId]) => agentId === fixture.ceoId)).toBe(false);
        // The source issue is not reopened.
        expect((await issueRow(fixture.sourceIssueId)).status).toBe(terminal);
      });
    }

    it("closes a stale open action on an already-cancelled issue in the re-wake path instead of waking it", async () => {
      const fixture = await seed();
      const action = await boardUpsert(fixture);
      // A row left open by a terminal transition that predates this fix.
      await db.update(issues).set({ status: "cancelled", cancelledAt: new Date() })
        .where(eq(issues.id, fixture.sourceIssueId));
      expect((await actionRow(action.id)).status).toBe("active");

      const enqueueWakeup = vi.fn(async (_agentId: string, _opts?: unknown) => null);
      await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();

      expect(enqueueWakeup).not.toHaveBeenCalled();
      expect(await actionRow(action.id)).toMatchObject({
        status: "cancelled",
        outcome: "cancelled",
        resolutionNote: "source_issue_terminal",
      });
      expect((await issueRow(fixture.sourceIssueId)).status).toBe("cancelled");
      expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    });
  });

  describe("case 1b: guarded rows outlive a terminal source", () => {
    async function insertGuardedAction(fixture: Fixture, sourceIssueId: string, guard: "owner_unprovable" | "system_in_flight") {
      const runId = randomUUID();
      const [row] = await db.insert(issueRecoveryActions).values({
        companyId: fixture.companyId,
        sourceIssueId,
        kind: "active_run_watchdog",
        status: "active",
        ownerType: "board",
        cause: guard === "owner_unprovable" ? OWNER_UNPROVABLE_CAUSE : "process_lost",
        fingerprint: `guarded:${sourceIssueId}`,
        evidence: guard === "system_in_flight"
          ? { runId, systemRecovery: createSystemRecovery(runId) }
          : { runId },
        nextAction: "Keep this hold open.",
      }).returning();
      return row!;
    }

    for (const guard of ["owner_unprovable", "system_in_flight"] as const) {
      for (const terminal of ["done", "cancelled"] as const) {
        it(`keeps a ${guard} row open when the source moves to ${terminal}, and through reconciliation`, async () => {
          const fixture = await seed();
          const guarded = await insertGuardedAction(fixture, fixture.sourceIssueId, guard);
          // An unguarded row on another source still closes in the same pass.
          const otherSourceId = await insertIssue(fixture.companyId, fixture.prefix, { assigneeAgentId: fixture.workerId });
          const unguarded = await boardUpsert(fixture, { sourceIssueId: otherSourceId });

          await issueService(db).update(fixture.sourceIssueId, { status: terminal });
          expect(await actionRow(guarded.id)).toMatchObject({ status: "active", resolvedAt: null });

          // A row left open on an already-terminal source, as the reconcile loop sees it.
          await db.update(issues).set({ status: terminal }).where(eq(issues.id, otherSourceId));
          const enqueueWakeup = vi.fn(async (_agentId: string, _opts?: unknown) => null);
          await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();

          expect(await actionRow(guarded.id)).toMatchObject({ status: "active", resolvedAt: null });
          expect(await actionRow(unguarded.id)).toMatchObject({
            status: terminal === "cancelled" ? "cancelled" : "resolved",
            resolutionNote: "source_issue_terminal",
          });
        });
      }
    }
  });

  describe("case 2: owner must be able to read the source issue", () => {
    it("routes a private issue the coordinator cannot read to the source assignee", async () => {
      const fixture = await seed({ visibility: "private" });
      const action = await boardUpsert(fixture);
      expect(action).toMatchObject({ ownerType: "agent", ownerAgentId: fixture.workerId, returnOwnerAgentId: fixture.workerId });
      expect(action.evidence.recoveryOwnerRouting).toMatchObject({
        coordinator: "assigned",
        agentId: fixture.workerId,
        source: "source_assignee",
        reason: "coordinator_no_access",
        coordinatorAgentId: fixture.ceoId,
      });

      const enqueueWakeup = vi.fn(async (_agentId: string, _opts?: unknown) => null);
      await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();
      expect(enqueueWakeup.mock.calls.some(([agentId]) => agentId === fixture.ceoId)).toBe(false);
      expect(enqueueWakeup.mock.calls.filter(([agentId]) => agentId === fixture.workerId)).toHaveLength(1);
    });

    it("keeps the board with coordinator_no_access when the assignee cannot read the issue either", async () => {
      // The run acts on behalf of a responsible user who is not a company
      // member, so neither the coordinator nor the assignee can read it.
      const fixture = await seed({ visibility: "private", responsibleUserId: `user-${randomUUID()}` });
      const action = await boardUpsert(fixture);
      expect(action).toMatchObject({ ownerType: "board", ownerAgentId: null, returnOwnerAgentId: fixture.workerId });
      expect(action.evidence.recoveryOwnerRouting).toMatchObject({
        coordinator: "unavailable",
        reason: "coordinator_no_access",
        coordinatorAgentId: fixture.ceoId,
      });
    });

    it("checks the inherited dispatch identity when the source has no direct responsible user", async () => {
      const fixture = await seed();
      // The parent's responsible user is a removed member: dispatch would run
      // on that user's behalf, so neither agent can actually read the task.
      const removedUserId = await seedCompanyUser(db, fixture.companyId, "member");
      await db.update(companyMemberships).set({ status: "suspended" })
        .where(eq(companyMemberships.principalId, removedUserId));
      const deniedParentId = await insertIssue(fixture.companyId, fixture.prefix, {
        assigneeAgentId: null, responsibleUserId: removedUserId,
      });
      const deniedSourceId = await insertIssue(fixture.companyId, fixture.prefix, {
        assigneeAgentId: fixture.workerId, parentId: deniedParentId,
      });
      const denied = await boardUpsert(fixture, { sourceIssueId: deniedSourceId });
      expect(denied).toMatchObject({ ownerType: "board", ownerAgentId: null });
      expect(denied.evidence.recoveryOwnerRouting).toMatchObject({
        coordinator: "unavailable",
        reason: "coordinator_no_access",
        coordinatorAgentId: fixture.ceoId,
      });
      const enqueueWakeup = vi.fn(async (_agentId: string, _opts?: unknown) => null);
      await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();
      expect(enqueueWakeup.mock.calls.some(([, opts]) =>
        (opts as { payload?: { recoveryActionId?: string } }).payload?.recoveryActionId === denied.id)).toBe(false);

      // The same shape with an active inherited user stays with the coordinator.
      const activeUserId = await seedCompanyUser(db, fixture.companyId, "member");
      const readableParentId = await insertIssue(fixture.companyId, fixture.prefix, {
        assigneeAgentId: null, responsibleUserId: activeUserId,
      });
      const readableSourceId = await insertIssue(fixture.companyId, fixture.prefix, {
        assigneeAgentId: fixture.workerId, parentId: readableParentId,
      });
      const readable = await boardUpsert(fixture, { sourceIssueId: readableSourceId });
      expect(readable).toMatchObject({ ownerType: "agent", ownerAgentId: fixture.ceoId });
    });

    it("keeps the board when no dispatch identity can be resolved", async () => {
      const fixture = await seed();
      await db.delete(companyMemberships).where(eq(companyMemberships.companyId, fixture.companyId));
      const action = await boardUpsert(fixture);
      expect(action).toMatchObject({ ownerType: "board", ownerAgentId: null });
      expect(action.evidence.recoveryOwnerRouting).toMatchObject({ reason: "coordinator_no_access" });
    });

    it("falls back to the board when the source issue has no assignee agent", async () => {
      const fixture = await seed();
      const privateIssueId = await insertIssue(fixture.companyId, fixture.prefix, { assigneeAgentId: null, visibility: "private" });
      const owner = await resolveRecoveryOwner(db, {
        companyId: fixture.companyId,
        kind: "stranded_assigned_issue",
        cause: "stranded_assigned_issue",
        requestedOwnerType: "board",
        sourceIssueId: privateIssueId,
      });
      expect(owner).toMatchObject({
        ownerType: "board",
        routing: { coordinator: "unavailable", reason: "coordinator_no_access" },
      });
    });

    it("keeps open-issue routing to the coordinator unchanged", async () => {
      const fixture = await seed();
      const action = await boardUpsert(fixture);
      expect(action).toMatchObject({ ownerType: "agent", ownerAgentId: fixture.ceoId });
      expect(action.evidence.recoveryOwnerRouting).toMatchObject({ coordinator: "assigned", source: "root_ceo" });
    });

    it("keeps reserved kinds on the board and quota on the system", async () => {
      const fixture = await seed({ visibility: "private" });
      for (const cause of ["provider_auth_required", "budget_hard_stop", "provider_refusal", "workspace_deletion_requested", "publish_requires_human_approval", "credential_missing"]) {
        const owner = await resolveRecoveryOwner(db, {
          companyId: fixture.companyId,
          kind: "active_run_watchdog",
          cause,
          requestedOwnerType: "board",
          sourceIssueId: fixture.sourceIssueId,
        });
        expect(owner).toEqual({ ownerType: "board", ownerAgentId: null, ownerUserId: null, routing: null });
      }
      const quota = await resolveRecoveryOwner(db, {
        companyId: fixture.companyId,
        kind: "active_run_watchdog",
        cause: "provider_quota",
        requestedOwnerType: "system",
        sourceIssueId: fixture.sourceIssueId,
      });
      expect(quota).toMatchObject({ ownerType: "system", routing: null });
    });

    it("re-routes, instead of waking, a coordinator-owned action the coordinator cannot read", async () => {
      const fixture = await seed();
      const action = await boardUpsert(fixture);
      expect(action).toMatchObject({ ownerType: "agent", ownerAgentId: fixture.ceoId });
      // The issue became private after routing.
      await db.update(issues).set({ visibility: "private", privacyRootIssueId: fixture.sourceIssueId, responsibleUserId: fixture.ownerUserId })
        .where(eq(issues.id, fixture.sourceIssueId));

      const enqueueWakeup = vi.fn(async (_agentId: string, _opts?: unknown) => null);
      await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();

      expect(enqueueWakeup.mock.calls.some(([agentId]) => agentId === fixture.ceoId)).toBe(false);
      const rerouted = await actionRow(action.id);
      expect(rerouted).toMatchObject({
        status: "active",
        ownerType: "agent",
        ownerAgentId: fixture.workerId,
        returnOwnerAgentId: fixture.workerId,
        attemptCount: action.attemptCount,
      });
      expect(rerouted.evidence.recoveryOwnerRouting).toMatchObject({
        source: "source_assignee",
        reason: "coordinator_no_access",
      });
    });
  });

  it("backfill dry run reports terminal and no-access rows, and apply changes only those", async () => {
    const fixture = await seed();
    // A: open, coordinator-routed, source cancelled -> closed.
    const cancelledIssueId = await insertIssue(fixture.companyId, fixture.prefix, { assigneeAgentId: fixture.workerId });
    const terminal = await boardUpsert(fixture, { sourceIssueId: cancelledIssueId });
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, cancelledIssueId));
    // B: open, coordinator-routed, source private -> re-routed to the assignee.
    const privateIssueId = await insertIssue(fixture.companyId, fixture.prefix, { assigneeAgentId: fixture.workerId });
    const noAccess = await boardUpsert(fixture, { sourceIssueId: privateIssueId });
    await db.update(issues).set({ visibility: "private", privacyRootIssueId: privateIssueId, responsibleUserId: fixture.ownerUserId }).where(eq(issues.id, privateIssueId));
    // C: open, coordinator-routed, readable open source -> untouched.
    const healthy = await boardUpsert(fixture);
    // D: open, reserved board action on a readable source -> untouched.
    const reservedIssueId = await insertIssue(fixture.companyId, fixture.prefix, { assigneeAgentId: fixture.workerId });
    const reserved = await boardUpsert(fixture, { sourceIssueId: reservedIssueId, cause: "provider_auth_required" });
    expect(reserved.ownerType).toBe("board");
    const before = new Map(
      await Promise.all([terminal, noAccess, healthy, reserved].map(async (row) => [row.id, await actionRow(row.id)] as const)),
    );

    const dry = await backfillRecoveryCoordinatorOwners(db, { companyId: fixture.companyId, dryRun: true });
    expect(dry.companies[0]).toMatchObject({
      terminalSourceActionIds: [terminal.id],
      closedActionIds: [],
      noAccessActionIds: [noAccess.id],
      reroutedActionIds: [],
      movedActionIds: [],
    });
    for (const [id, row] of before) expect(await actionRow(id)).toEqual(row);

    const applied = await backfillRecoveryCoordinatorOwners(db, { companyId: fixture.companyId, dryRun: false });
    expect(applied.companies[0]).toMatchObject({
      closedActionIds: [terminal.id],
      reroutedActionIds: [noAccess.id],
      movedActionIds: [],
    });
    expect(await actionRow(terminal.id)).toMatchObject({
      status: "cancelled",
      outcome: "cancelled",
      resolutionNote: "source_issue_terminal",
    });
    const reroutedRow = await actionRow(noAccess.id);
    expect(reroutedRow).toMatchObject({ status: "active", ownerType: "agent", ownerAgentId: fixture.workerId });
    expect(reroutedRow.evidence.recoveryOwnerRouting).toMatchObject({
      source: "source_assignee",
      reason: "coordinator_no_access",
      backfilledAt: expect.any(String),
    });
    expect(await actionRow(healthy.id)).toEqual(before.get(healthy.id));
    expect(await actionRow(reserved.id)).toEqual(before.get(reserved.id));
    expect((await issueRow(cancelledIssueId)).status).toBe("cancelled");

    const rerun = await backfillRecoveryCoordinatorOwners(db, { companyId: fixture.companyId, dryRun: true });
    expect(rerun.companies[0]).toMatchObject({ terminalSourceActionIds: [], noAccessActionIds: [] });
  });
});
