// Plugin-event coverage for decision notifications (fork source of the
// 2026.1106.0 host overlay `cov-70ebed05`).
//
// Two plugin-event sources:
//
// 1. `issue.thread_interaction_created` from the interaction service's own
//    "row created" exits, so every card (route, plugin, native bridge, runner,
//    status committer, tool gateway, onboarding, connection intents, ...)
//    produces exactly one plugin event that carries the addressee fields.
//    The activity rows that already exist are unchanged; activity-log no
//    longer maps that action to a plugin event, so nothing is sent twice.
//
// 2. `issue.blocker_attention_changed` when a computed blocker-attention item
//    (board attention feed: blocked issue, blockerAttention.state in
//    {stalled, needs_attention}, !blockingTreeLive, grouped by terminal
//    blocker) enters the feed (`entered: true`) and when it leaves it
//    (`entered: false`). Staying in the feed is not a new event. There is no new timer loop: re-evaluation is
//    driven by the activity and plugin-event publications that already
//    happen when the causes change (issue status/assignee/relations, run
//    lifecycle, agent status, recovery actions). Evaluations are coalesced
//    per company (one trailing evaluation per DEBOUNCE_MS, never two at once)
//    and only run while some plugin subscribes to the event.
//
// The interaction event is published only after the inserting transaction has
// committed, and only while a plugin subscribes. The creating call site passes
// the database handle it inserted with; this module reads that transaction's id
// (`pg_current_xact_id_if_assigned()`) on the same handle and then follows its
// outcome from the root connection (`pg_xact_status()`): committed -> publish
// once the row is visible, aborted -> nothing. There is no fixed visibility
// deadline on that path; a transaction still open after XACT_MAX_WAIT_MS is the
// one documented cutoff. A NULL id means the handle had no open transaction (the
// insert autocommitted), so the row-visibility check alone decides.
//
// Payloads carry ids, kinds, states and timestamps only: no titles, text or
// question content.
import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { logger } from "../middleware/logger.js";
import { publishPluginDomainEvent, setPluginDomainActivityObserver } from "./activity-log.js";

export const INTERACTION_CREATED_EVENT = "issue.thread_interaction_created";
export const BLOCKER_ATTENTION_CHANGED_EVENT = "issue.blocker_attention_changed";
const DEFAULT_DEBOUNCE_MS = 2000;
// Row-visibility checks: used when the insert autocommitted (NULL xact id), after
// a committed outcome, and as the degraded path when no handle was passed or the
// xact id could not be read (bounded).
const DEFAULT_COMMIT_CHECK_DELAYS_MS = [250, 3000];
// Follow-up schedule for a transaction that is still in progress (last step repeats).
const DEFAULT_XACT_BACKOFF_MS = [250, 1000, 3000, 10000, 30000, 60000];
const DEFAULT_XACT_MAX_WAIT_MS = 60 * 60 * 1000;

/** A database handle that can run raw SQL: the root db or a transaction. */
export type PluginDecisionDbHandle = Pick<Db, "execute">;

export interface PluginDecisionEventBus {
  hasSubscriber(eventType: string, companyId?: string): boolean;
}

export interface InteractionRowStatus {
  id: string;
  status: string | null;
}

export interface BlockedIssueForAttention {
  id: string;
  updatedAt: Date | string;
  blockerAttention?: {
    state?: string | null;
    blockingTreeLive?: boolean;
    terminalBlockerIssueId?: string | null;
  } | null;
}

export interface IssueTimestamp {
  id: string;
  updatedAt: Date | string;
}

export interface BlockerAttentionItem {
  terminalBlockerIssueId: string;
  blockedIssueId: string;
  state: string;
  dedupKey: string;
  activityAt: string;
}

export interface PluginDecisionEventsInput {
  db: Db;
  bus: PluginDecisionEventBus | null;
  isBackgroundWorkEnabled?: () => boolean;
  debounceMs?: number;
  commitCheckDelaysMs?: number[];
  loadInteraction?: (db: Db, companyId: string, interactionId: string) => Promise<InteractionRowStatus | null>;
  captureXactId?: (handle: PluginDecisionDbHandle) => Promise<string | null>;
  loadXactStatus?: (db: Db, xactId: string) => Promise<string | null>;
  xactBackoffMs?: number[];
  xactMaxWaitMs?: number;
  now?: () => number;
  listBlockedIssues?: (db: Db, companyId: string) => Promise<BlockedIssueForAttention[]>;
  loadIssueTimestamps?: (db: Db, companyId: string, issueIds: string[]) => Promise<Map<string, IssueTimestamp>>;
  publish?: (event: PluginEvent) => void;
}

