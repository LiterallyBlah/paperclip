import { Router, type Request } from "express";
import { executionWorkspaces, issues, projects, projectWorkspaces, routineRevisions, type Db } from "@paperclipai/db";
import { and, eq, inArray } from "drizzle-orm";
import { executionWorkspaceReadSqlCondition, projectReadSqlCondition } from "../services/authorization.js";
import { assertExecutionWorkspaceRecordAccess } from "../services/task-workspace-access.js";
import {
  createRoutineSchema,
  createDocumentAnnotationCommentSchema,
  createDocumentAnnotationThreadSchema,
  createRoutineTriggerSchema,
  rotateRoutineTriggerSecretSchema,
  runRoutineSchema,
  updateDocumentAnnotationThreadSchema,
  updateRoutineSchema,
  updateRoutineTriggerSchema,
  restoreRoutineRevisionSchema,
} from "@paperclipai/shared";
import { trackRoutineCreated } from "@paperclipai/shared/telemetry";
import { validate, validateIssueMutationBody } from "../middleware/validate.js";
import { accessService, documentAnnotationService, logActivity, routineService } from "../services/index.js";
import { assertCompanyAccess, getAccessibleResource, getActorInfo, hasCompanyAccess } from "./authz.js";
import { badRequest, forbidden, HttpError, notFound, unauthorized, unsupportedMediaType } from "../errors.js";
import { getTelemetryClient } from "../telemetry.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

