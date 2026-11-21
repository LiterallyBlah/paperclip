import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
  plugins,
  projectAccessMembers,
  projects,
  routines,
} from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { accessService } from "../services/access.js";
import { pluginCapabilityValidator } from "../services/plugin-capability-validator.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const eventBusStub = { forPlugin: () => ({ emit: async () => {}, subscribe: () => {} }) } as any;

// A plugin with no routine, project or access capability at all.
const pluginManifest: PaperclipPluginManifestV1 = {
  id: "paperclip.routine-access-check-test",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Routine access check test",
  description: "Test plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["plugin.state.read", "plugin.state.write"],
  entrypoints: { worker: "./dist/worker.js" },
};

describeEmbeddedPostgres("plugin routines.readableByUser", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-routine-readable-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.delete(routines);
    await db.delete(projectAccessMembers);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(instanceUserRoles);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(name: string) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
    });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId, companyId, name: `${name} agent`, role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    const privateProjectId = randomUUID();
    const openProjectId = randomUUID();
    await db.insert(projects).values([
      { id: privateProjectId, companyId, name: "Private client project", status: "in_progress", visibility: "private" },
      { id: openProjectId, companyId, name: "Open project", status: "in_progress" },
    ]);
    const privateRoutineId = randomUUID();
    const openProjectRoutineId = randomUUID();
    const noProjectRoutineId = randomUUID();
    await db.insert(routines).values([
      { id: privateRoutineId, companyId, projectId: privateProjectId, assigneeAgentId: agentId, title: "Private routine" },
      { id: openProjectRoutineId, companyId, projectId: openProjectId, assigneeAgentId: agentId, title: "Open-project routine" },
      { id: noProjectRoutineId, companyId, assigneeAgentId: agentId, title: "No-project routine" },
    ]);
    return { companyId, privateProjectId, privateRoutineId, openProjectRoutineId, noProjectRoutineId };
  }

  async function setup() {
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
    const a = await seedCompany("Company A");
    const b = await seedCompany("Company B");
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: pluginManifest.id,
      packageName: "@paperclipai/plugin-routine-access-check-test",
      version: pluginManifest.version,
      apiVersion: pluginManifest.apiVersion,
      categories: pluginManifest.categories,
      manifestJson: pluginManifest,
      status: "ready",
      installOrder: 1,
    });
    const services = buildHostServices(db, pluginId, pluginManifest.id, eventBusStub, undefined, { manifest: pluginManifest });
    const access = accessService(db);
    const projectMember = randomUUID();
    const outsider = randomUUID();
    const viewerMember = randomUUID();
    const otherCompanyUser = randomUUID();
    const instanceAdmin = randomUUID();
    await access.ensureMembership(a.companyId, "user", projectMember, "member", "active");
    await access.ensureMembership(a.companyId, "user", outsider, "member", "active");
    await access.ensureMembership(a.companyId, "user", viewerMember, "viewer", "active");
    await access.ensureMembership(b.companyId, "user", otherCompanyUser, "member", "active");
    await db.insert(projectAccessMembers).values([
      { companyId: a.companyId, projectId: a.privateProjectId, subjectType: "user", subjectId: projectMember },
      { companyId: a.companyId, projectId: a.privateProjectId, subjectType: "user", subjectId: viewerMember },
    ]);
    await db.insert(instanceUserRoles).values({ userId: instanceAdmin, role: "instance_admin" });
    const allA = [a.privateRoutineId, a.openProjectRoutineId, a.noProjectRoutineId];
    return { a, b, services, allA, projectMember, outsider, viewerMember, otherCompanyUser, instanceAdmin };
  }

  const sorted = (ids: string[]) => [...ids].sort();

  it("returns private-project routines only to project members", async () => {
    const { a, services, allA, projectMember, outsider, viewerMember } = await setup();
    const check = (userId: string) => services.routines.readableByUser({ companyId: a.companyId, userId, routineIds: allA });

    expect(sorted(await check(projectMember))).toEqual(sorted(allA));
    expect(sorted(await check(viewerMember))).toEqual(sorted(allA));
    // A company member outside the private project sees only the other routines.
    expect(sorted(await check(outsider))).toEqual(sorted([a.openProjectRoutineId, a.noProjectRoutineId]));
  });

  it("gives nothing to users outside the company and never crosses companies", async () => {
    const { a, b, services, allA, otherCompanyUser, projectMember } = await setup();
    // A member of company B asking about company A's routines.
    expect(await services.routines.readableByUser({ companyId: a.companyId, userId: otherCompanyUser, routineIds: allA })).toEqual([]);
    // An unknown user.
    expect(await services.routines.readableByUser({ companyId: a.companyId, userId: randomUUID(), routineIds: allA })).toEqual([]);
    // Company B's routine ids asked under company A's scope are not returned, even for an A member.
    const bIds = [b.privateRoutineId, b.openProjectRoutineId, b.noProjectRoutineId];
    expect(await services.routines.readableByUser({ companyId: a.companyId, userId: projectMember, routineIds: bIds })).toEqual([]);
    // Unknown and malformed ids are dropped.
    expect(await services.routines.readableByUser({ companyId: a.companyId, userId: projectMember, routineIds: [randomUUID(), "not-a-uuid"] })).toEqual([]);
  });

  it("follows the same admin bypasses as the routines REST path", async () => {
    const { a, services, allA, instanceAdmin } = await setup();
    expect(sorted(await services.routines.readableByUser({ companyId: a.companyId, userId: instanceAdmin, routineIds: allA }))).toEqual(sorted(allA));
    expect(sorted(await services.routines.readableByUser({ companyId: a.companyId, userId: "local-board", routineIds: allA }))).toEqual(sorted(allA));
  });

  it("needs no capability and changes no data", async () => {
    const validator = pluginCapabilityValidator();
    expect(validator.getRequiredCapabilities("routines.readableByUser")).toEqual([]);
    const { a, services, allA, outsider } = await setup();
    const before = await db.select().from(routines);
    await services.routines.readableByUser({ companyId: a.companyId, userId: outsider, routineIds: allA });
    expect(await db.select().from(routines)).toEqual(before);
  });
});
