import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import {
  activityLog,
  applyPendingMigrations,
  companies,
  createDb,
  goals,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { setPluginEventBus } from "../services/activity-log.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { createPluginEventBus } from "../services/plugin-event-bus.js";
import {
  configurePluginDecisionEvents,
  INTERACTION_CREATED_EVENT,
  resetPluginDecisionEventsForTests,
} from "../services/plugin-decision-events.js";

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_INTERACTIONS_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The interaction service publishes `issue.thread_interaction_created` to
// subscribed plugins through the real event bus, once per created row, only
// after the inserting transaction commits.
describeEmbeddedPostgres("interaction created plugin event (real Postgres + event bus)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let received: PluginEvent[] = [];

  beforeAll(async () => {
    if (externalUrl) await applyPendingMigrations(externalUrl);
    else tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-decision-events-");
    db = createDb(externalUrl ?? tempDb!.connectionString);
  }, 20_000);

  function wire(subscribe = true) {
    received = [];
    const bus = createPluginEventBus();
    if (subscribe) {
      bus.forPlugin("test-notifier").subscribe(INTERACTION_CREATED_EVENT, async (event) => {
        received.push(event);
      });
    }
    setPluginEventBus(bus);
    configurePluginDecisionEvents({
      db,
      bus,
      commitCheckDelaysMs: [20, 300],
      xactBackoffMs: [20, 50],
    });
  }

  afterEach(async () => {
    resetPluginDecisionEventsForTests();
    await db.delete(issueThreadInteractions);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  async function seedIssue() {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
    await db.insert(goals).values({ id: goalId, companyId, title: "Goal", level: "task", status: "active" });
    await db.insert(issues).values({ id: issueId, companyId, goalId, title: "Parent issue", status: "in_progress", priority: "medium" });
    return { id: issueId, companyId };
  }

  const confirmation = (idempotencyKey: string) => ({
    kind: "request_confirmation" as const,
    idempotencyKey,
    payload: { version: 1 as const, prompt: "Proceed with the SECRET plan?" },
  });

  it("publishes one event per created card to a subscribed plugin, none for an idempotent replay", async () => {
    wire();
    const issue = await seedIssue();
    const svc = issueThreadInteractionService(db);
    const created = await svc.create(issue, confirmation("pde:one"), { userId: "local-board" });
    await sleep(150);
    expect(received).toHaveLength(1);
    const [event] = received;
    expect(event).toMatchObject({
      eventType: INTERACTION_CREATED_EVENT,
      entityType: "issue",
      entityId: issue.id,
      companyId: issue.companyId,
      actorType: "user",
      actorId: "local-board",
    });
    expect(event.payload).toMatchObject({
      interactionId: created.id,
      interactionKind: "request_confirmation",
      interactionStatus: "pending",
      addresseeAgentId: null,
      addresseeUserId: null,
      source: "interaction_service",
    });
    expect(JSON.stringify(event)).not.toContain("SECRET");

    const replay = await svc.create(issue, confirmation("pde:one"), { userId: "local-board" });
    expect(replay.id).toBe(created.id);
    await sleep(150);
    expect(received).toHaveLength(1);
  });

  it("waits for the inserting transaction to commit, and drops a rolled-back card", async () => {
    wire();
    const issue = await seedIssue();
    let createdId: string | null = null;
    await db.transaction(async (tx) => {
      const created = await issueThreadInteractionService(tx as unknown as typeof db)
        .create(issue, confirmation("pde:tx"), { userId: "local-board" });
      createdId = created.id;
      await sleep(150);
      expect(received).toHaveLength(0);
    });
    await sleep(200);
    expect(received.map((event) => (event.payload as { interactionId: string }).interactionId)).toEqual([createdId]);

    received = [];
    await expect(db.transaction(async (tx) => {
      await issueThreadInteractionService(tx as unknown as typeof db)
        .create(issue, confirmation("pde:rollback"), { userId: "local-board" });
      throw new Error("roll back");
    })).rejects.toThrow("roll back");
    await sleep(400);
    expect(received).toHaveLength(0);
  });

  it("does not build or send the event when no plugin subscribes", async () => {
    wire(false);
    const issue = await seedIssue();
    await issueThreadInteractionService(db).create(issue, confirmation("pde:none"), { userId: "local-board" });
    await sleep(150);
    expect(received).toHaveLength(0);
  });
});
