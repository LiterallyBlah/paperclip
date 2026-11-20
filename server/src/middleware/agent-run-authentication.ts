import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";

export async function loadAgentRunAuthentication(db: Db, input: {
  runId: string;
  companyId: string;
  agentId: string;
}) {
  // A run id that is not a UUID can never match a heartbeat_runs row; skip the
  // query rather than let the uuid cast fail inside the database.
  if (!isUuidLike(input.runId)) return [];
  return await db.select({
    activeIdentityContextId: heartbeatRuns.activeIdentityContextId,
    responsibleUserId: heartbeatRuns.responsibleUserId,
    status: heartbeatRuns.status,
    finishedAt: heartbeatRuns.finishedAt,
    resultJson: sql<Record<string, unknown>>`jsonb_build_object(
      'executionCancellation', jsonb_build_object(
        'state', ${heartbeatRuns.resultJson}->'executionCancellation'->'state'
      )
    )`,
    contextSnapshot: sql<Record<string, unknown>>`jsonb_build_object(
      'conversationMode', ${heartbeatRuns.contextSnapshot}->'conversationMode'
    )`,
  }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, input.runId),
    eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.agentId, input.agentId),
  ));
}

/** Terminal heartbeat run statuses: the run will not execute again. */
export const AGENT_RUN_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
]);

/**
 * How long a run-bound agent JWT keeps its authority after the run finishes.
 * Runs are marked terminal only after the agent process has exited (or the
 * sandbox bridge has drained), and native tool calls re-check that the run is
 * running just before dispatch. The grace only absorbs a request that was
 * already in flight when the run finished.
 */
export const AGENT_RUN_AUTH_FINISHED_GRACE_MS = 10 * 1000;

export type AgentRunAuthenticationRevocation =
  | { code: "agent_run_not_found"; error: string }
  | { code: "agent_run_finished"; error: string };

/**
 * A run-bound JWT authenticates only while its run exists and has not been
 * finished for longer than the grace. A terminal run without `finishedAt` has
 * no evidence of when it ended, so it fails closed.
 */
export function agentRunAuthenticationRevoked(
  run: { status: string; finishedAt?: Date | string | null } | null | undefined,
  now: number = Date.now(),
): AgentRunAuthenticationRevocation | null {
  if (!run) {
    return { code: "agent_run_not_found", error: "Agent run credentials are not valid; obtain fresh credentials and retry" };
  }
  if (!AGENT_RUN_TERMINAL_STATUSES.has(run.status)) return null;
  const finishedAtMs = run.finishedAt == null ? Number.NaN : new Date(run.finishedAt).getTime();
  if (Number.isFinite(finishedAtMs) && now - finishedAtMs <= AGENT_RUN_AUTH_FINISHED_GRACE_MS) return null;
  return { code: "agent_run_finished", error: "This run has finished; its credentials no longer authenticate" };
}