export function routineRoutes(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager } = {},
) {
  const router = Router();
  const svc = routineService(db, {
    pluginWorkerManager: options.pluginWorkerManager,
  });
  const documentAnnotationsSvc = documentAnnotationService(db);
  const access = accessService(db);
  const routineDocumentKey = "description";

  function parseBooleanQuery(value: unknown) {
    return value === true || value === "true" || value === "1";
  }

  function annotationActorInput(req: Request) {
    const actor = getActorInfo(req);
    return {
      actor,
      annotationActor: {
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
        runId: actor.runId,
      },
    };
  }

  async function remapRoutineDescriptionAnnotations(req: Request, routineId: string) {
    const doc = await svc.getDescriptionDocument(routineId);
    if (!doc) return;
    const remapped = await documentAnnotationsSvc.remapOpenThreadsForRoutineDocument({
      routineId,
      key: routineDocumentKey,
      documentId: doc.id,
      nextRevisionId: doc.latestRevisionId,
      nextRevisionNumber: doc.latestRevisionNumber,
      nextBody: doc.body,
    });
    const actor = getActorInfo(req);
    for (const remap of remapped) {
      await logActivity(db, {
        companyId: doc.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "routine.document_annotation_remapped",
        entityType: "routine",
        entityId: routineId,
        details: {
          key: doc.key,
          documentKey: doc.key,
          documentId: doc.id,
          threadId: remap.thread.id,
          revisionNumber: doc.latestRevisionNumber,
          anchorState: remap.thread.anchorState,
          anchorConfidence: remap.thread.anchorConfidence,
          snapshotId: remap.snapshot.id,
        },
      });
    }
  }

  async function assertBoardCanAssignTasks(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "board") return;
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    const allowed = await access.canUser(companyId, req.actor.userId, "tasks:assign");
    if (!allowed) {
      throw forbidden("Missing permission: tasks:assign");
    }
  }

  async function canChangeResponsibleUser(req: Request, companyId: string) {
    if (req.actor.type !== "board") return false;
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
    // Match assertCompanyAccess's write restrictions even on this GET route.
    if (Array.isArray(req.actor.memberships)) {
      const membership = req.actor.memberships.find((item) => item.companyId === companyId);
      if (!membership || membership.status !== "active" || membership.membershipRole === "viewer") return false;
    }
    return access.canUser(companyId, req.actor.userId, "tasks:assign");
  }

  function assertCanManageCompanyRoutine(req: Request, companyId: string, assigneeAgentId?: string | null) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") return;
    if (req.actor.type !== "agent" || !req.actor.agentId) throw unauthorized();
    if (assigneeAgentId !== req.actor.agentId) {
      throw forbidden("Agents can only manage routines assigned to themselves");
    }
  }

  /**
   * LR-1: a routine that belongs to a project is readable only by actors that
   * may read that project (the same predicate as private-project issues).
   * Routines without a project are unchanged. Returns the set of readable
   * project ids among `projectIds`.
   */
  async function readableRoutineProjectIds(req: Request, companyId: string, projectIds: string[]) {
    const ids = [...new Set(projectIds)];
    if (ids.length === 0) return new Set<string>();
    const rows = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.companyId, companyId), inArray(projects.id, ids), await projectReadSqlCondition(db, req.actor)));
    return new Set(rows.map((row) => row.id));
  }

  async function canReadRoutine(req: Request, routine: { companyId: string; projectId: string | null }) {
    if (!routine.projectId) return true;
    return (await readableRoutineProjectIds(req, routine.companyId, [routine.projectId])).has(routine.projectId);
  }

  /** LR-1: uniform 404 for a routine the actor may not read, before any other check. */
  async function routineHiddenFromReader(req: Request, routineId: string) {
    const routine = await svc.get(routineId);
    if (!routine || !hasCompanyAccess(req, routine.companyId)) return false;
    return !(await canReadRoutine(req, routine));
  }

  /**
   * Slice H F-H1: a routine write that sets or changes the routine's project
   * (create, PATCH, run override, revision restore) needs project read access
   * to the target project, the same `project:read` rule as issue creation.
   * A project the actor may not read gets the same 404 as a missing project.
   */
  async function assertTargetProjectReadable(req: Request, companyId: string, projectId: unknown) {
    if (typeof projectId !== "string" || projectId.length === 0) return;
    const project = await db
      .select({ id: projects.id, companyId: projects.companyId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .then((rows) => rows[0] ?? null);
    if (!project || project.companyId !== companyId) throw notFound("Project not found");
    const decision = await access.decide({
      actor: req.actor,
      action: "project:read",
      resource: { type: "project", companyId, projectId: project.id },
    });
    if (!decision.allowed) throw notFound("Project not found");
  }

  /**
   * Slice H F-H2: an issue a routine refers to is visible to the actor only
   * under the same `issue:read` decision as issue creation uses for a parent
   * (`routes/issues.ts`, `createBody.parentId` / `assertIssueReadAllowed`).
   * Missing, other-company and unreadable issues are indistinguishable.
   */
  async function readableIssueIds(req: Request, companyId: string, issueIds: Array<string | null | undefined>) {
    const ids = [...new Set(issueIds.filter((id): id is string => typeof id === "string" && id.length > 0))];
    const readable = new Set<string>();
    if (ids.length === 0) return readable;
    const rows = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        projectId: issues.projectId,
        parentId: issues.parentId,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        status: issues.status,
      })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), inArray(issues.id, ids)));
    for (const issue of rows) {
      const scope = {
        issueId: issue.id,
        projectId: issue.projectId,
        parentIssueId: issue.parentId,
        assigneeAgentId: issue.assigneeAgentId,
        assigneeUserId: issue.assigneeUserId,
      };
      const decision = await access.decide({
        actor: req.actor,
        action: "issue:read",
        resource: { type: "issue", companyId: issue.companyId, ...scope, status: issue.status },
        scope,
      });
      if (decision.allowed) readable.add(issue.id);
    }
    return readable;
  }

  /** Slice H F-H2: create, PATCH and restore may only set a parent issue the actor can read. */
  async function assertTargetParentIssueReadable(req: Request, companyId: string, parentIssueId: unknown) {
    if (typeof parentIssueId !== "string" || parentIssueId.length === 0) return;
    if (!(await readableIssueIds(req, companyId, [parentIssueId])).has(parentIssueId)) {
      throw notFound("Parent issue not found");
    }
  }

  /**
   * Slice H F-H2: run overrides may only select workspaces the actor can read,
   * under the same rules issue creation applies to a selecting actor
   * (`services/issues.ts`, the `workspaceSelectionActor` checks): the project
   * workspace's project must be readable, and the execution workspace must pass
   * the execution-workspace read condition and record access. Missing and
   * unreadable workspaces get the same 404.
   */
  async function assertRunWorkspacesReadable(req: Request, companyId: string, body: {
    projectWorkspaceId?: unknown;
    executionWorkspaceId?: unknown;
  }) {
    if (typeof body.projectWorkspaceId === "string" && body.projectWorkspaceId.length > 0) {
      const [workspace] = await db
        .select({ id: projectWorkspaces.id, projectId: projectWorkspaces.projectId })
        .from(projectWorkspaces)
        .where(and(eq(projectWorkspaces.id, body.projectWorkspaceId), eq(projectWorkspaces.companyId, companyId)));
      const decision = workspace
        ? await access.decide({
          actor: req.actor,
          action: "project:read",
          resource: { type: "project", companyId, projectId: workspace.projectId },
        })
        : null;
      if (!decision?.allowed) throw notFound("Project workspace not found");
    }
    if (typeof body.executionWorkspaceId === "string" && body.executionWorkspaceId.length > 0) {
      const [workspace] = await db
        .select({ id: executionWorkspaces.id })
        .from(executionWorkspaces)
        .where(and(
          eq(executionWorkspaces.id, body.executionWorkspaceId),
          eq(executionWorkspaces.companyId, companyId),
          await executionWorkspaceReadSqlCondition(db, req.actor),
        ));
      if (!workspace) throw notFound("Execution workspace not found");
      try {
        await assertExecutionWorkspaceRecordAccess(db, req.actor, companyId, workspace.id);
      } catch (error) {
        if (error instanceof HttpError && error.status === 403) throw notFound("Execution workspace not found");
        throw error;
      }
    }
  }

  /**
   * Slice H F-H2 (defence in depth): routine reads do not return issues the
   * reader cannot read: the parent issue, the live execution issue, and the
   * issues linked from run history.
   */
  async function withoutUnreadableIssues<T extends {
    companyId: string;
    parentIssue?: { id: string } | null;
    activeIssue?: { id: string } | null;
    recentRuns?: Array<{ linkedIssueId: string | null; linkedIssue: unknown }>;
  }>(req: Request, detail: T): Promise<T> {
    const readable = await readableIssueIds(req, detail.companyId, [
      detail.parentIssue?.id,
      detail.activeIssue?.id,
      ...(detail.recentRuns ?? []).map((run) => run.linkedIssueId),
    ]);
    return {
      ...detail,
      ...(detail.parentIssue !== undefined
        ? { parentIssue: detail.parentIssue && readable.has(detail.parentIssue.id) ? detail.parentIssue : null }
        : {}),
      ...(detail.activeIssue !== undefined
        ? { activeIssue: detail.activeIssue && readable.has(detail.activeIssue.id) ? detail.activeIssue : null }
        : {}),
      ...(detail.recentRuns !== undefined ? { recentRuns: withoutUnreadableLinkedIssues(detail.recentRuns, readable) } : {}),
    };
  }

  function withoutUnreadableLinkedIssues<R extends { linkedIssueId: string | null; linkedIssue: unknown }>(
    runs: R[],
    readable: Set<string>,
  ): R[] {
    return runs.map((run) =>
      run.linkedIssueId && !readable.has(run.linkedIssueId) ? { ...run, linkedIssueId: null, linkedIssue: null } : run,
    );
  }

  async function assertCanManageExistingRoutine(req: Request, routineId: string) {
    const routine = await svc.get(routineId);
    if (!routine || !hasCompanyAccess(req, routine.companyId)) return null;
    // Slice H: writes follow the LR-1 project read rule, before the manage
    // check, so a non-member gets the same "not found" as for a random id.
    if (!(await canReadRoutine(req, routine))) return null;
    // Slice H F-H2: a routine's runs inherit its parent issue's project, so a
    // routine whose parent the actor cannot read is not manageable either.
    if (routine.parentIssueId && !(await readableIssueIds(req, routine.companyId, [routine.parentIssueId])).has(routine.parentIssueId)) {
      return null;
    }
    assertCompanyAccess(req, routine.companyId);
    if (req.actor.type === "board") return routine;
    if (req.actor.type !== "agent" || !req.actor.agentId) throw unauthorized();
    if (routine.assigneeAgentId !== req.actor.agentId) {
      throw forbidden("Agents can only manage routines assigned to themselves");
    }
    return routine;
  }

  async function logRoutineRevisionCreated(req: Request, input: {
    companyId: string;
    routineId: string;
    revisionId: string | null;
    revisionNumber: number;
    changeSummary?: string | null;
    triggerCount?: number | null;
  }) {
    if (!input.revisionId) return;
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: input.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "routine.revision_created",
      entityType: "routine",
      entityId: input.routineId,
      details: {
        revisionId: input.revisionId,
        revisionNumber: input.revisionNumber,
        changeSummary: input.changeSummary ?? null,
        triggerCount: input.triggerCount ?? null,
      },
    });
  }

  router.get("/companies/:companyId/routines", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    const result = await svc.list(companyId, { projectId });
    const readable = await readableRoutineProjectIds(
      req,
      companyId,
      result.flatMap((routine) => (routine.projectId ? [routine.projectId] : [])),
    );
    res.json(result.filter((routine) => !routine.projectId || readable.has(routine.projectId)));
  });

  router.post("/companies/:companyId/routines", validate(createRoutineSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await assertTargetProjectReadable(req, companyId, req.body.projectId);
    await assertTargetParentIssueReadable(req, companyId, req.body.parentIssueId);
    await assertBoardCanAssignTasks(req, companyId);
    assertCanManageCompanyRoutine(req, companyId, req.body.assigneeAgentId);
    const created = await svc.create(companyId, req.body, {
      agentId: req.actor.type === "agent" ? req.actor.agentId : null,
      userId: req.actor.type === "board" ? req.actor.userId ?? "board" : null,
      ...(req.actor.type === "agent" ? { actorResponsibleUserId: req.actor.onBehalfOfUserId ?? null } : {}),
      runId: req.actor.runId ?? null,
    });
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "routine.created",
      entityType: "routine",
      entityId: created.id,
      details: { title: created.title, assigneeAgentId: created.assigneeAgentId },
    });
    const telemetryClient = getTelemetryClient();
    if (telemetryClient) {
      trackRoutineCreated(telemetryClient);
    }
    await logRoutineRevisionCreated(req, {
      companyId,
      routineId: created.id,
      revisionId: created.latestRevisionId,
      revisionNumber: created.latestRevisionNumber,
      changeSummary: "Created routine",
      triggerCount: 0,
    });
    res.status(201).json(created);
  });

  router.get("/routines/:id", async (req, res) => {
    const detail = await getAccessibleResource(req, res, svc.getDetail(req.params.id as string), "Routine not found");
    if (!detail) return;
    if (!(await canReadRoutine(req, detail))) {
      res.status(404).json({ error: "Routine not found" });
      return;
    }
    res.json({ ...(await withoutUnreadableIssues(req, detail)), canChangeResponsibleUser: await canChangeResponsibleUser(req, detail.companyId) });
  });

  router.get("/routines/:id/revisions", async (req, res) => {
    if (await routineHiddenFromReader(req, req.params.id as string)) {
      res.status(404).json({ error: "Routine not found" });
      return;
    }
    const routine = await assertCanManageExistingRoutine(req, req.params.id as string);
    if (!routine) {
      res.status(404).json({ error: "Routine not found" });
      return;
    }
    const revisions = await svc.listRevisions(routine.id);
    res.json(revisions);
  });

  router.get("/routines/:id/description/annotations", async (req, res) => {
    if (await routineHiddenFromReader(req, req.params.id as string)) {
      res.status(404).json({ error: "Routine not found" });
      return;
    }
    const routine = await assertCanManageExistingRoutine(req, req.params.id as string);
    if (!routine) {
      res.status(404).json({ error: "Routine not found" });
      return;
    }
    const status = req.query.status === "resolved" || req.query.status === "all" ? req.query.status : "open";
    const threads = await documentAnnotationsSvc.listThreadsForRoutineDocument(routine.id, routineDocumentKey, {
      status,
      includeComments: parseBooleanQuery(req.query.includeComments),
    });
    res.json(threads);
  });

  router.get("/routines/:id/description/annotations/:threadId", async (req, res) => {
    if (await routineHiddenFromReader(req, req.params.id as string)) {
      res.status(404).json({ error: "Routine not found" });
      return;
    }
    const routine = await assertCanManageExistingRoutine(req, req.params.id as string);
    if (!routine) {
      res.status(404).json({ error: "Routine not found" });
      return;
    }
    const thread = await documentAnnotationsSvc.getThreadForRoutineDocument(
      routine.id,
      routineDocumentKey,
      req.params.threadId as string,
    );
    if (!thread) {
      res.status(404).json({ error: "Annotation thread not found" });
      return;
    }
    res.json(thread);
  });

  router.post(
    "/routines/:id/description/annotations",
    validate(createDocumentAnnotationThreadSchema),
    async (req, res) => {
      const routine = await assertCanManageExistingRoutine(req, req.params.id as string);
      if (!routine) {
        res.status(404).json({ error: "Routine not found" });
        return;
      }
      const { actor, annotationActor } = annotationActorInput(req);
      const thread = await documentAnnotationsSvc.createRoutineThread(
        routine.id,
        routineDocumentKey,
        req.body,
        annotationActor,
      );
      const firstComment = thread.comments[0];
      await logActivity(db, {
        companyId: routine.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "routine.document_annotation_thread_created",
        entityType: "routine",
        entityId: routine.id,
        details: {
          key: thread.documentKey,
          documentKey: thread.documentKey,
          documentId: thread.documentId,
          threadId: thread.id,
          commentId: firstComment?.id ?? null,
          revisionNumber: thread.currentRevisionNumber,
          quote: thread.selectedText.slice(0, 240),
        },
      });
      res.status(201).json(thread);
    },
  );

  router.post(
    "/routines/:id/description/annotations/:threadId/comments",
    validate(createDocumentAnnotationCommentSchema),
    async (req, res) => {
      const routine = await assertCanManageExistingRoutine(req, req.params.id as string);
      if (!routine) {
        res.status(404).json({ error: "Routine not found" });
        return;
      }
      const { actor, annotationActor } = annotationActorInput(req);
      const comment = await documentAnnotationsSvc.addRoutineComment(
        routine.id,
        routineDocumentKey,
        req.params.threadId as string,
        req.body,
        annotationActor,
      );
      await logActivity(db, {
        companyId: routine.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "routine.document_annotation_comment_added",
        entityType: "routine",
        entityId: routine.id,
        details: {
          key: routineDocumentKey,
          documentKey: routineDocumentKey,
          threadId: comment.threadId,
          commentId: comment.id,
          bodySnippet: comment.body.slice(0, 120),
        },
      });
      res.status(201).json(comment);
    },
  );

  router.patch(
    "/routines/:id/description/annotations/:threadId",
    validate(updateDocumentAnnotationThreadSchema),
    async (req, res) => {
      const routine = await assertCanManageExistingRoutine(req, req.params.id as string);
      if (!routine) {
        res.status(404).json({ error: "Routine not found" });
        return;
      }
      const { actor, annotationActor } = annotationActorInput(req);
      const thread = await documentAnnotationsSvc.updateRoutineThread(
        routine.id,
        routineDocumentKey,
        req.params.threadId as string,
        req.body,
        annotationActor,
      );
      await logActivity(db, {
        companyId: routine.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: thread.status === "resolved"
          ? "routine.document_annotation_thread_resolved"
          : "routine.document_annotation_thread_reopened",
        entityType: "routine",
        entityId: routine.id,
        details: {
          key: thread.documentKey,
          documentKey: thread.documentKey,
          documentId: thread.documentId,
          threadId: thread.id,
          status: thread.status,
        },
      });
      res.json(thread);
    },
  );

  router.patch("/routines/:id", validate(updateRoutineSchema), async (req, res) => {
    const routine = await assertCanManageExistingRoutine(req, req.params.id as string);
    if (!routine) {
      res.status(404).json({ error: "Routine not found" });
      return;
    }
    if (req.body.projectId !== undefined && req.body.projectId !== routine.projectId) {
      await assertTargetProjectReadable(req, routine.companyId, req.body.projectId);
    }
    if (req.body.parentIssueId !== undefined && req.body.parentIssueId !== routine.parentIssueId) {
      await assertTargetParentIssueReadable(req, routine.companyId, req.body.parentIssueId);
    }
    const assigneeWillChange =
      req.body.assigneeAgentId !== undefined &&
      req.body.assigneeAgentId !== routine.assigneeAgentId;
    if (req.body.responsibleUserId !== undefined) {
      if (req.actor.type !== "board") {
        throw forbidden("Only people can change routine responsibility");
      }
      await assertBoardCanAssignTasks(req, routine.companyId);
    }
    if (assigneeWillChange) {
      await assertBoardCanAssignTasks(req, routine.companyId);
    }
    const statusWillActivate =
      req.body.status !== undefined &&
      req.body.status === "active" &&
      routine.status !== "active";
    if (statusWillActivate) {
      await assertBoardCanAssignTasks(req, routine.companyId);
    }
    if (
      req.actor.type === "agent" &&
      req.body.assigneeAgentId !== undefined &&
      req.body.assigneeAgentId !== req.actor.agentId
    ) {
      throw forbidden("Agents can only assign routines to themselves");
    }
    const updated = await svc.update(routine.id, req.body, {
      agentId: req.actor.type === "agent" ? req.actor.agentId : null,
      userId: req.actor.type === "board" ? req.actor.userId ?? "board" : null,
      runId: req.actor.runId ?? null,
    });
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: routine.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "routine.updated",
      entityType: "routine",
      entityId: routine.id,
      details: {
        title: updated?.title ?? routine.title,
        ...(req.body.responsibleUserId !== undefined ? {
          previousResponsibleUserId: updated?.previousResponsibleUserId,
          responsibleUserId: updated?.responsibleUserId,
        } : {}),
      },
    });
    if (updated && updated.latestRevisionId !== routine.latestRevisionId) {
      await remapRoutineDescriptionAnnotations(req, routine.id);
      await logRoutineRevisionCreated(req, {
        companyId: routine.companyId,
        routineId: routine.id,
        revisionId: updated.latestRevisionId,
        revisionNumber: updated.latestRevisionNumber,
        changeSummary: "Updated routine",
        triggerCount: null,
      });
    }
    if (updated) {
      const { previousResponsibleUserId: _previousResponsibleUserId, ...response } = updated;
      res.json(response);
    } else {
      res.json(null);
    }
  });

  router.post("/routines/:id/revisions/:revisionId/restore", async (req, res) => {
    const routine = await assertCanManageExistingRoutine(req, req.params.id as string);
    if (!routine) {
      res.status(404).json({ error: "Routine not found" });
      return;
    }
    const [targetRevision] = await db
      .select({ snapshot: routineRevisions.snapshot })
      .from(routineRevisions)
      .where(and(
        eq(routineRevisions.companyId, routine.companyId),
        eq(routineRevisions.routineId, routine.id),
        eq(routineRevisions.id, req.params.revisionId as string),
      ));
    const restoredRoutine = (targetRevision?.snapshot as {
      routine?: { projectId?: unknown; parentIssueId?: unknown };
    } | undefined)?.routine;
    const restoredProjectId = restoredRoutine?.projectId;
    if (restoredProjectId && restoredProjectId !== routine.projectId) {
      await assertTargetProjectReadable(req, routine.companyId, restoredProjectId);
    }
    const restoredParentIssueId = restoredRoutine?.parentIssueId;
    if (restoredParentIssueId && restoredParentIssueId !== routine.parentIssueId) {
      await assertTargetParentIssueReadable(req, routine.companyId, restoredParentIssueId);
    }
    await assertBoardCanAssignTasks(req, routine.companyId);
    // The restore body was never validated; keep that, and read only the optional guard.
    const { baseRevisionId } = restoreRoutineRevisionSchema.parse(
      req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {},
    );
    const restoreActor = {
      agentId: req.actor.type === "agent" ? req.actor.agentId : null,
      userId: req.actor.type === "board" ? req.actor.userId ?? "board" : null,
      runId: req.actor.runId ?? null,
    };
    const result = baseRevisionId
      ? await svc.restoreRevision(routine.id, req.params.revisionId as string, restoreActor, { baseRevisionId })
      : await svc.restoreRevision(routine.id, req.params.revisionId as string, restoreActor);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: routine.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "routine.revision_restored",
      entityType: "routine",
      entityId: routine.id,
      details: {
        revisionId: result.revision.id,
        revisionNumber: result.revision.revisionNumber,
        restoredFromRevisionId: result.restoredFromRevisionId,
        restoredFromRevisionNumber: result.restoredFromRevisionNumber,
        triggerCount: result.revision.snapshot.triggers.length,
      },
    });
    await remapRoutineDescriptionAnnotations(req, routine.id);
    res.json(result);
  });

  router.get("/routines/:id/runs", async (req, res) => {
    const routine = await getAccessibleResource(req, res, svc.get(req.params.id as string), "Routine not found");
    if (!routine) return;
    if (!(await canReadRoutine(req, routine))) {
      res.status(404).json({ error: "Routine not found" });
      return;
    }
    const limit = Number(req.query.limit ?? 50);
    const result = await svc.listRuns(routine.id, Number.isFinite(limit) ? limit : 50);
    const readable = await readableIssueIds(req, routine.companyId, result.map((run) => run.linkedIssueId));
    res.json(withoutUnreadableLinkedIssues(result, readable));
  });

  router.post("/routines/:id/triggers", validate(createRoutineTriggerSchema), async (req, res) => {
    const routine = await assertCanManageExistingRoutine(req, req.params.id as string);
    if (!routine) {
      res.status(404).json({ error: "Routine not found" });
      return;
    }
    await assertBoardCanAssignTasks(req, routine.companyId);
    const created = await svc.createTrigger(routine.id, req.body, {
      agentId: req.actor.type === "agent" ? req.actor.agentId : null,
      userId: req.actor.type === "board" ? req.actor.userId ?? "board" : null,
      runId: req.actor.runId ?? null,
    });
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: routine.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "routine.trigger_created",
      entityType: "routine_trigger",
      entityId: created.trigger.id,
      details: { routineId: routine.id, kind: created.trigger.kind },
    });
    await logRoutineRevisionCreated(req, {
      companyId: routine.companyId,
      routineId: routine.id,
      revisionId: created.revision.id,
      revisionNumber: created.revision.revisionNumber,
      changeSummary: created.revision.changeSummary,
      triggerCount: created.revision.snapshot.triggers.length,
    });
    res.status(201).json(created);
  });

  router.patch("/routine-triggers/:id", validate(updateRoutineTriggerSchema), async (req, res) => {
    const trigger = await svc.getTrigger(req.params.id as string);
    if (!trigger) {
      res.status(404).json({ error: "Routine trigger not found" });
      return;
    }
    const routine = await assertCanManageExistingRoutine(req, trigger.routineId);
    if (!routine) {
      res.status(404).json({ error: "Routine trigger not found" });
      return;
    }
    await assertBoardCanAssignTasks(req, routine.companyId);
    const updated = await svc.updateTrigger(trigger.id, req.body, {
      agentId: req.actor.type === "agent" ? req.actor.agentId : null,
      userId: req.actor.type === "board" ? req.actor.userId ?? "board" : null,
      runId: req.actor.runId ?? null,
    });
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: routine.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: req.body.archived === true ? "routine.trigger_removed" : req.body.archived === false ? "routine.trigger_restored" : req.body.setupPending === false ? "routine.trigger_setup_finished" : "routine.trigger_updated",
      entityType: "routine",
      entityId: routine.id,
      details: { triggerId: trigger.id, kind: updated?.trigger.kind ?? trigger.kind },
    });
    if (updated) {
      await logRoutineRevisionCreated(req, {
        companyId: routine.companyId,
        routineId: routine.id,
        revisionId: updated.revision.id,
        revisionNumber: updated.revision.revisionNumber,
        changeSummary: updated.revision.changeSummary,
        triggerCount: updated.revision.snapshot.triggers.length,
      });
    }
    res.json(updated?.trigger ?? null);
  });

  router.delete("/routine-triggers/:id", async (req, res) => {
    const trigger = await svc.getTrigger(req.params.id as string);
    if (!trigger) {
      res.status(404).json({ error: "Routine trigger not found" });
      return;
    }
    const routine = await assertCanManageExistingRoutine(req, trigger.routineId);
    if (!routine) {
      res.status(404).json({ error: "Routine trigger not found" });
      return;
    }
    const deleted = await svc.deleteTrigger(trigger.id, {
      agentId: req.actor.type === "agent" ? req.actor.agentId : null,
      userId: req.actor.type === "board" ? req.actor.userId ?? "board" : null,
      runId: req.actor.runId ?? null,
    });
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: routine.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "routine.trigger_deleted",
      entityType: "routine_trigger",
      entityId: trigger.id,
      details: { routineId: routine.id, kind: trigger.kind },
    });
    if (deleted.revision) {
      await logRoutineRevisionCreated(req, {
        companyId: routine.companyId,
        routineId: routine.id,
        revisionId: deleted.revision.id,
        revisionNumber: deleted.revision.revisionNumber,
        changeSummary: deleted.revision.changeSummary,
        triggerCount: deleted.revision.snapshot.triggers.length,
      });
    }
    res.status(204).end();
  });

  router.post(
    "/routine-triggers/:id/rotate-secret",
    validate(rotateRoutineTriggerSecretSchema),
    async (req, res) => {
      const trigger = await svc.getTrigger(req.params.id as string);
      if (!trigger) {
        res.status(404).json({ error: "Routine trigger not found" });
        return;
      }
      const routine = await assertCanManageExistingRoutine(req, trigger.routineId);
      if (!routine) {
        res.status(404).json({ error: "Routine trigger not found" });
        return;
      }
      const rotated = await svc.rotateTriggerSecret(trigger.id, {
        agentId: req.actor.type === "agent" ? req.actor.agentId : null,
        userId: req.actor.type === "board" ? req.actor.userId ?? "board" : null,
        runId: req.actor.runId ?? null,
      });
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: routine.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "routine.trigger_secret_rotated",
        entityType: "routine_trigger",
        entityId: trigger.id,
        details: { routineId: routine.id },
      });
      await logRoutineRevisionCreated(req, {
        companyId: routine.companyId,
        routineId: routine.id,
        revisionId: rotated.revision.id,
        revisionNumber: rotated.revision.revisionNumber,
        changeSummary: rotated.revision.changeSummary,
        triggerCount: rotated.revision.snapshot.triggers.length,
      });
      res.json(rotated);
    },
  );

  router.post("/routines/:id/run", validateIssueMutationBody(runRoutineSchema), async (req, res) => {
    const routine = await assertCanManageExistingRoutine(req, req.params.id as string);
    if (!routine) {
      res.status(404).json({ error: "Routine not found" });
      return;
    }
    if (req.body.projectId && req.body.projectId !== routine.projectId) {
      await assertTargetProjectReadable(req, routine.companyId, req.body.projectId);
    }
    await assertRunWorkspacesReadable(req, routine.companyId, req.body);
    await assertBoardCanAssignTasks(req, routine.companyId);
    const run = await svc.runRoutine(routine.id, req.body, {
      agentId: req.actor.type === "agent" ? req.actor.agentId : null,
      userId: req.actor.type === "board" ? req.actor.userId ?? null : null,
      runId: req.actor.runId ?? null,
    });
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: routine.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "routine.run_triggered",
      entityType: "routine_run",
      entityId: run.id,
      details: { routineId: routine.id, source: run.source, status: run.status },
    });
    res.status(202).json(run);
  });

  router.post("/routine-triggers/public/:publicId/fire", async (req, res) => {
    if (!req.is("application/json")) {
      throw unsupportedMediaType("Send the webhook payload with Content-Type: application/json");
    }
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      throw badRequest("Webhook payload must be a JSON object");
    }
    const idempotencyScope = req.header("x-paperclip-idempotency-scope");
    if (idempotencyScope != null && idempotencyScope !== "trigger" && idempotencyScope !== "routine") {
      throw badRequest("X-Paperclip-Idempotency-Scope must be trigger or routine");
    }
    const result = await svc.firePublicTrigger(req.params.publicId as string, {
      sourceRunToken: req.header("x-paperclip-source-run-token"),
      idempotencyScope: idempotencyScope as "trigger" | "routine" | undefined,
      authorizationHeader: req.header("authorization"),
      signatureHeader: req.header("x-paperclip-signature"),
      hubSignatureHeader: req.header("x-hub-signature-256"),
      firefliesSignatureHeader: req.header("x-hub-signature"),
      timestampHeader: req.header("x-paperclip-timestamp"),
      idempotencyKey: req.header("idempotency-key") ?? req.header("x-github-delivery"),
      rawBody: (req as { rawBody?: Buffer }).rawBody ?? null,
      payload: typeof req.body === "object" && req.body !== null ? req.body as Record<string, unknown> : null,
    });
    res.status(202).json(result);
  });

  return router;
}
