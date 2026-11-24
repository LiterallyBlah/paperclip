// @ts-nocheck -- ported JS test (loosely typed harness); not part of the server tsc project.
// Unit tests for plugin-decision-events (fork source of the 2026.1106.0 host
// overlay cov-70ebed05): interaction-created and blocker-attention plugin events.
// Ported from the overlay's node:test suite; the logic under test is unchanged.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import { PLUGIN_EVENT_TYPES } from "@paperclipai/shared";
import * as events from "../services/plugin-decision-events.js";
import * as activity from "../services/activity-log.js";
import { createPluginEventBus } from "../services/plugin-event-bus.js";

const SERVICES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../services");
const db = {} as any;

const COMPANY = "00000000-0000-4000-8000-000000000001";
const T1 = "00000000-0000-4000-8000-0000000000a1";
const T2 = "00000000-0000-4000-8000-0000000000a2";
const B1 = "00000000-0000-4000-8000-0000000000b1";
const B2 = "00000000-0000-4000-8000-0000000000b2";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function blocked(id, attention, updatedAt = "2026-03-01T00:00:00.000Z") {
  return { id, companyId: COMPANY, status: "blocked", updatedAt: new Date(updatedAt), blockerAttention: attention };
}
const stalled = (terminal, extra = {}) => ({ state: "stalled", blockingTreeLive: false, terminalBlockerIssueId: terminal, ...extra });

function harness({ subscribed = true, background = true } = {}) {
  const published = [];
  let evaluations = 0;
  const state = { blocked: [], terminals: new Map(), background };
  const bus = { hasSubscriber: (type) => subscribed && type === events.BLOCKER_ATTENTION_CHANGED_EVENT };
  events.configurePluginDecisionEvents({
    db,
    bus,
    debounceMs: 5,
    isBackgroundWorkEnabled: () => state.background,
    listBlockedIssues: async () => {
      evaluations += 1;
      return state.blocked;
    },
    loadIssueTimestamps: async (_db, _company, ids) => new Map(ids.filter((id) => state.terminals.has(id)).map((id) => [id, { id, updatedAt: state.terminals.get(id) }])),
    publish: (event) => published.push(event),
  });
  return { published, state, evaluations: () => evaluations };
}

async function cause(eventType = null) {
  events.noteBlockerAttentionCause(COMPANY, eventType);
  await sleep(30);
}

afterEach(() => events.resetPluginDecisionEventsForTests());

describe("registration", () => {
  it("registers the three event names once each, next to the existing ones", () => {
    for (const name of ["issue.thread_interaction_created", "issue.blocker_attention_changed", "decision.created"]) {
      assert.equal(PLUGIN_EVENT_TYPES.filter((entry) => entry === name).length, 1, name);
    }
    assert.ok(PLUGIN_EVENT_TYPES.includes("approval.created"));
  });
});

describe("interaction call sites", () => {
  it("all 6 call sites await the publish and pass the handle that inserted the row", async () => {
    const sites: Record<string, string[]> = {
      "issue-thread-interactions.ts": ["db", "db"],
      "tool-gateway.ts": ["db"],
      "secret-proposals.ts": ["txDb", "txDb"],
      "tool-access/oauth/authorization-start.ts": ["db"],
    };
    let total = 0;
    for (const [rel, handles] of Object.entries(sites)) {
      const text = await readFile(path.join(SERVICES_DIR, rel), "utf8");
      const calls = [...text.matchAll(/(\S+\s+)publishInteractionCreatedPluginEvent\(([\s\S]*?)\);/g)];
      assert.equal(calls.length, handles.length, rel);
      calls.forEach((m, i) => {
        assert.match(m[1], /^await\s+$/, `${rel} call ${i} is awaited`);
        const args = m[2].replace(/\s+/g, " ").trim().replace(/,$/, "");
        assert.ok(args.endsWith(`, ${handles[i]}`), `${rel} call ${i} passes ${handles[i]}: ${args}`);
      });
      total += calls.length;
    }
    assert.equal(total, 6);
  });
});

