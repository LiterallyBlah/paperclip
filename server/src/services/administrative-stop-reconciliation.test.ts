import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, environmentLeases, heartbeatRunEvents, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { instanceSettingsRoutes } from "../routes/instance-settings.js";
import { agentExecutionsHaveStopped } from "./agent-execution-stop.js";
import {
  defaultHostProcessCheck,
  isAdministrativelyReconciledStop,
  recordAdministrativeStopReconciliation,
  type HostProcessCheck,
} from "./administrative-stop-reconciliation.js";
import { legacyControllerBootId } from "./legacy-controller-lease.js";
import { recordLegacyStartupCancellationSettled } from "./legacy-startup-cancellation.js";
import { PROCESS_START_REQUESTED } from "./native-local-process-stop.js";
import { remoteTerminationReceipt } from "./remote-execution-termination.js";

/** This worker's live process group (field 5 of /proc/self/stat). */
const ownProcessGroup = () => Number(readFileSync("/proc/self/stat", "utf8").replace(/^.*\) /s, "").split(" ")[2]);
const clear: HostProcessCheck = async () => "clear";
// Historical times: no live process on this host was born this early.
const STARTED = new Date("2001-01-01T00:00:00.000Z");
const FINISHED = new Date("2001-01-01T00:00:00.316Z");

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("administrative stop reconciliation (BLA-4475)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let companyId: string;
  let agentId: string;
  const oldBootId = randomUUID();
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-admin-stop-reconcile-"); db = createDb(database.connectionString); }, 90_000);
  afterAll(async () => { await database?.cleanup(); });
  beforeEach(async () => {
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Admin reconcile", issuePrefix: `A${companyId.slice(0, 7)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Summarizer", adapterType: "codex_local" }).returning();
    agentId = agent!.id;
  });

  /** Shape of the live Summarizer run 8d2daa8e: historical Stop, no process, old controller boot. */
  async function historicalShape(overrides: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    const [issue] = await db.insert(issues).values({ companyId, title: "Status card" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId, status: "cancelled", invocationSource: "automation", runtimeMode: "legacy",
      startedAt: STARTED, finishedAt: FINISHED, errorCode: "cancelled", error: "Cancelled by control plane",
      executionStage: "settled", controllerBootId: oldBootId, sessionIdBefore: randomUUID(),
      contextSnapshot: { issueId: issue!.id },
      runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } },
      usageJson: { ledgerScope: { issueId: issue!.id, projectId: null, billingCode: null }, budgetDispatch: { reservationId: "r" } },
      resultJson: { stopReason: "cancelled", timeoutFired: false, timeoutSource: "default", timeoutConfigured: false,
        effectiveTimeoutSec: 0, cancellation: { reason: "Cancelled by control plane", source: "control_plane", expected: true,
          initiator: { type: "system" }, recordedAt: "2001-01-01T00:00:00.200Z" },
        startupCancellation: { errorCode: "cancelled", requestedAt: "2001-01-01T00:00:00.200Z", beforeNativeSelection: false } },
      ...overrides,
    }).returning();
    return run!;
  }
  const read = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;
  const reconcile = (run: { id: string }, opts: Parameters<typeof recordAdministrativeStopReconciliation>[2] = {}, cid = companyId) =>
    recordAdministrativeStopReconciliation(db, {
      runId: run.id, companyId: cid, reconciledByActor: { type: "user", id: "board-user" },
      decisionRef: "BLA-4475", reason: "historical cancelled legacy run; controller boot gone",
    }, { hostProcessCheck: clear, ...opts });
  async function event(runId: string, eventType: string, sourceEventId: string | null = null) {
    const [row] = await db.select({ seq: heartbeatRuns.nextEventSeq }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    await db.insert(heartbeatRunEvents).values({ companyId, runId, agentId, seq: (row?.seq ?? 1) + 10, eventType, sourceEventId });
  }
  const setResult = async (id: string, patch: (result: Record<string, unknown>) => Record<string, unknown>) => {
    const run = await read(id);
    await db.update(heartbeatRuns).set({ resultJson: patch({ ...run.resultJson }) }).where(eq(heartbeatRuns.id, id));
  };

  it("unblocks the historical row only through the administrative receipt", async () => {
    const run = await historicalShape();
    await event(run.id, "lifecycle");
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(false);
    const written = await reconcile(run);
    expect(written.ok).toBe(true);
    const settled = await read(run.id);
    expect(settled.resultJson).toMatchObject({
      startupCancellation: { beforeNativeSelection: false },
      administrativeStopReconciliation: { version: 1, kind: "administrative", runId: run.id, companyId,
        controllerBootId: oldBootId, currentControllerBootId: legacyControllerBootId,
        cancellationRecordedAt: "2001-01-01T00:00:00.200Z", reconciledByActor: { type: "user", id: "board-user" },
        decisionRef: "BLA-4475", executorTerminationProven: false },
    });
    expect(settled.resultJson?.executionCancellation).toBeUndefined();
    expect(settled.resultJson?.legacyStartupCancellation).toBeUndefined();
    expect(await isAdministrativelyReconciledStop(db, settled)).toBe(true);
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(true);
    // Written once; a replay cannot refresh or rebind it.
    expect(await reconcile(run)).toEqual({ ok: false, reason: "premises_not_met" });
  });

  it("leaves an un-reconciled historical row blocked", async () => {
    const run = await historicalShape();
    expect(await isAdministrativelyReconciledStop(db, await read(run.id))).toBe(false);
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(false);
  });

  it.each([
    ["recorded process", { processPid: 2_000_000_000 }],
    ["recorded process group", { processGroupId: 2_000_000_000 }],
    ["recorded process birth", { processStartedAt: new Date() }],
    ["produced session", { sessionIdAfter: randomUUID() }],
    ["native session", { nativeSessionId: randomUUID() }],
    ["observed exit", { exitCode: 0 }],
    ["observed signal", { signal: "SIGTERM" }],
    ["committed provider handoff", { usageJson: { budgetDispatch: { reservationId: "r", handedOffAt: "2001-01-01T00:00:00.100Z" } } }],
    ["current controller boot", { controllerBootId: legacyControllerBootId }],
    ["no controller boot", { controllerBootId: null }],
    ["live controller lease", { controllerLeaseExpiresAt: new Date(Date.now() + 60_000) }],
    ["non-terminal run", { status: "running" }],
    ["failed run", { status: "failed" }],
    ["native runtime", { runtimeMode: "native" }],
    ["unfinished run", { finishedAt: null }],
    ["no cancellation record", { resultJson: { stopReason: "cancelled" } }],
    ["acknowledged execution cancellation", { resultJson: { cancellation: { recordedAt: "2001-01-01T00:00:00.200Z" },
      executionCancellation: { state: "acknowledged" } } }],
    ["existing executor receipt", { resultJson: { cancellation: { recordedAt: "2001-01-01T00:00:00.200Z" },
      legacyStartupCancellation: { version: 1 } } }],
  ] as const)("writer refuses with contradictory evidence: %s", async (_label, overrides) => {
    const run = await historicalShape(overrides as Partial<typeof heartbeatRuns.$inferInsert>);
    expect((await reconcile(run)).ok).toBe(false);
    expect((await read(run.id)).resultJson?.administrativeStopReconciliation).toBeUndefined();
  });

  it.each([
    ["adapter invocation", "adapter.invoke", null],
    ["launch request", PROCESS_START_REQUESTED, null],
    ["provider-sourced event", "lifecycle", randomUUID()],
  ] as const)("writer refuses after retained execution evidence: %s", async (_label, eventType, sourceEventId) => {
    const run = await historicalShape();
    await event(run.id, eventType, sourceEventId);
    expect(await reconcile(run)).toEqual({ ok: false, reason: "premises_not_met" });
  });

  it.each([
    ["non-local lease", { provider: "ssh", status: "released", cleanupStatus: "success", releasedAt: new Date() }],
    ["unreleased local lease", { provider: "local", status: "active" }],
    ["pending cleanup", { provider: "local", status: "pending_cleanup", releasedAt: new Date() }],
    ["failed cleanup", { provider: "local", status: "released", cleanupStatus: "failed", releasedAt: new Date() }],
  ] as const)("writer refuses with a blocking lease: %s", async (_label, lease) => {
    const run = await historicalShape();
    await db.insert(environmentLeases).values({ companyId, heartbeatRunId: run.id, ...lease });
    expect(await reconcile(run)).toEqual({ ok: false, reason: "premises_not_met" });
  });

  it("writer accepts a released, cleaned local lease", async () => {
    const run = await historicalShape();
    await db.insert(environmentLeases).values({ companyId, heartbeatRunId: run.id, provider: "local", status: "released",
      cleanupStatus: "success", releasedAt: new Date() });
    expect((await reconcile(run)).ok).toBe(true);
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(true);
  });

  it("writer refuses when a native coordinator exists", async () => {
    const run = await historicalShape();
    await db.update(heartbeatRuns).set({ nativeIssueId: run.contextSnapshot!.issueId as string }).where(eq(heartbeatRuns.id, run.id));
    await db.insert(nativeRunFinalizations).values({ companyId, issueId: run.contextSnapshot!.issueId as string, runId: run.id, phase: "observed" });
    expect(await reconcile(run)).toEqual({ ok: false, reason: "premises_not_met" });
  });

  it("writer refuses for another company, an unknown run, or a host process in the window", async () => {
    const run = await historicalShape();
    expect(await reconcile(run, {}, randomUUID())).toEqual({ ok: false, reason: "not_found" });
    expect(await reconcile({ id: randomUUID() })).toEqual({ ok: false, reason: "not_found" });
    let seen: { from: Date; to: Date } | undefined;
    expect(await reconcile(run, { hostProcessCheck: async (window) => { seen = window; return "found"; } }))
      .toEqual({ ok: false, reason: "host_process_in_window" });
    expect(seen).toEqual({ from: new Date(STARTED.getTime() - 1_000), to: new Date(FINISHED.getTime() + 600_000) });
    expect(await reconcile(run, { hostProcessCheck: async () => "unavailable" }))
      .toEqual({ ok: false, reason: "host_check_unavailable" });
    expect((await read(run.id)).resultJson?.administrativeStopReconciliation).toBeUndefined();
  });

  it("host check finds a live process of this uid born in the window and clears an empty one", async () => {
    const bornAt = new Date(Date.now() - process.uptime() * 1000);
    expect(await defaultHostProcessCheck({ from: new Date(bornAt.getTime() - 5_000), to: new Date(Date.now() + 1_000) })).toBe("found");
    expect(await defaultHostProcessCheck({ from: STARTED, to: new Date(FINISHED.getTime() + 600_000) })).toBe("clear");
  });

  it.each([
    ["later launch event", async (id: string) => event(id, PROCESS_START_REQUESTED)],
    ["later provider event", async (id: string) => event(id, "lifecycle", randomUUID())],
    ["later provider handoff", async (id: string) => { await db.update(heartbeatRuns).set({ usageJson: { budgetDispatch: { handedOffAt: new Date().toISOString() } } }).where(eq(heartbeatRuns.id, id)); }],
    // A live process: a recorded dead PID leaves this branch for the unchanged process-absent rule.
    ["later process identity", async (id: string) => { await db.update(heartbeatRuns).set({ processPid: process.pid }).where(eq(heartbeatRuns.id, id)); }],
    ["later process group", async (id: string) => { await db.update(heartbeatRuns).set({ processGroupId: ownProcessGroup() }).where(eq(heartbeatRuns.id, id)); }],
    ["later session", async (id: string) => { await db.update(heartbeatRuns).set({ sessionIdAfter: randomUUID() }).where(eq(heartbeatRuns.id, id)); }],
    ["later exit", async (id: string) => { await db.update(heartbeatRuns).set({ exitCode: 1 }).where(eq(heartbeatRuns.id, id)); }],
    ["later signal", async (id: string) => { await db.update(heartbeatRuns).set({ signal: "SIGKILL" }).where(eq(heartbeatRuns.id, id)); }],
    ["claimed by the current boot", async (id: string) => { await db.update(heartbeatRuns).set({ controllerBootId: legacyControllerBootId }).where(eq(heartbeatRuns.id, id)); }],
    ["changed controller owner", async (id: string) => { await db.update(heartbeatRuns).set({ controllerBootId: randomUUID() }).where(eq(heartbeatRuns.id, id)); }],
    ["live controller lease", async (id: string) => { await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(heartbeatRuns.id, id)); }],
    ["unsettled local lease", async (id: string) => { await db.insert(environmentLeases).values({ companyId, heartbeatRunId: id, provider: "local", status: "active" }); }],
    ["coordinator", async (id: string) => { const run = await read(id);
      await db.update(heartbeatRuns).set({ nativeIssueId: run.contextSnapshot!.issueId as string }).where(eq(heartbeatRuns.id, id));
      await db.insert(nativeRunFinalizations).values({ companyId, issueId: run.contextSnapshot!.issueId as string, runId: id, phase: "observed" }); }],
    ["receipt for another run", async (id: string) => setResult(id, r => ({ ...r, administrativeStopReconciliation: { ...(r.administrativeStopReconciliation as object), runId: randomUUID() } }))],
    ["receipt for another company", async (id: string) => setResult(id, r => ({ ...r, administrativeStopReconciliation: { ...(r.administrativeStopReconciliation as object), companyId: randomUUID() } }))],
    ["receipt for another boot", async (id: string) => setResult(id, r => ({ ...r, administrativeStopReconciliation: { ...(r.administrativeStopReconciliation as object), controllerBootId: randomUUID() } }))],
    ["receipt claiming proven termination", async (id: string) => setResult(id, r => ({ ...r, administrativeStopReconciliation: { ...(r.administrativeStopReconciliation as object), executorTerminationProven: true } }))],
    ["replaced cancellation record", async (id: string) => setResult(id, r => ({ ...r, cancellation: { ...(r.cancellation as object), recordedAt: new Date().toISOString() } }))],
  ] as const)("predicate rejects a stored receipt after %s", async (_label, mutate) => {
    const run = await historicalShape();
    expect((await reconcile(run)).ok).toBe(true);
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(true);
    await mutate(run.id);
    expect(await isAdministrativelyReconciledStop(db, await read(run.id))).toBe(false);
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(false);
  });

  it("never substitutes for a remote cancelled-run termination receipt", async () => {
    const run = await historicalShape();
    expect((await reconcile(run)).ok).toBe(true);
    const [lease] = await db.insert(environmentLeases).values({ companyId, heartbeatRunId: run.id, provider: "ssh",
      providerLeaseId: "ssh-host", status: "released", cleanupStatus: "success", releasedAt: new Date() }).returning();
    expect(await isAdministrativelyReconciledStop(db, await read(run.id))).toBe(false);
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(false);
    await db.update(environmentLeases).set({ metadata: {
      remoteExecutionTermination: remoteTerminationReceipt(lease!, { providerLeaseId: lease!.providerLeaseId, state: "destroyed" }),
    } }).where(eq(environmentLeases.id, lease!.id));
    // Only the remote receipt, through its own branch, settles a remote run.
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(true);
  });

  it("does not disturb the executor's own receipt path", async () => {
    const run = await historicalShape({ controllerBootId: legacyControllerBootId });
    expect(await recordLegacyStartupCancellationSettled(db, { runId: run.id, companyId, controllerBootId: legacyControllerBootId, adapterEntered: false })).toBe(true);
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(true);
    expect((await reconcile(run)).ok).toBe(false);
  });

  describe("route", () => {
    function app(actor: Record<string, unknown>) {
      const server = express();
      server.use(express.json());
      server.use((req, _res, next) => { (req as unknown as { actor: unknown }).actor = actor; next(); });
      server.use("/api", instanceSettingsRoutes(db));
      server.use(errorHandler);
      return server;
    }
    const admin = { type: "board", userId: "board-admin", source: "session", isInstanceAdmin: true };
    const path = (id: string) => `/api/instance/heartbeat-runs/${id}/administrative-stop-reconciliation`;
    const body = () => ({ companyId, decisionRef: "BLA-4475", reason: "historical cancelled legacy run; controller boot gone" });

    it.each([
      ["agent", { type: "agent", agentId: randomUUID(), companyId: randomUUID(), source: "agent_key" }],
      ["board member without instance admin", { type: "board", userId: "member", source: "session", isInstanceAdmin: false }],
    ])("returns 403 to %s and writes nothing", async (_label, actor) => {
      const run = await historicalShape();
      const res = await request(app(actor)).post(path(run.id)).send(body());
      expect(res.status).toBe(403);
      expect((await read(run.id)).resultJson?.administrativeStopReconciliation).toBeUndefined();
      expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(false);
    });

    it("lets an instance admin reconcile once, with an activity entry", async () => {
      const run = await historicalShape();
      const res = await request(app(admin)).post(path(run.id)).send(body());
      expect(res.status).toBe(200);
      expect(res.body.receipt).toMatchObject({ runId: run.id, companyId, controllerBootId: oldBootId,
        reconciledByActor: { type: "user", id: "board-admin" }, executorTerminationProven: false,
        hostProcessWindow: { result: "clear" } });
      const logged = await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId),
        eq(activityLog.action, "heartbeat_run.administrative_stop_reconciled")));
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({ entityType: "heartbeat_run", entityId: run.id, actorType: "user", actorId: "board-admin" });
      expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(true);
      const again = await request(app(admin)).post(path(run.id)).send(body());
      expect(again.status).toBe(409);
      expect(again.body.details).toMatchObject({ code: "premises_not_met" });
    });

    it("refuses a contradicted run with 409 and an unknown run with 404, logging nothing", async () => {
      const run = await historicalShape({ processPid: 2_000_000_000 });
      expect((await request(app(admin)).post(path(run.id)).send(body())).status).toBe(409);
      expect((await request(app(admin)).post(path(randomUUID())).send(body())).status).toBe(404);
      expect((await request(app(admin)).post(path(run.id)).send({ ...body(), companyId: randomUUID() })).status).toBe(404);
      expect((await request(app(admin)).post(path(run.id)).send({ ...body(), extra: 1 })).status).toBe(400);
      const logged = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
      expect(logged.filter(row => row.action === "heartbeat_run.administrative_stop_reconciled")).toHaveLength(0);
    });
  });
});
