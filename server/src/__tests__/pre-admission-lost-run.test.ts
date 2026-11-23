import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, environmentLeases, heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedPreAdmissionLostRun } from "./helpers/pre-admission-lost-run-fixture.js";
import { isPreAdmissionLostRunVerified } from "../services/pre-admission-lost-run.js";
import { LEGACY_WORKSPACE_RECOVERY_SCHEMA } from "../services/workspace-restore-recovery-state.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("pre-admission lost legacy run predicate", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("pre-admission-lost-run-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); });

  async function patched(f: Awaited<ReturnType<typeof seedPreAdmissionLostRun>>, patch: Partial<typeof heartbeatRuns.$inferInsert>) {
    return (await db.update(heartbeatRuns).set(patch).where(eq(heartbeatRuns.id, f.runId)).returning())[0];
  }

  it("is true for the f8e0a4d4 shape", async () => {
    const f = await seedPreAdmissionLostRun(db);
    expect(await isPreAdmissionLostRunVerified(db, f.run)).toBe(true);
    expect(await isPreAdmissionLostRunVerified(db, f.run, f.issueId)).toBe(true);
  });

  it("is true before the gate at the dispatching stage and with a released lease", async () => {
    const f = await seedPreAdmissionLostRun(db, { run: { executionStage: "dispatching" } });
    await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.runId,
      provider: "local", status: "released", releasedAt: new Date(), cleanupStatus: "success" });
    expect(await isPreAdmissionLostRunVerified(db, f.run)).toBe(true);
  });

  it("is false for an admitted marker", async () => {
    const f = await seedPreAdmissionLostRun(db, { phase: "admitted" });
    expect(await isPreAdmissionLostRunVerified(db, f.run)).toBe(false);
  });

  it("is false for a historical (absent) marker", async () => {
    const f = await seedPreAdmissionLostRun(db, { run: { runnerProfileJson: {} } });
    expect(await isPreAdmissionLostRunVerified(db, f.run)).toBe(false);
    const g = await seedPreAdmissionLostRun(db, { run: { runnerProfileJson: null } });
    expect(await isPreAdmissionLostRunVerified(db, g.run)).toBe(false);
  });

  it.each([
    ["unknown phase", (a: Record<string, unknown>) => ({ ...a, phase: "pending" })],
    ["foreign run", (a: Record<string, unknown>) => ({ ...a, runId: randomUUID() })],
    ["foreign agent", (a: Record<string, unknown>) => ({ ...a, agentId: randomUUID() })],
    ["foreign company", (a: Record<string, unknown>) => ({ ...a, companyId: randomUUID() })],
    ["foreign issue", (a: Record<string, unknown>) => ({ ...a, issueId: randomUUID() })],
    ["foreign wake", (a: Record<string, unknown>) => ({ ...a, wakeupRequestId: randomUUID() })],
    ["wrong version", (a: Record<string, unknown>) => ({ ...a, version: 2 })],
    ["extra key", (a: Record<string, unknown>) => ({ ...a, note: "x" })],
    ["missing key", ({ wakeupRequestId: _omit, ...a }: Record<string, unknown>) => a],
    ["not an object", () => "required"],
  ])("is false for an invalid marker: %s", async (_label, mutate) => {
    const f = await seedPreAdmissionLostRun(db);
    const run = await patched(f, { runnerProfileJson: { chatControlRecoveryAdmission: mutate(f.admission) } });
    expect(await isPreAdmissionLostRunVerified(db, run)).toBe(false);
  });

  it.each([
    ["process PID", { processPid: 4242 }],
    ["process group", { processGroupId: 4242 }],
    ["process start", { processStartedAt: new Date() }],
    ["still running", { status: "running", finishedAt: null }],
    ["queued", { status: "queued", finishedAt: null }],
    ["no finish time", { finishedAt: null }],
    ["native runtime", { runtimeMode: "native" }],
    ["on-demand invocation", { invocationSource: "on_demand" }],
    ["adapter_execution stage", { executionStage: "adapter_execution" }],
    ["executing stage", { executionStage: "executing" }],
    ["settled stage", { executionStage: "settled" }],
    ["unsafe archive", { resultJson: { workspaceRestoreFailure: "restore_unsafe_archive" } }],
    ["retained workspace recovery", { resultJson: { workspaceRestoreRecovery: {
      schema: LEGACY_WORKSPACE_RECOVERY_SCHEMA, leaseIds: [randomUUID()] } } }],
  ] as const)("is false with %s", async (_label, patch) => {
    const f = await seedPreAdmissionLostRun(db);
    const run = await patched(f, patch as Partial<typeof heartbeatRuns.$inferInsert>);
    expect(await isPreAdmissionLostRunVerified(db, run)).toBe(false);
  });

  it("is false for a mismatched contextSnapshot.issueId", async () => {
    const f = await seedPreAdmissionLostRun(db);
    expect(await isPreAdmissionLostRunVerified(db, f.run, randomUUID())).toBe(false);
    const run = await patched(f, { contextSnapshot: { ...f.run.contextSnapshot, issueId: randomUUID() } });
    expect(await isPreAdmissionLostRunVerified(db, run, f.issueId)).toBe(false);
    const missing = await patched(f, { contextSnapshot: { taskId: f.issueId } });
    expect(await isPreAdmissionLostRunVerified(db, missing)).toBe(false);
  });

  it("is false with an adapter.invoke execution-started event", async () => {
    const f = await seedPreAdmissionLostRun(db);
    await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, agentId: f.agentId, runId: f.runId, seq: 1,
      eventType: "adapter.invoke", stream: "system" });
    expect(await isPreAdmissionLostRunVerified(db, f.run)).toBe(false);
  });

  it.each([
    ["unreleased", { status: "active", releasedAt: null }],
    ["pending cleanup", { status: "pending_cleanup", releasedAt: new Date() }],
    ["failed cleanup", { status: "released", releasedAt: new Date(), cleanupStatus: "failed" }],
  ] as const)("is false with an %s environment lease", async (_label, lease) => {
    const f = await seedPreAdmissionLostRun(db);
    await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.runId, provider: "local", ...lease });
    expect(await isPreAdmissionLostRunVerified(db, f.run)).toBe(false);
  });

  it("is false with a native finalization row", async () => {
    // The finalization owner key requires the run's native issue identity.
    const f = await seedPreAdmissionLostRun(db);
    f.run = await patched(f, { nativeIssueId: f.issueId });
    await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.issueId, runId: f.runId, phase: "observed" });
    expect(await isPreAdmissionLostRunVerified(db, f.run)).toBe(false);
  });

  it("is false when the stored row disagrees with the caller's copy", async () => {
    const f = await seedPreAdmissionLostRun(db);
    await patched(f, { processPid: 4242 });
    expect(await isPreAdmissionLostRunVerified(db, f.run)).toBe(false);
  });
});