describe("interaction choke point", () => {
  function wire({ rows = new Map(), subscribed = true } = {}) {
    const published = [];
    events.configurePluginDecisionEvents({
      db,
      bus: { hasSubscriber: (type) => subscribed && type === events.INTERACTION_CREATED_EVENT },
      commitCheckDelaysMs: [5, 20],
      loadInteraction: async (_db, _company, id) => rows.get(id) ?? null,
      publish: (e) => published.push(e),
    });
    return published;
  }

  it("publishes one event, after the row is committed, with addressee keys always present and no text", async () => {
    const published = wire({ rows: new Map([["i1", { id: "i1", status: "pending" }]]) });
    events.publishInteractionCreatedPluginEvent(
      { id: "i1", companyId: COMPANY, issueId: T1, kind: "ask_user_questions", status: "pending", continuationPolicy: "wake_assignee", title: "SECRET", summary: "SECRET", payload: { prompt: "SECRET" } },
      { agentId: "agent-1", runId: "run-1" },
    );
    assert.equal(published.length, 0, "not published synchronously");
    await sleep(40);
    assert.equal(published.length, 1);
    const [event] = published;
    assert.equal(event.eventType, "issue.thread_interaction_created");
    assert.equal(event.entityType, "issue");
    assert.equal(event.entityId, T1);
    assert.equal(event.actorType, "agent");
    assert.ok(Object.hasOwn(event.payload, "addresseeAgentId"));
    assert.equal(event.payload.addresseeAgentId, null);
    assert.equal(event.payload.addresseeUserId, null);
    assert.equal(event.payload.toolActionRequestId, null);
    assert.ok(!JSON.stringify(event).includes("SECRET"));
  });

  it("carries the agent addressee and the tool action request id", async () => {
    const published = wire({ rows: new Map([["i2", { status: "pending" }], ["i3", { status: "pending" }]]) });
    events.publishInteractionCreatedPluginEvent({ id: "i2", companyId: COMPANY, issueId: T1, kind: "request_confirmation", status: "pending", addresseeAgentId: "agent-2" });
    events.publishInteractionCreatedPluginEvent({ id: "i3", companyId: COMPANY, issueId: T1, kind: "request_confirmation", status: "pending", payload: { toolAction: { actionRequestId: "ar-1" } } }, { userId: "user-1" });
    await sleep(40);
    const byId = new Map(published.map((e) => [e.payload.interactionId, e]));
    assert.equal(byId.get("i2").payload.addresseeAgentId, "agent-2");
    assert.equal(byId.get("i3").payload.toolActionRequestId, "ar-1");
    assert.equal(byId.get("i3").actorType, "user");
  });

  it("waits for a late commit, and drops a rolled-back row", async () => {
    const rows = new Map();
    const published = wire({ rows });
    events.publishInteractionCreatedPluginEvent({ id: "late", companyId: COMPANY, issueId: T1, status: "pending" });
    events.publishInteractionCreatedPluginEvent({ id: "rolled-back", companyId: COMPANY, issueId: T1, status: "pending" });
    await sleep(10);
    rows.set("late", { status: "pending" });
    await sleep(60);
    assert.deepEqual(published.map((e) => e.payload.interactionId), ["late"]);
  });

  function wireTx({ statuses, rows = new Map(), capture = async () => "777", maxWaitMs = 10_000, clock } = {}) {
    const published = [];
    const statusCalls = [];
    events.configurePluginDecisionEvents({
      db,
      bus: { hasSubscriber: (type) => type === events.INTERACTION_CREATED_EVENT },
      commitCheckDelaysMs: [5, 20],
      xactBackoffMs: [5, 10],
      xactMaxWaitMs: maxWaitMs,
      now: clock,
      captureXactId: capture,
      loadXactStatus: async (_db, xid) => {
        statusCalls.push(xid);
        const next = statuses.shift();
        if (next instanceof Error) throw next;
        return next ?? "in progress";
      },
      loadInteraction: async (_db, _company, id) => rows.get(id) ?? null,
      publish: (e) => published.push(e),
    });
    return { published, statusCalls };
  }

  it("F4: follows the inserting transaction: in progress (any length) -> committed -> 1 event", async () => {
    const h = wireTx({ statuses: ["in progress", "in progress", "in progress", "committed"], rows: new Map([["c1", { status: "pending" }]]) });
    await events.publishInteractionCreatedPluginEvent({ id: "c1", companyId: COMPANY, issueId: T1, status: "pending" }, {}, { handle: "tx" });
    await sleep(80);
    assert.deepEqual(h.statusCalls, ["777", "777", "777", "777"]);
    assert.deepEqual(h.published.map((e) => e.payload.interactionId), ["c1"]);
  });

  it("aborted -> 0; committed but the row is gone (rolled-back savepoint) -> 0", async () => {
    const h = wireTx({ statuses: ["aborted", "committed"] });
    await events.publishInteractionCreatedPluginEvent({ id: "c2", companyId: COMPANY, issueId: T1, status: "pending" }, {}, {});
    await events.publishInteractionCreatedPluginEvent({ id: "c3", companyId: COMPANY, issueId: T1, status: "pending" }, {}, {});
    await sleep(60);
    assert.equal(h.published.length, 0);
  });

  it("a status read error is retried, not treated as a rollback", async () => {
    const h = wireTx({ statuses: [new Error("db blip"), "committed"], rows: new Map([["c4", { status: "pending" }]]) });
    await events.publishInteractionCreatedPluginEvent({ id: "c4", companyId: COMPANY, issueId: T1, status: "pending" }, {}, {});
    await sleep(60);
    assert.equal(h.published.length, 1);
  });

  it("a transaction still open at the maximum wait -> 0 and stops checking (the one documented cutoff)", async () => {
    let t = 0;
    const h = wireTx({ statuses: [], maxWaitMs: 1000, clock: () => (t += 300) });
    await events.publishInteractionCreatedPluginEvent({ id: "c5", companyId: COMPANY, issueId: T1, status: "pending" }, {}, {});
    await sleep(100);
    const calls = h.statusCalls.length;
    await sleep(50);
    assert.equal(h.statusCalls.length, calls, "no further checks after the cutoff");
    assert.ok(calls >= 1 && calls <= 4);
    assert.equal(h.published.length, 0);
  });

  it("no open transaction on the handle (null id) or an unreadable id -> the row-visibility check decides", async () => {
    const rows = new Map([["c6", { status: "pending" }], ["c7", { status: "pending" }]]);
    let h = wireTx({ statuses: [], rows, capture: async () => null });
    await events.publishInteractionCreatedPluginEvent({ id: "c6", companyId: COMPANY, issueId: T1, status: "pending" }, {}, {});
    await sleep(40);
    assert.deepEqual(h.published.map((e) => e.payload.interactionId), ["c6"]);
    assert.equal(h.statusCalls.length, 0);
    events.resetPluginDecisionEventsForTests();
    h = wireTx({ statuses: [], rows, capture: async () => { throw new Error("no execute"); } });
    await events.publishInteractionCreatedPluginEvent({ id: "c7", companyId: COMPANY, issueId: T1, status: "pending" }, {}, {});
    await sleep(40);
    assert.deepEqual(h.published.map((e) => e.payload.interactionId), ["c7"]);
  });

  it("publishes nothing without a subscriber, or for an incomplete row, and never throws", async () => {
    let published = wire({ rows: new Map([["i4", { status: "pending" }]]), subscribed: false });
    events.publishInteractionCreatedPluginEvent({ id: "i4", companyId: COMPANY, issueId: T1, status: "pending" });
    await sleep(40);
    assert.equal(published.length, 0);
    events.resetPluginDecisionEventsForTests();
    published = wire();
    events.publishInteractionCreatedPluginEvent(undefined);
    events.publishInteractionCreatedPluginEvent({ id: "i5" });
    await sleep(40);
    assert.equal(published.length, 0);
  });
});