type PluginDecisionEventsContext = Required<Omit<PluginDecisionEventsInput, "bus">> & {
  bus: PluginDecisionEventBus | null;
};

interface CompanyState {
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  dirty: boolean;
  known: Map<string, BlockerAttentionItem> | null;
}

/** The interaction fields this module reads (a created row or a hydrated interaction). */
export interface CreatedInteractionLike {
  id?: unknown;
  issueId?: unknown;
  companyId?: unknown;
  kind?: unknown;
  status?: unknown;
  continuationPolicy?: unknown;
  addresseeAgentId?: unknown;
  addresseeUserId?: unknown;
  requestedResolverPolicy?: unknown;
  effectiveResolverPolicy?: unknown;
  sourceRunId?: unknown;
  payload?: unknown;
}

export interface InteractionEventActor {
  agentId?: string | null;
  userId?: string | null;
  runId?: string | null;
}

type InteractionCreatedEvent = PluginEvent & { payload: Record<string, unknown> };

let context: PluginDecisionEventsContext | null = null;
const companyStates = new Map<string, CompanyState>();

/**
 * Wire the module once at boot (app.ts, next to setPluginEventBus).
 * `listBlockedIssues` / `loadIssueTimestamps` are injectable for tests.
 */
export function configurePluginDecisionEvents(input: PluginDecisionEventsInput): void {
  context = {
    db: input.db,
    bus: input.bus,
    isBackgroundWorkEnabled: input.isBackgroundWorkEnabled ?? (() => true),
    debounceMs: input.debounceMs ?? DEFAULT_DEBOUNCE_MS,
    commitCheckDelaysMs: input.commitCheckDelaysMs ?? DEFAULT_COMMIT_CHECK_DELAYS_MS,
    loadInteraction: input.loadInteraction ?? defaultLoadInteraction,
    captureXactId: input.captureXactId ?? defaultCaptureXactId,
    loadXactStatus: input.loadXactStatus ?? defaultLoadXactStatus,
    xactBackoffMs: input.xactBackoffMs ?? DEFAULT_XACT_BACKOFF_MS,
    xactMaxWaitMs: input.xactMaxWaitMs ?? DEFAULT_XACT_MAX_WAIT_MS,
    now: input.now ?? (() => Date.now()),
    listBlockedIssues: input.listBlockedIssues ?? defaultListBlockedIssues,
    loadIssueTimestamps: input.loadIssueTimestamps ?? defaultLoadIssueTimestamps,
    publish: input.publish ?? publishPluginDomainEvent,
  };
  setPluginDomainActivityObserver(noteBlockerAttentionCause);
}

/** Test helper: forget all state and wiring. */
export function resetPluginDecisionEventsForTests(): void {
  for (const state of companyStates.values()) {
    if (state.timer) clearTimeout(state.timer);
  }
  companyStates.clear();
  context = null;
  setPluginDomainActivityObserver(null);
}

