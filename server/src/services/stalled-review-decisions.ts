import { and, eq } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import type { StalledReviewDecisionAction } from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import {
  logActivity,
  publishActivity,
  type ActivityPublication,
} from "./activity-log.js";
import { executionIssueCondition } from "./issue-visibility.js";
import {
  executeIssuePostCommitActions,
  issueService,
  type IssuePostCommitAction,
} from "./issues.js";

export type StalledReviewDecisionActor =
  | { type?: "user"; userId: string; runId?: string | null }
  /**
   * The company's decision-triage delegate (BLA-1616 G7). The route admits it
   * only for options that do not accept the work; `activityDetails` carries
   * the `via: "decision_triage_delegate"` marker into the decision entry.
   */
  | { type: "agent"; agentId: string; runId?: string | null; activityDetails?: Record<string, unknown> };

export interface DecideStalledReviewInput {
  issueId: string;
  companyId: string;
  action: StalledReviewDecisionAction;
  note?: string;
  actor: StalledReviewDecisionActor;
}

export function stalledReviewDecisionService(db: Db) {
  const svc = issueService(db);
  return {
    decide: async (input: DecideStalledReviewInput) => {
      const actor = input.actor;
      const isAgent = actor.type === "agent";
      const actorRef = isAgent
        ? { actorType: "agent" as const, actorId: actor.agentId, agentId: actor.agentId }
        : { actorType: "user" as const, actorId: actor.userId };
      if (isAgent && input.action === "approve") {
        throw conflict("Accepting a stalled review stays with the board");
      }
      const postCommitActivityPublications: ActivityPublication[] = [];
      const postCommitIssueActions: IssuePostCommitAction[] = [];
      const result = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const lockedIssue = await tx
          .select()
          .from(issues)
          .where(and(
            eq(issues.id, input.issueId),
            eq(issues.companyId, input.companyId),
            executionIssueCondition(),
          ))
          .for("update")
          .then((rows) => rows[0] ?? null);

        if (!lockedIssue) throw notFound("Issue not found");
        if (lockedIssue.status !== "in_review") {
          throw conflict("Issue is no longer a stalled review", {
            issueId: lockedIssue.id,
            currentStatus: lockedIssue.status,
          });
        }

        const reviewAttention = await svc
          .listReviewAttention(lockedIssue.companyId, [lockedIssue], tx)
          .then((rows) => rows.get(lockedIssue.id));
        if (reviewAttention?.state !== "stalled") {
          throw conflict("Issue is no longer a stalled review", {
            issueId: lockedIssue.id,
            reviewAttentionState: reviewAttention?.state ?? "none",
          });
        }

        const comment = input.note
          ? await svc.addComment(
              lockedIssue.id,
              input.note,
              isAgent
                ? { agentId: actor.agentId, runId: actor.runId ?? null }
                : { userId: actor.userId, runId: actor.runId ?? null },
              { authorType: isAgent ? "agent" : "user" },
              tx,
            )
          : null;
        const status = input.action === "approve" ? "done" : "todo";
        const updated = await svc.update(
          lockedIssue.id,
          {
            status,
            ...(isAgent ? { actorAgentId: actor.agentId } : { actorUserId: actor.userId }),
          },
          tx,
          postCommitActivityPublications,
          postCommitIssueActions,
        );
        if (!updated) throw notFound("Issue not found");

        if (comment) {
          await logActivity(txDb, {
            companyId: updated.companyId,
            ...actorRef,
            runId: actor.runId ?? null,
            action: "issue.comment_added",
            entityType: "issue",
            entityId: updated.id,
            issueId: updated.id,
            details: {
              commentId: comment.id,
              ...(isAgent ? { authorAgentId: actor.agentId } : { authorUserId: actor.userId }),
              source: "stalled_review_decision",
            },
          });
        }
        await logActivity(txDb, {
          companyId: updated.companyId,
          ...actorRef,
          runId: actor.runId ?? null,
          action: "issue.stalled_review_decided",
          entityType: "issue",
          entityId: updated.id,
          issueId: updated.id,
          details: {
            action: input.action,
            status,
            identifier: updated.identifier,
            commentId: comment?.id ?? null,
            authorUserId: comment && !isAgent ? actor.userId : null,
            ...(isAgent ? { authorAgentId: comment ? actor.agentId : null, ...(actor.activityDetails ?? {}) } : {}),
            _previous: { status: lockedIssue.status },
          },
        });

        return { issue: updated, comment };
      });
      for (const publication of postCommitActivityPublications) publishActivity(publication);
      await executeIssuePostCommitActions(db, postCommitIssueActions);
      return result;
    },
  };
}
