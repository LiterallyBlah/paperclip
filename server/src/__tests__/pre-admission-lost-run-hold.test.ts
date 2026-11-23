import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, issueRecoveryActions } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedPreAdmissionLostRun } from "./helpers/pre-admission-lost-run-fixture.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { legacyExecutionNeedsReconciliationWithEvidence, terminalizeLegacyExecution } from "../services/legacy-execution-recovery.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("pre-admission lost legacy run hold", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("pre-admission-lost-run-hold-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); });

  it("does not raise a reconciliation hold for the f8e0a4d4 shape", async () => {
    const f = await seedPreAdmissionLostRun(db);
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, f.run)).toBe(false);
    await terminalizeLegacyExecution({ db, run: f.run, status: "failed", reconcileIfNeeded: true });
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId))).toHaveLength(0);
  });

  it("no longer treats an existing f8e0a4d4-shape hold as an execution blocker, keeping its audit row", async () => {
    const f = await seedPreAdmissionLostRun(db, { withHold: true });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId)))[0])
      .toMatchObject({ status: "resolved", outcome: "blocked", evidence: { automaticRecovery: { replay: "blocked" } } });
  });

  it("still holds an admitted run", async () => {
    const f = await seedPreAdmissionLostRun(db, { phase: "admitted", withHold: true });
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, f.run)).toBe(true);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ recoveryActionId: f.actionId });
  });

  it("still holds a pre-admission-shaped run whose hold names another issue", async () => {
    const f = await seedPreAdmissionLostRun(db, { withHold: true });
    const other = await seedPreAdmissionLostRun(db);
    await db.update(issueRecoveryActions).set({ evidence: { runId: other.runId,
      automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } } }).where(eq(issueRecoveryActions.id, f.actionId));
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ recoveryActionId: f.actionId });
  });
});