describe("computed blocker attention", () => {
  it("entering the feed -> 1 event with the feed dedupKey and activityAt", async () => {
    const h = harness();
    h.state.blocked = [blocked(B1, stalled(T1))];
    h.state.terminals.set(T1, new Date("2026-03-05T00:00:00.000Z"));
    await cause();
    assert.equal(h.published.length, 1);
    const [event] = h.published;
    assert.equal(event.eventType, "issue.blocker_attention_changed");
    assert.equal(event.entityId, T1);
    assert.deepEqual(
      { state: event.payload.state, live: event.payload.blockingTreeLive, key: event.payload.dedupKey, at: event.payload.activityAt, blocked: event.payload.blockedIssueId, entered: event.payload.entered },
      { state: "stalled", live: false, key: `blocker:${T1}`, at: "2026-03-05T00:00:00.000Z", blocked: B1, entered: true },
    );
  });

  it("repeat evaluations with an unchanged item -> 0 more", async () => {
    const h = harness();
    h.state.blocked = [blocked(B1, stalled(T1))];
    h.state.terminals.set(T1, new Date("2026-03-05T00:00:00.000Z"));
    await cause();
    await cause();
    await cause();
    assert.equal(h.published.length, 1);
    assert.equal(h.evaluations(), 3);
  });

  it("live tree, covered and none states -> 0", async () => {
    const h = harness();
    h.state.blocked = [
      blocked(B1, stalled(T1, { blockingTreeLive: true })),
      blocked(B2, { state: "covered", blockingTreeLive: false, terminalBlockerIssueId: T2 }),
      blocked("b3", { state: "none" }),
    ];
    h.state.terminals.set(T1, new Date()).set(T2, new Date());
    await cause();
    assert.equal(h.published.length, 0);
  });

  it("groups by terminal blocker and needs the terminal row (mirrors attention.js)", async () => {
    const h = harness();
    h.state.blocked = [
      blocked(B1, stalled(T1), "2026-03-01T00:00:00.000Z"),
      blocked(B2, { ...stalled(T1), state: "needs_attention" }, "2026-03-02T00:00:00.000Z"),
      blocked("b-missing-terminal", stalled(T2)),
    ];
    h.state.terminals.set(T1, new Date("2026-03-05T00:00:00.000Z"));
    await cause();
    assert.equal(h.published.length, 1);
    assert.equal(h.published[0].payload.blockedIssueId, B2);
    assert.equal(h.published[0].payload.state, "needs_attention");
  });

  it("a moved activityAt while the item stays in the feed -> 0; leaving -> exit event; re-entering -> entry", async () => {
    const h = harness();
    h.state.blocked = [blocked(B1, stalled(T1))];
    h.state.terminals.set(T1, new Date("2026-03-05T00:00:00.000Z"));
    await cause();
    assert.equal(h.published[0].payload.baseline, true, "first evaluation after boot is the baseline");
    h.state.terminals.set(T1, new Date("2026-03-06T00:00:00.000Z"));
    await cause();
    assert.equal(h.published.length, 1, "terminal edit while in the feed is a repeat");
    h.state.blocked = [blocked(B1, stalled(T1, { blockingTreeLive: true }))];
    await cause();
    assert.equal(h.published.length, 2);
    assert.deepEqual({ entered: h.published[1].payload.entered, key: h.published[1].payload.dedupKey, state: h.published[1].payload.state },
      { entered: false, key: `blocker:${T1}`, state: null });
    h.state.blocked = [blocked(B1, stalled(T1))];
    await cause();
    assert.equal(h.published.length, 3);
    assert.deepEqual({ entered: h.published[2].payload.entered, baseline: h.published[2].payload.baseline, at: h.published[2].payload.activityAt },
      { entered: true, baseline: false, at: "2026-03-06T00:00:00.000Z" });
  });

  it("coalesces a burst of causes into one evaluation", async () => {
    const h = harness();
    for (let i = 0; i < 20; i += 1) events.noteBlockerAttentionCause(COMPANY, "agent.run.finished");
    await sleep(40);
    assert.equal(h.evaluations(), 1);
  });

  it("does nothing without a subscriber, during standby/drain, or for its own event", async () => {
    let h = harness({ subscribed: false });
    await cause();
    assert.equal(h.evaluations(), 0);
    events.resetPluginDecisionEventsForTests();
    h = harness({ background: false });
    await cause();
    assert.equal(h.evaluations(), 0);
    events.resetPluginDecisionEventsForTests();
    h = harness();
    await cause("issue.blocker_attention_changed");
    assert.equal(h.evaluations(), 0);
  });

  it("is driven by the existing publication paths (activity rows and plugin domain events)", async () => {
    const h = harness();
    const emitted = [];
    activity.setPluginEventBus({ emit: async (event) => { emitted.push(event); return { errors: [] }; } });
    activity.publishActivity({ companyId: COMPANY, payload: { action: "issue.updated" }, pluginEvent: null });
    await sleep(30);
    assert.equal(h.evaluations(), 1);
    activity.publishPluginDomainEvent({ eventId: "e", eventType: "agent.run.finished", companyId: COMPANY, occurredAt: new Date().toISOString(), payload: {} });
    await sleep(30);
    assert.equal(h.evaluations(), 2);
    assert.equal(emitted.length, 1);
  });

  it("an evaluation failure is logged, not thrown, and the next cause retries", async () => {
    const h = harness();
    let fail = true;
    events.configurePluginDecisionEvents({
      db, bus: { hasSubscriber: () => true }, debounceMs: 5,
      listBlockedIssues: async () => { if (fail) throw new Error("db down"); return [blocked(B1, stalled(T1))]; },
      loadIssueTimestamps: async () => new Map([[T1, { id: T1, updatedAt: new Date("2026-03-05T00:00:00.000Z") }]]),
      publish: (e) => h.published.push(e),
    });
    await cause();
    assert.equal(h.published.length, 0);
    fail = false;
    await cause();
    assert.equal(h.published.length, 1);
  });
});

describe("plugin event bus hasSubscriber", () => {
  it("matches exact names and respects a company filter", () => {
    const bus = createPluginEventBus();
    assert.equal(bus.hasSubscriber("issue.blocker_attention_changed", COMPANY), false);
    bus.forPlugin("p1").subscribe("issue.blocker_attention_changed", { companyId: "other" }, async () => {});
    assert.equal(bus.hasSubscriber("issue.blocker_attention_changed", COMPANY), false);
    bus.forPlugin("p2").subscribe("issue.blocker_attention_changed", async () => {});
    assert.equal(bus.hasSubscriber("issue.blocker_attention_changed", COMPANY), true);
    assert.equal(bus.hasSubscriber("issue.updated", COMPANY), false);
  });
});
