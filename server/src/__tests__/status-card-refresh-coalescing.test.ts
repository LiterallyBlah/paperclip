import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  costEvents,
  createDb,
  documentRevisions,
  documents,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issues,
  statusCards,
  statusCardUpdates,
} from "@paperclipai/db";
import { defaultStatusCardRefreshPolicy } from "@paperclipai/shared";
import { withBuiltInAgentMarker } from "../lib/built-in-agent-metadata.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";
import { STATUS_CARD_REACTIVE_MIN_SPACING_SECONDS } from "../services/status-card-update-engine.js";
import { statusCardService } from "../services/status-cards.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const SPACING_MS = STATUS_CARD_REACTIVE_MIN_SPACING_SECONDS * SECOND;
const WATCHED_QUERY = { scope: "issues", status: ["todo", "in_progress", "in_review", "blocked", "done"], sort: "updated", limit: 50, offset: 0 } as const;
// The shape every live reactive card uses: status transitions and membership
// only, 60 s debounce, at most 6 updates an hour.
const REACTIVE_POLICY = {
  ...defaultStatusCardRefreshPolicy,
  mode: "reactive" as const,
  debounceSeconds: 60,
  maxUpdatesPerHour: 6,
  triggers: { statusTransitions: true, membershipChanges: true, assigneeChanges: false, humanComments: false, anyUpdate: false },
};