function anySubscriber(eventType: string, companyId: string): boolean {
  const bus = context?.bus;
  if (!bus || typeof bus.hasSubscriber !== "function") return false;
  try {
    return bus.hasSubscriber(eventType, companyId);
  } catch {
    return false;
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * Publish the plugin event for one newly created interaction row. Call only
 * on the "row inserted" path, never for an idempotent replay. Never throws.
 * `dbHandle` is the handle (root db or transaction) that inserted the row; the
 * caller awaits this while that handle is still usable (one extra read of the
 * current transaction id, only when a plugin subscribes).
 */
export async function publishInteractionCreatedPluginEvent(
  interaction: CreatedInteractionLike | null | undefined,
  actor: InteractionEventActor | null = {},
  dbHandle: PluginDecisionDbHandle | null = null,
): Promise<void> {
  try {
    if (!context || !interaction || !readString(interaction.id) || !readString(interaction.issueId) || !readString(interaction.companyId)) return;
    if (!anySubscriber(INTERACTION_CREATED_EVENT, interaction.companyId as string)) return;
    const toolAction = interaction.payload && typeof interaction.payload === "object"
      ? (interaction.payload as { toolAction?: { actionRequestId?: unknown } | null }).toolAction
      : null;
    const agentId = readString(actor?.agentId);
    const userId = readString(actor?.userId);
    const event: InteractionCreatedEvent = {
      eventId: randomUUID(),
      eventType: INTERACTION_CREATED_EVENT,
      occurredAt: new Date().toISOString(),
      actorId: agentId ?? userId ?? "system",
      actorType: agentId ? "agent" : userId ? "user" : "system",
      entityId: interaction.issueId as string,
      entityType: "issue",
      companyId: interaction.companyId as string,
      payload: {
        interactionId: interaction.id,
        interactionKind: interaction.kind ?? null,
        interactionStatus: interaction.status ?? null,
        continuationPolicy: interaction.continuationPolicy ?? null,
        addresseeAgentId: interaction.addresseeAgentId ?? null,
        addresseeUserId: interaction.addresseeUserId ?? null,
        requestedResolverPolicy: interaction.requestedResolverPolicy ?? null,
        effectiveResolverPolicy: interaction.effectiveResolverPolicy ?? null,
        toolActionRequestId: readString(toolAction?.actionRequestId),
        source: "interaction_service",
        agentId,
        runId: readString(actor?.runId) ?? readString(interaction.sourceRunId),
      },
    };
    let xactId: string | null | undefined; // undefined: unknown (degraded path), null: no open transaction, string: follow it
    if (dbHandle) {
      try {
        xactId = await context.captureXactId(dbHandle);
      } catch (err) {
        logger.warn({ err, companyId: interaction.companyId }, "could not read the interaction's transaction id; bounded visibility check only");
        xactId = undefined;
      }
    }
    if (!context) return;
    if (typeof xactId === "string" && xactId !== "") scheduleTransactionPublish(event, interaction.companyId as string, interaction.id as string, xactId, 0, context.now());
    else scheduleCommittedPublish(event, interaction.companyId as string, interaction.id as string, 0);
  } catch (err) {
    logger.warn({ err }, "failed to publish interaction plugin event");
  }
}

function scheduleCommittedPublish(event: InteractionCreatedEvent, companyId: string, interactionId: string, attempt: number): void {
  const delays = context!.commitCheckDelaysMs;
  const timer = setTimeout(() => {
    void (async () => {
      try {
        if (!context) return;
        const row = await context.loadInteraction(context.db, companyId, interactionId);
        if (row) {
          publishIfVisible(row, event);
          return;
        }
        if (attempt + 1 < delays.length) scheduleCommittedPublish(event, companyId, interactionId, attempt + 1);
        else logger.debug({ companyId }, "interaction not committed; plugin event not published");
      } catch (err) {
        logger.warn({ err, companyId }, "failed to publish interaction plugin event");
      }
    })();
  }, delays[attempt] ?? 0);
  timer.unref?.();
}

function publishIfVisible(row: InteractionRowStatus, event: InteractionCreatedEvent): void {
  context!.publish({ ...event, payload: { ...event.payload, interactionStatus: row.status ?? event.payload.interactionStatus } });
}

function scheduleTransactionPublish(
  event: InteractionCreatedEvent,
  companyId: string,
  interactionId: string,
  xactId: string,
  attempt: number,
  startedAt: number,
): void {
  const steps = context!.xactBackoffMs;
  const delay = steps[Math.min(attempt, steps.length - 1)] ?? 1000;
  const timer = setTimeout(() => {
    void (async () => {
      if (!context) return;
      let status: string | null;
      try {
        status = await context.loadXactStatus(context.db, xactId);
      } catch (err) {
        logger.warn({ err, companyId }, "could not read the interaction's transaction status; will retry");
        status = "in progress";
      }
      try {
        if (!context) return;
        if (status === "in progress") {
          const nextDelay = steps[Math.min(attempt + 1, steps.length - 1)] ?? 1000;
          if (context.now() - startedAt + nextDelay > context.xactMaxWaitMs) {
            logger.warn({ companyId, waitedMs: context.now() - startedAt }, "interaction transaction still open at the maximum wait; plugin event not published");
            return;
          }
          scheduleTransactionPublish(event, companyId, interactionId, xactId, attempt + 1, startedAt);
          return;
        }
        if (status === "aborted") {
          logger.debug({ companyId }, "interaction transaction rolled back; plugin event not published");
          return;
        }
        // committed (or an unknown status): the committed row decides.
        const row = await context.loadInteraction(context.db, companyId, interactionId);
        if (row) {
          publishIfVisible(row, event);
          return;
        }
        if (status === "committed") logger.debug({ companyId }, "interaction committed but no longer present; plugin event not published");
        else scheduleCommittedPublish(event, companyId, interactionId, 0);
      } catch (err) {
        logger.warn({ err, companyId }, "failed to publish interaction plugin event");
      }
    })();
  }, delay);
  timer.unref?.();
}

function firstRow(result: unknown): Record<string, unknown> | null {
  if (Array.isArray(result)) return (result[0] as Record<string, unknown> | undefined) ?? null;
  if (result && Array.isArray((result as { rows?: unknown }).rows)) return (result as { rows: Record<string, unknown>[] }).rows[0] ?? null;
  return null;
}

/** The top-level transaction id of `handle`, or null when it has no open transaction (autocommit). */
async function defaultCaptureXactId(handle: PluginDecisionDbHandle): Promise<string | null> {
  const { sql } = await import("drizzle-orm");
  const row = firstRow(await handle.execute(sql`select pg_current_xact_id_if_assigned()::text as xid`));
  return typeof row?.xid === "string" && row.xid !== "" ? row.xid : null;
}

/** 'committed' | 'aborted' | 'in progress' | null, read from the root connection. */
async function defaultLoadXactStatus(db: Db, xactId: string): Promise<string | null> {
  const { sql } = await import("drizzle-orm");
  const row = firstRow(await db.execute(sql`select pg_xact_status(${xactId}::xid8) as status`));
  return typeof row?.status === "string" ? row.status : null;
}

async function defaultLoadInteraction(db: Db, companyId: string, interactionId: string): Promise<InteractionRowStatus | null> {
  const [{ and, eq }, { issueThreadInteractions }] = await Promise.all([import("drizzle-orm"), import("@paperclipai/db")]);
  const rows = await db
    .select({ id: issueThreadInteractions.id, status: issueThreadInteractions.status })
    .from(issueThreadInteractions)
    .where(and(eq(issueThreadInteractions.companyId, companyId), eq(issueThreadInteractions.id, interactionId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Observer called by activity-log for every published activity and
 * plugin domain event. Schedules one coalesced evaluation for the company.
 */
export function noteBlockerAttentionCause(companyId: string, eventType: string | null): void {
  if (!context || !readString(companyId)) return;
  if (eventType === BLOCKER_ATTENTION_CHANGED_EVENT) return;
  if (!anySubscriber(BLOCKER_ATTENTION_CHANGED_EVENT, companyId)) return;
  let state = companyStates.get(companyId);
  if (!state) {
    state = { timer: null, running: false, dirty: false, known: null };
    companyStates.set(companyId, state);
  }
  if (state.running) {
    state.dirty = true;
    return;
  }
  if (state.timer) return;
  state.timer = setTimeout(() => {
    state!.timer = null;
    void evaluateCompany(companyId, state!);
  }, context.debounceMs);
  state.timer.unref?.();
}

async function defaultListBlockedIssues(db: Db, companyId: string): Promise<BlockedIssueForAttention[]> {
  // Loaded lazily (like the drizzle/db helpers above): issues.ts depends, indirectly, on the
  // interaction service, which imports this module.
  const { issueService } = await import("./issues.js");
  return issueService(db).list(companyId, { status: "blocked", includeBlockedBy: true }) as Promise<BlockedIssueForAttention[]>;
}

async function defaultLoadIssueTimestamps(db: Db, companyId: string, issueIds: string[]): Promise<Map<string, IssueTimestamp>> {
  if (issueIds.length === 0) return new Map();
  const [{ and, eq, inArray }, { issues }] = await Promise.all([import("drizzle-orm"), import("@paperclipai/db")]);
  const rows = await db
    .select({ id: issues.id, updatedAt: issues.updatedAt })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIds)));
  return new Map(rows.map((row) => [row.id, row]));
}

function toIso(value: Date | string): string | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * The computed blocker-attention items of the board attention feed, using
 * the same rule as services/attention.ts (blocked issues; state stalled or
 * needs_attention; blocking tree not live; one item per terminal blocker,
 * keeping the most recently updated blocked issue; activityAt = terminal
 * blocker updatedAt; dedupKey = `blocker:<terminal blocker id>`).
 */
export async function computeBlockerAttentionItems(companyId: string): Promise<BlockerAttentionItem[]> {
  const blocked = await context!.listBlockedIssues(context!.db, companyId);
  const terminalIds = [...new Set(blocked
    .map((issue) => issue.blockerAttention?.terminalBlockerIssueId)
    .filter((issueId): issueId is string => Boolean(issueId)))];
  const terminals = await context!.loadIssueTimestamps(context!.db, companyId, terminalIds);
  const candidates = new Map<string, { issue: BlockedIssueForAttention; terminal: IssueTimestamp; state: string }>();
  for (const issue of blocked) {
    const attention = issue.blockerAttention;
    if (attention?.state !== "stalled" && attention?.state !== "needs_attention") continue;
    if (attention.blockingTreeLive) continue;
    const terminalIssueId = attention.terminalBlockerIssueId ?? issue.id;
    const terminal = terminals.get(terminalIssueId) ?? (terminalIssueId === issue.id ? issue : null);
    if (!terminal) continue;
    const current = candidates.get(terminalIssueId);
    if (!current || issue.updatedAt > current.issue.updatedAt) {
      candidates.set(terminalIssueId, { issue, terminal, state: attention.state });
    }
  }
  const items: BlockerAttentionItem[] = [];
  for (const [terminalIssueId, candidate] of candidates) {
    const activityAt = toIso(candidate.terminal.updatedAt);
    if (!activityAt) continue;
    items.push({
      terminalBlockerIssueId: terminalIssueId,
      blockedIssueId: candidate.issue.id,
      state: candidate.state,
      dedupKey: `blocker:${terminalIssueId}`,
      activityAt,
    });
  }
  return items;
}

async function evaluateCompany(companyId: string, state: CompanyState): Promise<void> {
  if (!context) return;
  if (!context.isBackgroundWorkEnabled()) {
    // Warm standby or idle drain: the next cause after it ends re-evaluates.
    return;
  }
  state.running = true;
  try {
    const items = await computeBlockerAttentionItems(companyId);
    const previous = state.known;
    // The first evaluation after boot has no baseline: it publishes the open
    // items with `baseline: true`, so subscribers can tell "still open" from
    // "entered" (a durable subscriber skips items it already announced).
    const baseline = previous === null;
    const next = new Map<string, BlockerAttentionItem>();
    const publish = (payload: Record<string, unknown>, entityId: string) => context!.publish({
      eventId: randomUUID(),
      eventType: BLOCKER_ATTENTION_CHANGED_EVENT,
      occurredAt: new Date().toISOString(),
      actorId: "blocker-attention-events",
      actorType: "system",
      entityId,
      entityType: "issue",
      companyId,
      payload,
    });
    for (const item of items) {
      next.set(item.dedupKey, item);
      // Only items that ENTERED the feed since the last evaluation. An item
      // that stays in the feed while its activityAt moves is a repeat.
      if (previous && previous.has(item.dedupKey)) continue;
      publish({
        state: item.state,
        blockingTreeLive: false,
        terminalBlockerIssueId: item.terminalBlockerIssueId,
        blockedIssueId: item.blockedIssueId,
        dedupKey: item.dedupKey,
        activityAt: item.activityAt,
        entered: true,
        baseline,
      }, item.terminalBlockerIssueId);
    }
    // Items that LEFT the feed (exit rule: the tree became live or no open
    // work remains blocked). Lets subscribers close the episode.
    if (previous) {
      for (const [dedupKey, item] of previous) {
        if (next.has(dedupKey)) continue;
        publish({
          state: null,
          blockingTreeLive: null,
          terminalBlockerIssueId: item.terminalBlockerIssueId,
          blockedIssueId: item.blockedIssueId,
          dedupKey,
          activityAt: item.activityAt,
          entered: false,
          baseline: false,
        }, item.terminalBlockerIssueId);
      }
    }
    state.known = next;
  } catch (err) {
    logger.warn({ err, companyId }, "blocker attention evaluation failed");
  } finally {
    state.running = false;
    if (state.dirty) {
      state.dirty = false;
      noteBlockerAttentionCause(companyId, null);
    }
  }
}
