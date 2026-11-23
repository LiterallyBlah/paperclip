import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
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
import { recoveryService } from "../services/recovery/service.js";
import { attentionService } from "../services/attention.js";
import {
  classifyRecoveryOwnerRoute,
  isOperatorHeldRecoveryAction,
  resolveRecoveryOwner,
} from "../services/recovery/recovery-owner-routing.js";
import { backfillRecoveryCoordinatorOwners } from "../services/recovery/recovery-owner-backfill.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("recovery owner route classification", () => {
  it("routes allowlisted routine kinds and keeps reserved causes", () => {
    expect(classifyRecoveryOwnerRoute({ kind: "active_run_watchdog", cause: "process_lost" })).toBe("routine");
    expect(classifyRecoveryOwnerRoute({ kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation" })).toBe("routine");
    expect(classifyRecoveryOwnerRoute({ kind: "stranded_assigned_issue", cause: "stranded_assigned_issue" })).toBe("routine");
    expect(classifyRecoveryOwnerRoute({ kind: "deliberate_wait_without_target", cause: "deliberate_wait_without_target" })).toBe("routine");
    for (const cause of [
      "budget_hard_stop",
      "provider_quota",
      "provider_auth_required",
      "adapter_sign_in_required",
      "provider_refusal",
      "credential_missing",
      "workspace_deletion_requested",
      "publish_requires_human_approval",
    ]) {
      expect(classifyRecoveryOwnerRoute({ kind: "active_run_watchdog", cause })).toBe("reserved");
    }
    expect(classifyRecoveryOwnerRoute({ kind: "workspace_validation", cause: "workspace_missing" })).toBe("unlisted");
    expect(classifyRecoveryOwnerRoute({ kind: "configuration_validation", cause: "configuration_incomplete" })).toBe("unlisted");
  });

  it("treats only board or coordinator-routed actions as operator-held", () => {
    const routed = {
      ownerType: "agent",
      ownerAgentId: "coordinator-1",
      evidence: { recoveryOwnerRouting: { coordinator: "assigned", agentId: "coordinator-1" } },
    };
    expect(isOperatorHeldRecoveryAction(routed)).toBe(true);
    expect(isOperatorHeldRecoveryAction({ ownerType: "board", ownerAgentId: null, evidence: {} })).toBe(true);
    expect(isOperatorHeldRecoveryAction({ ...routed, ownerAgentId: "someone-else" })).toBe(false);
    expect(isOperatorHeldRecoveryAction({ ownerType: "agent", ownerAgentId: "agent-1", evidence: {} })).toBe(false);
  });
});

describeEmbeddedPostgres("recovery coordinator owner routing", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-recovery-coordinator-routing-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function agentRow(input: {
    id: string;
    companyId: string;
    name: string;
    role: string;
    status?: string;
    reportsTo?: string | null;
  }): typeof agents.$inferInsert {
    return {
      id: input.id,
      companyId: input.companyId,
      name: input.name,
      role: input.role,
      status: input.status ?? "idle",
      reportsTo: input.reportsTo ?? null,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    };
  }

  async function seed(input: { rootCeoStatus?: string | null; configured?: "other" | "missing" | null } = {}) {
    const companyId = randomUUID();
    const ceoId = randomUUID();
    const otherId = randomUUID();
    const workerId = randomUUID();
    const sourceIssueId = randomUUID();
    const prefix = `RC${companyId.replace(/[^A-F0-9]/gi, "").slice(0, 4).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Synthetic Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    const rows = [
      agentRow({ id: otherId, companyId, name: "Ops Lead", role: "cto" }),
      agentRow({ id: workerId, companyId, name: "Worker", role: "engineer", reportsTo: otherId }),
    ];
    if (input.rootCeoStatus !== null) {
      rows.unshift(agentRow({ id: ceoId, companyId, name: "Chief", role: "ceo", status: input.rootCeoStatus ?? "idle" }));
    }
    await db.insert(agents).values(rows);
    if (input.configured === "other") {
      await db.update(companies).set({ recoveryCoordinatorAgentId: otherId }).where(eq(companies.id, companyId));
    } else if (input.configured === "missing") {
      await db.update(companies).set({ recoveryCoordinatorAgentId: randomUUID() }).where(eq(companies.id, companyId));
    }
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Synthetic source task",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: workerId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });
    return { companyId, ceoId, otherId, workerId, sourceIssueId };
  }

  function boardUpsert(
    fixture: Awaited<ReturnType<typeof seed>>,
    overrides: Partial<Parameters<ReturnType<typeof issueRecoveryActionService>["upsertSourceScoped"]>[0]> = {},
  ) {
    return issueRecoveryActionService(db).upsertSourceScoped({
      companyId: fixture.companyId,
      sourceIssueId: fixture.sourceIssueId,
      kind: "active_run_watchdog",
      ownerType: "board",
      previousOwnerAgentId: fixture.workerId,
      returnOwnerAgentId: fixture.workerId,
      cause: "process_lost",
      fingerprint: `synthetic:${fixture.sourceIssueId}`,
      evidence: { runId: randomUUID() },
      nextAction: "Inspect the lost run and decide the next step.",
      ...overrides,
    });
  }

  it("routes a board-owned routine action to the single root CEO by default", async () => {
    const fixture = await seed();
    const action = await boardUpsert(fixture);
    expect(action).toMatchObject({
      ownerType: "agent",
      ownerAgentId: fixture.ceoId,
      previousOwnerAgentId: fixture.workerId,
      returnOwnerAgentId: fixture.workerId,
    });
    expect(action.evidence.recoveryOwnerRouting).toMatchObject({
      coordinator: "assigned",
      agentId: fixture.ceoId,
      source: "root_ceo",
    });
    const source = await db.select().from(issues).where(eq(issues.id, fixture.sourceIssueId)).then((rows) => rows[0]!);
    expect(source.assigneeAgentId).toBe(fixture.workerId);
  });

  it("uses the upsert default owner (no owner given) through the same resolver", async () => {
    const fixture = await seed();
    const action = await boardUpsert(fixture, { ownerType: undefined });
    expect(action).toMatchObject({ ownerType: "agent", ownerAgentId: fixture.ceoId });
  });

  it("prefers the configured company recovery coordinator", async () => {
    const fixture = await seed({ configured: "other" });
    const action = await boardUpsert(fixture);
    expect(action).toMatchObject({ ownerType: "agent", ownerAgentId: fixture.otherId });
    expect(action.evidence.recoveryOwnerRouting).toMatchObject({ source: "configured" });
  });

  it.each([
    ["native_continuation_requires_reconciliation"],
    ["legacy_execution_requires_reconciliation"],
    ["native_restart_recovery_blocked"],
    ["native_workspace_finalization_owner_unverified"],
    ["native_safe_replacement_exhausted"],
    ["execution_control_reconciliation_required"],
  ])("routes the native and execution-control site cause %s", async (cause) => {
    const fixture = await seed();
    const action = await boardUpsert(fixture, { cause, fingerprint: `site:${cause}` });
    expect(action).toMatchObject({ ownerType: "agent", ownerAgentId: fixture.ceoId, cause });
  });

  it("keeps reserved causes on the board and provider quota on the system", async () => {
    const fixture = await seed();
    const auth = await boardUpsert(fixture, { cause: "provider_auth_required" });
    expect(auth).toMatchObject({ ownerType: "board", ownerAgentId: null });
    expect(auth.evidence.recoveryOwnerRouting).toBeUndefined();

    const other = await seed();
    const quota = await boardUpsert(other, { ownerType: "system", cause: "provider_quota", kind: "stranded_assigned_issue" });
    expect(quota).toMatchObject({ ownerType: "system", ownerAgentId: null });
  });

  it("keeps unlisted kinds unchanged", async () => {
    const fixture = await seed();
    const action = await boardUpsert(fixture, { kind: "workspace_validation", cause: "workspace_missing" });
    expect(action).toMatchObject({ ownerType: "board", ownerAgentId: null });
  });

  it.each([
    [{ rootCeoStatus: null }, "coordinator_not_configured"],
    [{ rootCeoStatus: "paused" }, "root_ceo_paused"],
    [{ rootCeoStatus: "terminated" }, "coordinator_not_configured"],
    [{ configured: "missing" as const }, "configured_coordinator_not_found"],
  ])("keeps the board with routing evidence when the coordinator is unavailable (%o)", async (setup, reason) => {
    const fixture = await seed(setup);
    const action = await boardUpsert(fixture);
    expect(action).toMatchObject({ ownerType: "board", ownerAgentId: null });
    expect(action.evidence.recoveryOwnerRouting).toMatchObject({ coordinator: "unavailable", reason });
  });

  it("treats a paused configured coordinator as unavailable", async () => {
    const fixture = await seed({ configured: "other" });
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, fixture.otherId));
    const owner = await resolveRecoveryOwner(db, {
      companyId: fixture.companyId,
      kind: "active_run_watchdog",
      cause: "process_lost",
      requestedOwnerType: "board",
    });
    expect(owner).toMatchObject({
      ownerType: "board",
      routing: { coordinator: "unavailable", reason: "configured_coordinator_paused" },
    });
  });

  it("deduplicates repeated escalation to one active action and keeps the source assignee", async () => {
    const fixture = await seed();
    const first = await boardUpsert(fixture);
    const second = await boardUpsert(fixture);
    expect(second.id).toBe(first.id);
    const rows = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, fixture.sourceIssueId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ownerType: "agent",
      ownerAgentId: fixture.ceoId,
      returnOwnerAgentId: fixture.workerId,
      previousOwnerAgentId: fixture.workerId,
    });
  });

  it("keeps coordinator-owned routine actions off the board attention feed", async () => {
    const fixture = await seed();
    const routed = await boardUpsert(fixture);
    expect(routed.ownerType).toBe("agent");
    const reservedFixture = await seed();
    const reserved = await boardUpsert(reservedFixture, { cause: "provider_auth_required" });
    expect(reserved.ownerType).toBe("board");

    const recoveryIds = async (companyId: string) =>
      (await attentionService(db).list(companyId, { userId: "board-user" })).items
        .filter((item) => item.sourceKind === "recovery_action")
        .map((item) => item.subject.id);
    expect(await recoveryIds(fixture.companyId)).not.toContain(routed.id);
    expect(await recoveryIds(reservedFixture.companyId)).toContain(reserved.id);
  });

  it("routes retry-budget exhaustion to the coordinator without recording it as the source owner", async () => {
    const fixture = await seed();
    const first = await boardUpsert(fixture, {
      ownerType: "agent",
      ownerAgentId: fixture.workerId,
      kind: "missing_disposition",
      cause: "successful_run_missing_state",
      maxAttempts: 1,
    });
    expect(first).toMatchObject({ ownerType: "agent", ownerAgentId: fixture.workerId });
    const exhausted = await boardUpsert(fixture, {
      ownerType: "agent",
      ownerAgentId: fixture.workerId,
      kind: "missing_disposition",
      cause: "successful_run_missing_state",
      maxAttempts: 1,
    });
    expect(exhausted).toMatchObject({
      id: first.id,
      status: "escalated",
      ownerType: "agent",
      ownerAgentId: fixture.ceoId,
      previousOwnerAgentId: fixture.workerId,
      returnOwnerAgentId: fixture.workerId,
    });
    expect(exhausted.evidence.recoveryBudget).toMatchObject({ state: "exhausted" });
    expect(exhausted.evidence.recoveryOwnerRouting).toMatchObject({ coordinator: "assigned", agentId: fixture.ceoId });
  });

  it("gives a coordinator-owned action one source-scoped coordinator wake per sweep window", async () => {
    const fixture = await seed();
    const action = await boardUpsert(fixture);
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    await recovery.reconcileStrandedAssignedIssues();
    const coordinatorWakes = enqueueWakeup.mock.calls.filter(([agentId]) => agentId === fixture.ceoId);
    expect(coordinatorWakes).toHaveLength(1);
    expect(coordinatorWakes[0]![1]).toMatchObject({
      source: "automation",
      reason: "source_scoped_recovery_action",
      contextSnapshot: expect.objectContaining({
        issueId: fixture.sourceIssueId,
        wakeReason: "source_scoped_recovery_action",
        recoveryActionId: action.id,
      }),
    });
    // The source assignee is not woken in its place.
    expect(enqueueWakeup.mock.calls.some(([agentId]) => agentId === fixture.workerId)).toBe(false);

    const afterFirst = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)).then((rows) => rows[0]!);
    expect(afterFirst).toMatchObject({ status: "active", ownerType: "agent", ownerAgentId: fixture.ceoId });
    expect((afterFirst.evidence.recoveryOwnerRouting as Record<string, unknown>).wakeQueuedAt).toEqual(expect.any(String));

    await recovery.reconcileStrandedAssignedIssues();
    expect(enqueueWakeup.mock.calls.filter(([agentId]) => agentId === fixture.ceoId)).toHaveLength(1);
  });

  it("backfills active board-owned routine actions with a dry run first, idempotently", async () => {
    const fixture = await seed();
    const [routine, reserved, unlisted] = await db.insert(issueRecoveryActions).values([
      {
        companyId: fixture.companyId,
        sourceIssueId: fixture.sourceIssueId,
        kind: "active_run_watchdog",
        status: "active",
        ownerType: "board",
        returnOwnerAgentId: fixture.workerId,
        cause: "process_lost",
        fingerprint: "backfill:routine",
        evidence: {},
        nextAction: "Inspect.",
        attemptCount: 2,
      },
      {
        companyId: fixture.companyId,
        sourceIssueId: fixture.sourceIssueId,
        kind: "active_run_watchdog",
        status: "resolved",
        ownerType: "board",
        cause: "provider_auth_required",
        fingerprint: "backfill:reserved",
        evidence: {},
        nextAction: "Sign in.",
      },
      {
        companyId: fixture.companyId,
        sourceIssueId: fixture.sourceIssueId,
        kind: "workspace_validation",
        status: "resolved",
        ownerType: "board",
        cause: "workspace_missing",
        fingerprint: "backfill:unlisted",
        evidence: {},
        nextAction: "Fix workspace.",
      },
    ]).returning();
    // Only one action may be active per source issue; use a second source for the reserved one.
    const secondSourceId = randomUUID();
    await db.insert(issues).values({
      id: secondSourceId,
      companyId: fixture.companyId,
      title: "Second synthetic task",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: fixture.workerId,
      issueNumber: 2,
      identifier: `SYN-${secondSourceId.slice(0, 4)}`,
    });
    await db.update(issueRecoveryActions).set({ status: "active", sourceIssueId: secondSourceId })
      .where(eq(issueRecoveryActions.id, reserved!.id));

    const dry = await backfillRecoveryCoordinatorOwners(db, { companyId: fixture.companyId, dryRun: true });
    expect(dry.companies[0]).toMatchObject({
      coordinator: { status: "available", agentId: fixture.ceoId },
      candidateActionIds: [routine!.id],
      reservedActionIds: [reserved!.id],
      movedActionIds: [],
    });
    const untouched = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, routine!.id)).then((rows) => rows[0]!);
    expect(untouched.ownerType).toBe("board");

    const applied = await backfillRecoveryCoordinatorOwners(db, { companyId: fixture.companyId, dryRun: false });
    expect(applied.companies[0]!.movedActionIds).toEqual([routine!.id]);
    const moved = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, routine!.id)).then((rows) => rows[0]!);
    expect(moved).toMatchObject({
      status: "active",
      ownerType: "agent",
      ownerAgentId: fixture.ceoId,
      returnOwnerAgentId: fixture.workerId,
      attemptCount: 2,
    });
    expect(moved.evidence.recoveryOwnerRouting).toMatchObject({ coordinator: "assigned", backfilledAt: expect.any(String) });
    const keptReserved = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, reserved!.id)).then((rows) => rows[0]!);
    expect(keptReserved.ownerType).toBe("board");
    const keptUnlisted = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, unlisted!.id)).then((rows) => rows[0]!);
    expect(keptUnlisted.ownerType).toBe("board");

    const rerun = await backfillRecoveryCoordinatorOwners(db, { companyId: fixture.companyId, dryRun: false });
    expect(rerun.companies[0]).toMatchObject({ candidateActionIds: [], movedActionIds: [] });
  });

  it("leaves board actions alone during backfill when no coordinator is available", async () => {
    const fixture = await seed({ rootCeoStatus: null });
    await db.insert(issueRecoveryActions).values({
      companyId: fixture.companyId,
      sourceIssueId: fixture.sourceIssueId,
      kind: "active_run_watchdog",
      status: "active",
      ownerType: "board",
      cause: "process_lost",
      fingerprint: "backfill:none",
      evidence: {},
      nextAction: "Inspect.",
    });
    const result = await backfillRecoveryCoordinatorOwners(db, { companyId: fixture.companyId, dryRun: false });
    expect(result.companies[0]).toMatchObject({
      coordinator: { status: "unavailable", reason: "coordinator_not_configured" },
      movedActionIds: [],
    });
  });
});