describeEmbeddedPostgres("status card refresh coalescing", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-status-card-coalescing-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(costEvents);
    await db.delete(statusCardUpdates);
    await db.delete(statusCards);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(instanceSettings);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCard(refreshPolicy: typeof REACTIVE_POLICY | typeof defaultStatusCardRefreshPolicy = REACTIVE_POLICY) {
    const company = await db.insert(companies)
      .values({ name: "Coalescing Co", issuePrefix: `CC${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning().then((rows) => rows[0]!);
    await db.insert(companyMemberships).values({
      companyId: company.id, principalType: "user", principalId: "board-user", membershipRole: "owner", status: "active",
    });
    await instanceSettingsService(db).updateExperimental({ enableStatusCards: true });
    const summarizer = await db.insert(agents).values({
      companyId: company.id,
      name: "Summarizer",
      role: "general",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
      metadata: withBuiltInAgentMarker(null, { key: "summarizer", featureKeys: ["summarizer"] }),
    }).returning().then((rows) => rows[0]!);
    const watched = await db.insert(issues).values([
      { companyId: company.id, title: "Watched alpha", status: "in_progress", priority: "high" },
      { companyId: company.id, title: "Watched beta", status: "in_progress", priority: "high" },
      { companyId: company.id, title: "Watched gamma", status: "in_progress", priority: "high" },
    ]).returning();
    const card = await db.insert(statusCards).values({
      companyId: company.id,
      createdByUserId: "board-user",
      interestPrompt: "Watched work",
      queries: [WATCHED_QUERY as unknown as (typeof statusCards.$inferSelect.queries)[number]],
      queryVersion: 1,
      refreshPolicy,
      state: "active",
      fingerprint: {},
      nextEvalAt: new Date(Date.now() - SECOND),
    }).returning().then((rows) => rows[0]!);
    return { company, summarizer, watched, card };
  }

  async function readCard(cardId: string) {
    return db.select().from(statusCards).where(eq(statusCards.id, cardId)).then((rows) => rows[0]!);
  }

  async function ledger(cardId: string) {
    const rows = await db.select().from(statusCardUpdates).where(eq(statusCardUpdates.cardId, cardId));
    return rows.filter((row) => row.kind !== "compile").sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime());
  }

  /** A watched issue's status transition, as any writer would record it. */
  async function setStatus(issueId: string, status: string) {
    await db.update(issues).set({ status, updatedAt: new Date() }).where(eq(issues.id, issueId));
  }

  /** Run the scheduler tick every minute over [from, to]; return the generation tasks it started. */
  async function tickEveryMinute(from: number, to: number) {
    const started: Array<typeof issues.$inferSelect> = [];
    for (let at = from; at <= to; at += MINUTE) {
      // Raw writes bypass the issue-change listener, so pass its "changed" hint as production would.
      const tick = await statusCardService(db).tickDueStatusCards(new Date(at), "changed");
      started.push(...tick.enqueued.map((entry) => entry.generatingIssue));
    }
    return started;
  }

  /** The Summarizer's run finishing the generation (a real summary write). */
  async function writeSummary(companyId: string, summarizerId: string, cardId: string, generationIssueId: string) {
    const run = await db.insert(heartbeatRuns).values({ companyId, agentId: summarizerId, status: "running" }).returning().then((rows) => rows[0]!);
    await db.update(issues).set({ checkoutRunId: run.id }).where(eq(issues.id, generationIssueId));
    return statusCardService(db).writeSummary(cardId, {
      markdown: "Status summary.",
      changeSummary: "Summarised watched work.",
      generationIssueId,
      model: "gpt-5.4",
    }, { agentId: summarizerId, runId: run.id });
  }

  function generationChanges(generation: typeof issues.$inferSelect) {
    const payload = JSON.parse(generation.description!.match(/```json\n([\s\S]*?)\n```/)![1]!) as { changes: Array<{ issueId: string; changeKind: string; to: string | null }> };
    return payload.changes;
  }

  /** Initial generation for a fresh card, written back so the card has a baseline summary. */
  async function settleInitialGeneration() {
    const seeded = await seedCard();
    const now = Date.now();
    const first = await tickEveryMinute(now, now + 3 * MINUTE);
    expect(first).toHaveLength(1);
    await writeSummary(seeded.company.id, seeded.summarizer.id, seeded.card.id, first[0]!.id);
    return { ...seeded, writtenAt: (await readCard(seeded.card.id)).lastGeneratedAt!.getTime() };
  }

  it("initial generation: a never-generated card runs after its debounce, with no spacing delay", async () => {
    const { card } = await seedCard();
    const now = Date.now();
    const started = await tickEveryMinute(now, now + 3 * MINUTE);
    expect(started).toHaveLength(1);
    expect(generationChanges(started[0]!).map((change) => change.changeKind)).toEqual(["new", "new", "new"]);
    const [row] = await ledger(card.id);
    expect(row).toMatchObject({ trigger: "reactive", status: "running" });
  });

  it("no-op events (timestamp bumps, agent comments, run churn, human comments the card ignores) start no generation", async () => {
    const { company, summarizer, watched, card, writtenAt } = await settleInitialGeneration();
    const issueCount = (await db.select().from(issues)).length;
    const rows = (await ledger(card.id)).length;
    // Heartbeat/run churn and timestamp-only updates on every watched issue.
    for (const issue of watched) {
      await db.update(issues).set({ updatedAt: new Date(writtenAt + 5 * SECOND) }).where(eq(issues.id, issue.id));
      await db.insert(issueComments).values({ companyId: company.id, issueId: issue.id, authorAgentId: summarizer.id, body: "Agent progress note." });
      await db.insert(issueComments).values({ companyId: company.id, issueId: issue.id, authorUserId: "board-user", body: "Human note." });
      await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: summarizer.id, status: "succeeded" });
    }
    // Well past both the debounce and the spacing window.
    const started = await tickEveryMinute(writtenAt + MINUTE, writtenAt + SPACING_MS + 10 * MINUTE);
    expect(started).toHaveLength(0);
    expect((await ledger(card.id)).length).toBe(rows);
    expect((await db.select().from(issues)).length).toBe(issueCount);
    expect(await readCard(card.id)).toMatchObject({ generatingIssueId: null, pendingChangeCount: 0, state: "active" });
  });

  it("a burst of N meaningful changes after a generation becomes one generation that carries all N", async () => {
    const { watched, card, writtenAt } = await settleInitialGeneration();
    // Five status transitions a few minutes apart (each longer than the 60 s
    // debounce, which is what used to make every one its own generation).
    const steps: Array<[number, number, "blocked" | "in_review" | "done" | "in_progress"]> = [
      [2, 0, "blocked"], [5, 1, "in_review"], [8, 2, "blocked"], [11, 0, "in_progress"], [14, 0, "done"],
    ];
    const started: Array<typeof issues.$inferSelect> = [];
    let cursor = writtenAt + MINUTE;
    for (const [minute, index, status] of steps) {
      const at = writtenAt + minute * MINUTE;
      started.push(...await tickEveryMinute(cursor, at - SECOND));
      await setStatus(watched[index]!.id, status);
      cursor = at;
    }
    started.push(...await tickEveryMinute(cursor, writtenAt + SPACING_MS + 3 * MINUTE));
    expect(started).toHaveLength(1);
    // Not before the spacing window since the last written summary.
    const generationRow = (await ledger(card.id)).at(-1)!;
    expect(generationRow.generationIssueId).toBe(started[0]!.id);
    const changes = generationChanges(started[0]!);
    expect(changes.map((change) => [change.issueId, change.to]).sort()).toEqual([
      [watched[0]!.id, "done"],
      [watched[1]!.id, "in_review"],
      [watched[2]!.id, "blocked"],
    ].sort());
    const card2 = await readCard(card.id);
    expect(card2.generatingIssueId).toBe(started[0]!.id);
  });

  it("a change during a generation is not merged into it and produces exactly one follow-up", async () => {
    const { company, summarizer, watched, card, writtenAt } = await settleInitialGeneration();
    await setStatus(watched[0]!.id, "blocked");
    const firstWave = await tickEveryMinute(writtenAt + MINUTE, writtenAt + SPACING_MS + 2 * MINUTE);
    expect(firstWave).toHaveLength(1);
    const running = firstWave[0]!;
    expect(generationChanges(running).map((change) => change.issueId)).toEqual([watched[0]!.id]);

    // Two changes land while the generation is running.
    await setStatus(watched[1]!.id, "done");
    await setStatus(watched[2]!.id, "blocked");
    const during = await tickEveryMinute(writtenAt + SPACING_MS + 3 * MINUTE, writtenAt + SPACING_MS + 5 * MINUTE);
    expect(during).toHaveLength(0);
    // The running generation's payload is unchanged.
    const reread = await db.select().from(issues).where(eq(issues.id, running.id)).then((rows) => rows[0]!);
    expect(generationChanges(reread).map((change) => change.issueId)).toEqual([watched[0]!.id]);

    await writeSummary(company.id, summarizer.id, card.id, running.id);
    const secondWrittenAt = (await readCard(card.id)).lastGeneratedAt!.getTime();
    const followUps = await tickEveryMinute(secondWrittenAt + MINUTE, secondWrittenAt + 2 * SPACING_MS);
    expect(followUps).toHaveLength(1);
    expect(generationChanges(followUps[0]!).map((change) => change.issueId).sort()).toEqual([watched[1]!.id, watched[2]!.id].sort());
    expect((await ledger(card.id)).map((row) => row.status)).toEqual(["ok", "ok", "running"]);
  });

  it("an isolated change after a quiet spell stays fresh: generated within the debounce, not the spacing window", async () => {
    const { watched, card, writtenAt } = await settleInitialGeneration();
    const changedAt = writtenAt + SPACING_MS + 30 * MINUTE;
    expect(await tickEveryMinute(writtenAt + MINUTE, changedAt - SECOND)).toHaveLength(0);
    await setStatus(watched[0]!.id, "blocked");
    const started = await tickEveryMinute(changedAt, changedAt + 3 * MINUTE);
    expect(started).toHaveLength(1);
    const row = (await ledger(card.id)).at(-1)!;
    expect(row.generationIssueId).toBe(started[0]!.id);
  });

  it("a manual refresh still runs immediately inside the spacing window", async () => {
    const { watched, card, writtenAt } = await settleInitialGeneration();
    await setStatus(watched[0]!.id, "blocked");
    expect(await tickEveryMinute(writtenAt + MINUTE, writtenAt + 4 * MINUTE)).toHaveLength(0);
    const manual = await statusCardService(db).requestRefresh(card.id, {
      actor: { agentId: null, userId: "board-user" },
      now: new Date(writtenAt + 5 * MINUTE),
    });
    expect(manual).toMatchObject({ enqueued: true });
    expect((await ledger(card.id)).at(-1)).toMatchObject({ trigger: "manual", status: "running" });
  });

  it("an abandoned generation is still retried with backoff, and the retry then generates", async () => {
    const { watched, card, writtenAt } = await settleInitialGeneration();
    await setStatus(watched[0]!.id, "blocked");
    const [generation] = await tickEveryMinute(writtenAt + MINUTE, writtenAt + SPACING_MS + 2 * MINUTE);
    expect(generation).toBeDefined();
    const abandonedAt = Date.now();
    await issueService(db).update(generation!.id, { status: "cancelled" });
    await statusCardService(db).tickDueStatusCards(new Date(abandonedAt + SECOND));
    const parked = await readCard(card.id);
    expect(parked).toMatchObject({ state: "error", generatingIssueId: null });
    expect(parked.nextEvalAt).not.toBeNull();
    const retries = await tickEveryMinute(parked.nextEvalAt!.getTime() + SECOND, parked.nextEvalAt!.getTime() + SPACING_MS + 2 * MINUTE);
    expect(retries).toHaveLength(1);
    expect(generationChanges(retries[0]!).map((change) => change.issueId)).toEqual([watched[0]!.id]);
    expect((await ledger(card.id)).map((row) => row.status)).toEqual(["ok", "failed", "running"]);
  });

  it("interval cards keep their own cadence; spacing applies to reactive cards only", async () => {
    const { card } = await seedCard({ ...defaultStatusCardRefreshPolicy, mode: "interval", intervalMinutes: 15 });
    await db.update(statusCards).set({ lastGeneratedAt: new Date(Date.now() - MINUTE) }).where(eq(statusCards.id, card.id));
    const tick = await statusCardService(db).tickDueStatusCards(new Date());
    expect(tick.enqueued.map((entry) => entry.cardId)).toEqual([card.id]);
  });
});
