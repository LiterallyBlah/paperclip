import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agents, companies, createDb, environmentLeases, heartbeatRunEvents, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { agentExecutionsHaveStopped } from "./agent-execution-stop.js";
import { remoteTerminationReceipt } from "./remote-execution-termination.js";
import { isSettledLegacyStartupCancellation, recordLegacyStartupCancellationSettled } from "./legacy-startup-cancellation.js";
import { PROCESS_START_REQUESTED } from "./native-local-process-stop.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("legacy startup cancellation settlement", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let companyId: string;
  let agentId: string;
  const bootId = randomUUID();
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-legacy-startup-cancel-"); db = createDb(database.connectionString); }, 90_000);
  afterAll(async () => { await database?.cleanup(); });
  beforeEach(async () => {
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Legacy cancel", issuePrefix: `C${companyId.slice(0, 7)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Summarizer", adapterType: "codex_local" }).returning();
    agentId = agent!.id;
  });

  /** Shape of the captured Summarizer run 8d2daa8e: Stop before any process. */
  async function capturedShape(overrides: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    const [issue] = await db.insert(issues).values({ companyId, title: "Status card" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId, status: "cancelled", invocationSource: "automation", runtimeMode: "legacy",
      startedAt: new Date(Date.now() - 400), finishedAt: new Date(), errorCode: "cancelled", error: "Cancelled by control plane",
      executionStage: "settled", controllerBootId: bootId, sessionIdBefore: randomUUID(),
      contextSnapshot: { issueId: issue!.id },
      runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } },
      usageJson: { ledgerScope: { issueId: issue!.id, projectId: null, billingCode: null } },
      resultJson: { stopReason: "cancelled", timeoutFired: false, timeoutSource: "default", timeoutConfigured: false,
        effectiveTimeoutSec: 0, cancellation: { reason: "Cancelled by control plane", source: "control_plane", expected: true,
          initiator: { type: "system" }, recordedAt: new Date(Date.now() - 50).toISOString() },
        startupCancellation: { errorCode: "cancelled", requestedAt: new Date(Date.now() - 50).toISOString(), beforeNativeSelection: false } },
      ...overrides,
    }).returning();
    return run!;
  }
  const read = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;
  const record = (run: { id: string }, extra: Partial<Parameters<typeof recordLegacyStartupCancellationSettled>[1]> = {}) =>
    recordLegacyStartupCancellationSettled(db, { runId: run.id, companyId, controllerBootId: bootId, adapterEntered: false, ...extra });
  async function event(runId: string, eventType: string, sourceEventId: string | null = null) {
    const [row] = await db.select({ seq: heartbeatRuns.nextEventSeq }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    await db.insert(heartbeatRunEvents).values({ companyId, runId, agentId, seq: (row?.seq ?? 1) + 10, eventType, sourceEventId });
  }

  it("reproduces the missing-acknowledgement block and settles it only from the executor receipt", async () => {
    const run = await capturedShape();
    await event(run.id, "lifecycle");
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(false);
    expect(await record(run)).toBe(true);
    const settled = await read(run.id);
    expect(settled.resultJson).toMatchObject({
      startupCancellation: { beforeNativeSelection: false },
      legacyStartupCancellation: { version: 1, runId: run.id, companyId, controllerBootId: bootId,
        providerDispatchStarted: false, cancellationRecordedAt: (run.resultJson!.cancellation as { recordedAt: string }).recordedAt,
        startupCancellationRequestedAt: (run.resultJson!.startupCancellation as { requestedAt: string }).requestedAt },
    });
    expect(settled.resultJson?.executionCancellation).toBeUndefined();
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(true);
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(true);
    // Written once; a replay cannot refresh or rebind it.
    expect(await record(run)).toBe(false);
  });

  it("does not record when the executor entered the adapter or does not own the run", async () => {
    const run = await capturedShape();
    expect(await record(run, { adapterEntered: true })).toBe(false);
    expect(await record(run, { controllerBootId: randomUUID() })).toBe(false);
    expect(await record(run, { companyId: randomUUID() })).toBe(false);
    expect((await read(run.id)).resultJson?.legacyStartupCancellation).toBeUndefined();
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(false);
  });

  it.each([
    ["committed provider handoff", { usageJson: { budgetDispatch: { reservationId: "r", handedOffAt: new Date().toISOString() } } }],
    ["recorded process", { processPid: 2_000_000_000 }],
    ["recorded process group", { processGroupId: 2_000_000_000 }],
    ["recorded process birth", { processStartedAt: new Date() }],
    ["produced session", { sessionIdAfter: randomUUID() }],
    ["observed exit", { exitCode: 0 }],
    ["observed signal", { signal: "SIGTERM" }],
    ["non-terminal run", { status: "running" }],
    ["native runtime", { runtimeMode: "native" }],
    ["no cancellation record", { resultJson: { stopReason: "cancelled" } }],
  ] as const)("refuses to record with contradictory evidence: %s", async (_label, overrides) => {
    const run = await capturedShape(overrides as Partial<typeof heartbeatRuns.$inferInsert>);
    expect(await record(run)).toBe(false);
    expect((await read(run.id)).resultJson?.legacyStartupCancellation).toBeUndefined();
  });

  it.each([
    ["adapter invocation", "adapter.invoke", null],
    ["launch request", PROCESS_START_REQUESTED, null],
    ["provider-sourced event", "lifecycle", randomUUID()],
  ] as const)("refuses to record after retained launch evidence: %s", async (_label, eventType, sourceEventId) => {
    const run = await capturedShape();
    await event(run.id, eventType, sourceEventId);
    expect(await record(run)).toBe(false);
  });

  it("refuses to record when a native coordinator exists", async () => {
    const run = await capturedShape();
    await db.update(heartbeatRuns).set({ nativeIssueId: run.contextSnapshot!.issueId as string }).where(eq(heartbeatRuns.id, run.id));
    await db.insert(nativeRunFinalizations).values({ companyId, issueId: run.contextSnapshot!.issueId as string, runId: run.id, phase: "observed" });
    expect(await record(run)).toBe(false);
  });

  it.each([
    ["later launch event", async (id: string) => event(id, PROCESS_START_REQUESTED)],
    ["later provider handoff", async (id: string) => { await db.update(heartbeatRuns).set({ usageJson: { budgetDispatch: { handedOffAt: new Date().toISOString() } } }).where(eq(heartbeatRuns.id, id)); }],
    ["later process identity", async (id: string) => { await db.update(heartbeatRuns).set({ processPid: process.pid }).where(eq(heartbeatRuns.id, id)); }],
    ["changed controller owner", async (id: string) => { await db.update(heartbeatRuns).set({ controllerBootId: randomUUID() }).where(eq(heartbeatRuns.id, id)); }],
    ["replaced startup fence", async (id: string) => { const run = await read(id); await db.update(heartbeatRuns).set({ resultJson: { ...run.resultJson,
      startupCancellation: { requestedAt: new Date(Date.now() + 1000).toISOString(), beforeNativeSelection: false } } }).where(eq(heartbeatRuns.id, id)); }],
    ["replaced cancellation record", async (id: string) => { const run = await read(id); await db.update(heartbeatRuns).set({ resultJson: { ...run.resultJson,
      cancellation: { ...(run.resultJson!.cancellation as object), recordedAt: new Date(Date.now() + 1000).toISOString() } } }).where(eq(heartbeatRuns.id, id)); }],
    ["receipt for another run", async (id: string) => { const run = await read(id); await db.update(heartbeatRuns).set({ resultJson: { ...run.resultJson,
      legacyStartupCancellation: { ...(run.resultJson!.legacyStartupCancellation as object), runId: randomUUID() } } }).where(eq(heartbeatRuns.id, id)); }],
    ["unsettled local lease", async (id: string) => { await db.insert(environmentLeases).values({ companyId, heartbeatRunId: id, provider: "local", status: "active" }); }],
    ["live controller lease", async (id: string) => { await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(heartbeatRuns.id, id)); }],
  ] as const)("rejects a stored receipt after %s", async (_label, mutate) => {
    const run = await capturedShape();
    expect(await record(run)).toBe(true);
    expect(await isSettledLegacyStartupCancellation(db, await read(run.id))).toBe(true);
    await mutate(run.id);
    expect(await isSettledLegacyStartupCancellation(db, await read(run.id))).toBe(false);
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(false);
  });

  it("never substitutes for a remote cancelled-run termination receipt", async () => {
    const run = await capturedShape();
    expect(await record(run)).toBe(true);
    const [lease] = await db.insert(environmentLeases).values({ companyId, heartbeatRunId: run.id, provider: "ssh",
      providerLeaseId: "ssh-host", status: "released", cleanupStatus: "success", releasedAt: new Date() }).returning();
    expect(await isSettledLegacyStartupCancellation(db, await read(run.id))).toBe(false);
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(false);
    await db.update(environmentLeases).set({ metadata: {
      remoteExecutionTermination: remoteTerminationReceipt(lease!, { providerLeaseId: lease!.providerLeaseId, state: "destroyed" }),
    } }).where(eq(environmentLeases.id, lease!.id));
    // Only the remote receipt, through its own branch, settles a remote run.
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(true);
  });

  it("settles a post-selection Stop that carries only the cancellation record", async () => {
    const run = await capturedShape({ runtimeModeResolvedAt: new Date() });
    const { startupCancellation: _startup, ...resultJson } = run.resultJson!;
    await db.update(heartbeatRuns).set({ resultJson }).where(eq(heartbeatRuns.id, run.id));
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(false);
    expect(await record(run)).toBe(true);
    expect((await read(run.id)).resultJson?.legacyStartupCancellation).toMatchObject({ startupCancellationRequestedAt: null });
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(true);
  });

  it("leaves the captured historical row blocked: no receipt is inferred", async () => {
    // No executor ever recorded proof; empty leases, events and PIDs are not proof.
    const run = await capturedShape();
    expect(await isSettledLegacyStartupCancellation(db, await read(run.id))).toBe(false);
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(false);
  });
});
