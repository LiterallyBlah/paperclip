import { randomUUID } from "node:crypto";
import { agentWakeupRequests, agents, companies, heartbeatRuns, issueRecoveryActions, issues, type createDb } from "@paperclipai/db";

type Db = ReturnType<typeof createDb>;
export type AdmissionPhase = "required" | "admitted";

/** The retained shape of source run f8e0a4d4 (BLA-3750): a legacy automation
 * run that failed with process_lost while its exact admission was `required`. */
export async function seedPreAdmissionLostRun(db: Db, options: {
  phase?: AdmissionPhase; withHold?: boolean; run?: Partial<typeof heartbeatRuns.$inferInsert>;
} = {}) {
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
  const runId = randomUUID(), wakeupRequestId = randomUUID(), actionId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Pre-admission", defaultResponsibleUserId: "board",
    issuePrefix: "P" + companyId.replaceAll("-", "") });
  await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer",
    adapterType: "hermes_local", status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
  await db.insert(issues).values({ id: issueId, companyId, title: "Continue saved work", status: "todo", assigneeAgentId: agentId });
  await db.insert(agentWakeupRequests).values({ id: wakeupRequestId, companyId, agentId, source: "automation",
    reason: "issue_assigned", status: "completed", payload: { issueId } });
  const admission = { version: 1, phase: options.phase ?? "required", companyId, runId, agentId, issueId, wakeupRequestId };
  const [run] = await db.insert(heartbeatRuns).values({
    id: runId, companyId, agentId, runtimeMode: "legacy", status: "failed", errorCode: "process_lost",
    invocationSource: "automation", wakeupRequestId, executionStage: "preparing",
    startedAt: new Date(Date.now() - 120_000), finishedAt: new Date(Date.now() - 60_000),
    contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
    runnerProfileJson: { chatControlRecoveryAdmission: admission },
    ...options.run,
  }).returning();
  if (options.withHold) await db.insert(issueRecoveryActions).values({
    id: actionId, companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
    cause: "legacy_execution_requires_reconciliation", fingerprint: "legacy-execution:" + runId,
    status: "resolved", outcome: "blocked", ownerType: "board", nextAction: "Inspect the stopped work.",
    evidence: { runId, originalFailureCode: "process_lost", adapterRecovery: "unsupported_or_unknown",
      automaticRecovery: { policy: "preserve_without_replay_v1", runId, replay: "blocked", actionOutcome: "unknown" } },
  });
  return { companyId, agentId, issueId, runId, wakeupRequestId, actionId, admission, run };
}
