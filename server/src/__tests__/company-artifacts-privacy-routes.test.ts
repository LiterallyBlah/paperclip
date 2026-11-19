// Regression coverage: company artifact listing and the artifact branch of
// company search must apply the caller-scoped issue-read (privacy) filter.
// All data in this file is synthetic.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  assets,
  companies,
  companyMemberships,
  createDb,
  documents,
  issueAttachments,
  issueDocuments,
  issues,
  issueWorkProducts,
  projectAccessMembers,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { companyRoutes } from "../routes/companies.js";
import { issueRoutes } from "../routes/issues.js";
import { createCompanySearchRateLimiter } from "../services/company-search-rate-limit.js";
import type { StorageService } from "../storage/types.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company artifact privacy tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const NEEDLE = "synthneedle";

function createStorageService(): StorageService {
  return {
    provider: "local_disk",
    putFile: vi.fn(),
    getObject: vi.fn(),
    headObject: vi.fn(),
    deleteObject: vi.fn(),
  } as unknown as StorageService;
}

type Actor = Record<string, unknown>;

describeEmbeddedPostgres("company artifacts privacy filtering (routes)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let previousMode: string | undefined;

  beforeAll(async () => {
    previousMode = process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
    process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = "enforce";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-artifacts-privacy-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueWorkProducts);
    await db.delete(issueAttachments);
    await db.delete(assets);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issues);
    await db.delete(projectAccessMembers);
    await db.delete(projects);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (previousMode === undefined) delete process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
    else process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = previousMode;
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const authorAgentId = randomUUID();
    const memberAgentId = randomUUID();
    const outsiderAgentId = randomUUID();
    const memberUserId = `synthetic-member-${randomUUID()}`;
    const outsiderUserId = `synthetic-outsider-${randomUUID()}`;
    const privateProjectId = randomUUID();
    const openProjectId = randomUUID();
    const privateIssueId = randomUUID();
    const openIssueId = randomUUID();
    const privateDocumentId = randomUUID();
    const openDocumentId = randomUUID();
    const privateAssetId = randomUUID();
    const privateAttachmentId = randomUUID();
    const privateWorkProductId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Synthetic Co",
      issuePrefix: "SYN",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: authorAgentId, companyId, name: "Synthetic Author", role: "engineer" },
      { id: memberAgentId, companyId, name: "Synthetic Member", role: "engineer" },
      { id: outsiderAgentId, companyId, name: "Synthetic Outsider", role: "engineer" },
    ]);
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: memberUserId, status: "active", membershipRole: "member" },
      { companyId, principalType: "user", principalId: outsiderUserId, status: "active", membershipRole: "member" },
    ]);
    await db.insert(projects).values([
      { id: privateProjectId, companyId, name: "Synthetic private project", status: "in_progress", visibility: "private" },
      { id: openProjectId, companyId, name: "Synthetic open project", status: "in_progress" },
    ]);
    await db.insert(projectAccessMembers).values([
      { companyId, projectId: privateProjectId, subjectType: "agent", subjectId: memberAgentId },
      { companyId, projectId: privateProjectId, subjectType: "user", subjectId: memberUserId },
    ]);
    await db.insert(issues).values([
      {
        id: privateIssueId,
        companyId,
        projectId: privateProjectId,
        identifier: "SYN-1",
        title: `Private ${NEEDLE} task`,
        status: "in_progress",
        priority: "medium",
      },
      {
        id: openIssueId,
        companyId,
        projectId: openProjectId,
        identifier: "SYN-2",
        title: `Open ${NEEDLE} task`,
        status: "in_progress",
        priority: "medium",
      },
    ]);
    await db.insert(documents).values([
      {
        id: privateDocumentId,
        companyId,
        title: `Private ${NEEDLE} notes`,
        latestBody: "Synthetic private document body.",
        createdByAgentId: authorAgentId,
      },
      {
        id: openDocumentId,
        companyId,
        title: `Open ${NEEDLE} notes`,
        latestBody: "Synthetic open document body.",
        createdByAgentId: authorAgentId,
      },
    ]);
    await db.insert(issueDocuments).values([
      { companyId, issueId: privateIssueId, documentId: privateDocumentId, key: "notes" },
      { companyId, issueId: openIssueId, documentId: openDocumentId, key: "notes" },
    ]);
    await db.insert(assets).values({
      id: privateAssetId,
      companyId,
      provider: "local_disk",
      objectKey: "synthetic/private.txt",
      contentType: "text/plain",
      byteSize: 16,
      sha256: "synthetic-sha256-private",
      originalFilename: `private-${NEEDLE}.txt`,
      createdByAgentId: authorAgentId,
    });
    await db.insert(issueAttachments).values({
      id: privateAttachmentId,
      companyId,
      issueId: privateIssueId,
      assetId: privateAssetId,
    });
    await db.insert(issueWorkProducts).values({
      id: privateWorkProductId,
      companyId,
      projectId: privateProjectId,
      issueId: privateIssueId,
      type: "artifact",
      provider: "paperclip",
      title: `Private ${NEEDLE} work product`,
      status: "ready_for_review",
      summary: "Synthetic private work product.",
      metadata: {},
    });

    const privateArtifactIds = [
      `document:${privateDocumentId}`,
      `attachment:${privateAttachmentId}`,
      `work_product:${privateWorkProductId}`,
    ];
    const openArtifactIds = [`document:${openDocumentId}`];

    const agentActor = (agentId: string): Actor => ({ type: "agent", agentId, companyId, source: "agent_jwt" });
    const boardActor = (userId: string): Actor => ({
      type: "board",
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole: "member" }],
      source: "session",
      isInstanceAdmin: false,
    });

    return {
      companyId,
      privateIssueId,
      privateArtifactIds,
      openArtifactIds,
      actors: {
        memberAgent: agentActor(memberAgentId),
        outsiderAgent: agentActor(outsiderAgentId),
        memberUser: boardActor(memberUserId),
        outsiderUser: boardActor(outsiderUserId),
      },
    };
  }

  function appFor(actor: Actor) {
    const storage = createStorageService();
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api/companies", companyRoutes(db, storage));
    app.use("/api", issueRoutes(db, storage, {
      searchRateLimiter: createCompanySearchRateLimiter({ maxRequests: 1_000, windowMs: 60_000 }),
    }));
    app.use(errorHandler);
    return app;
  }

  async function listArtifactIds(actor: Actor, companyId: string) {
    const res = await request(appFor(actor)).get(`/api/companies/${companyId}/artifacts`).query({ limit: 100 });
    expect(res.status).toBe(200);
    return (res.body.artifacts as Array<{ id: string }>).map((artifact) => artifact.id);
  }

  async function searchArtifacts(actor: Actor, companyId: string) {
    const res = await request(appFor(actor))
      .get(`/api/companies/${companyId}/search`)
      .query({ q: NEEDLE, scope: "artifacts", limit: 50 });
    expect(res.status).toBe(200);
    const ids = (res.body.results as Array<{ id: string; type: string }>)
      .filter((row) => row.type === "artifact")
      .map((row) => row.id);
    return { ids, count: res.body.countsByType.artifact as number };
  }

  it.each(["outsiderAgent", "outsiderUser"] as const)(
    "hides private-project artifacts from the company artifacts route for %s",
    async (who) => {
      const fixture = await seed();
      const ids = await listArtifactIds(fixture.actors[who], fixture.companyId);
      for (const id of fixture.privateArtifactIds) expect(ids).not.toContain(id);
      expect(ids).toEqual(expect.arrayContaining(fixture.openArtifactIds));
    },
  );

  it.each(["memberAgent", "memberUser"] as const)(
    "still lists private-project artifacts on the company artifacts route for %s",
    async (who) => {
      const fixture = await seed();
      const ids = await listArtifactIds(fixture.actors[who], fixture.companyId);
      expect(ids).toEqual(expect.arrayContaining([...fixture.privateArtifactIds, ...fixture.openArtifactIds]));
    },
  );

  it.each(["outsiderAgent", "outsiderUser"] as const)(
    "does not expose private task metadata through artifact groups for %s",
    async (who) => {
      const fixture = await seed();
      const app = appFor(fixture.actors[who]);

      const grouped = await request(app)
        .get(`/api/companies/${fixture.companyId}/artifacts`)
        .query({ groupBy: "task", limit: 100 });
      expect(grouped.status).toBe(200);
      const groupIssueIds = (grouped.body.groups as Array<{ issue: { id: string } }>).map((group) => group.issue.id);
      expect(groupIssueIds).not.toContain(fixture.privateIssueId);

      const selected = await request(app)
        .get(`/api/companies/${fixture.companyId}/artifacts`)
        .query({ groupBy: "task", groupIssueId: fixture.privateIssueId, limit: 100 });
      expect(selected.status).toBe(200);
      expect(selected.body.artifacts).toEqual([]);
      expect(selected.body.selectedGroup ?? null).toBeNull();
      expect(JSON.stringify(selected.body)).not.toContain(NEEDLE);
    },
  );

  it.each(["outsiderAgent", "outsiderUser"] as const)(
    "hides private-project artifacts from company search results and counts for %s",
    async (who) => {
      const fixture = await seed();
      const { ids, count } = await searchArtifacts(fixture.actors[who], fixture.companyId);
      for (const id of fixture.privateArtifactIds) expect(ids).not.toContain(id);
      expect(ids).toEqual(expect.arrayContaining(fixture.openArtifactIds));
      expect(count).toBe(fixture.openArtifactIds.length);
    },
  );

  it.each(["memberAgent", "memberUser"] as const)(
    "still returns private-project artifacts from company search for %s",
    async (who) => {
      const fixture = await seed();
      const { ids, count } = await searchArtifacts(fixture.actors[who], fixture.companyId);
      expect(ids).toEqual(expect.arrayContaining([...fixture.privateArtifactIds, ...fixture.openArtifactIds]));
      expect(count).toBe(fixture.privateArtifactIds.length + fixture.openArtifactIds.length);
    },
  );
});
