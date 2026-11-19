import { issues, projects, routines, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { accessService } from "./access.js";
import type { AuthorizationActor } from "./authorization.js";

/**
 * Slice H F-H2: whether a routine that exists in `companyId` is hidden from
 * `actor` for writes made outside the routine routes (folder item moves).
 * Same rules as the routine write routes (`routes/routines.ts`
 * `assertCanManageExistingRoutine`): the routine's project needs
 * `project:read`, and its parent issue needs `issue:read`. A missing routine
 * returns false so the caller keeps its own "not found" handling.
 */
export async function routineHiddenForWrite(db: Db, actor: AuthorizationActor, companyId: string, routineId: string) {
  const [routine] = await db
    .select({ projectId: routines.projectId, parentIssueId: routines.parentIssueId })
    .from(routines)
    .where(and(eq(routines.companyId, companyId), eq(routines.id, routineId)));
  if (!routine) return false;
  const access = accessService(db);
  if (routine.projectId) {
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.companyId, companyId), eq(projects.id, routine.projectId)));
    const decision = project
      ? await access.decide({ actor, action: "project:read", resource: { type: "project", companyId, projectId: project.id } })
      : null;
    if (!decision?.allowed) return true;
  }
  if (routine.parentIssueId) {
    const [issue] = await db
      .select({
        id: issues.id,
        projectId: issues.projectId,
        parentId: issues.parentId,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        status: issues.status,
      })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.id, routine.parentIssueId)));
    if (!issue) return true;
    const scope = {
      issueId: issue.id,
      projectId: issue.projectId,
      parentIssueId: issue.parentId,
      assigneeAgentId: issue.assigneeAgentId,
      assigneeUserId: issue.assigneeUserId,
    };
    const decision = await access.decide({
      actor,
      action: "issue:read",
      resource: { type: "issue", companyId, ...scope, status: issue.status },
      scope,
    });
    if (!decision.allowed) return true;
  }
  return false;
}
