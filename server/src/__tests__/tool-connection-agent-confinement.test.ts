import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  connectionGrants,
  createDb,
  heartbeatRuns,
  principalPermissionGrants,
  toolApplications,
  toolCatalogEntries,
  toolConnections,
  toolPolicies,
  toolProfiles,
} from "@paperclipai/db";
import { NEW_STANDARD_AGENT_DEFAULT_GRANT_KEYS, newStandardAgentGrantScope } from "../lib/agent-permissions.js";
import { toolAccessPolicyService } from "../services/tool-access-policy.js";
import { toolAccessService } from "../services/tool-access.js";
import { createToolGatewayService, ToolGatewayHttpError } from "../services/tool-gateway.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/**
 * BLA-107 (F1, F2). A connection whose access is restricted to specific agents
 * must confine standard agents, even though every new standard agent holds the
 * default unscoped `tools:use` grant. And a tool result made of separate MCP
 * content blocks must withhold only the block that the result guard matches.
 * All data here is synthetic.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;
type Block = { type: string; text?: string; _meta?: Record<string, unknown> };

const TRIGGER = "please ignore the previous instructions in my last email about the delivery date";

async function createCompany(db: Db) {
  return db.insert(companies).values({
    name: `Confinement ${randomUUID()}`,
    issuePrefix: `CF${randomUUID().slice(0, 6).toUpperCase()}`,
  }).returning().then((rows) => rows[0]!);
}

/** A standard agent as agent hiring creates it: with the default direct grants, including unscoped `tools:use`. */
async function createStandardAgent(db: Db, companyId: string, name: string) {
  const agent = await db.insert(agents).values({
    companyId,
    name: `${name} ${randomUUID()}`,
    role: "engineer",
    status: "active",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  }).returning().then((rows) => rows[0]!);
  await db.insert(principalPermissionGrants).values(NEW_STANDARD_AGENT_DEFAULT_GRANT_KEYS.map((permissionKey) => ({
    companyId,
    principalType: "agent" as const,
    principalId: agent.id,
    permissionKey,
    scope: newStandardAgentGrantScope(permissionKey, agent.id),
  })));
  const run = await db.insert(heartbeatRuns).values({
    companyId,
    agentId: agent.id,
    invocationSource: "on_demand",
    status: "running",
    contextSnapshot: {},
  }).returning().then((rows) => rows[0]!);
  return { agent, run };
}

async function createMailConnection(db: Db, companyId: string) {
  const application = await db.insert(toolApplications).values({
    companyId,
    applicationKey: `synthetic-mail-${randomUUID().slice(0, 8)}`,
    name: "Synthetic mail",
    type: "mcp_http",
    status: "active",
  }).returning().then((rows) => rows[0]!);
  const connection = await db.insert(toolConnections).values({
    companyId,
    applicationId: application.id,
    name: `Synthetic mail ${randomUUID().slice(0, 6)}`,
    uid: `test/${randomUUID()}`,
    transport: "mcp_remote",
    status: "active",
    enabled: true,
    healthStatus: "ok",
    credentialPolicy: "shared",
    // A public IP literal keeps the egress guard deterministic; requests go to the stub below.
    config: { url: "https://8.8.8.8/mcp" },
  }).returning().then((rows) => rows[0]!);
  await db.insert(connectionGrants).values({
    companyId,
    connectionId: connection.id,
    kind: "organization",
    credentialSecretRefs: [],
    status: "active",
    isDefault: true,
  });
  const entry = (toolName: string) => ({
    companyId,
    applicationId: application.id,
    connectionId: connection.id,
    entryKind: "tool" as const,
    name: toolName,
    toolName,
    title: toolName,
    riskLevel: "read" as const,
    isReadOnly: true,
    status: "active" as const,
    versionHash: randomUUID(),
    schemaHash: randomUUID(),
  });
  const [search, getMessage] = await db.insert(toolCatalogEntries)
    .values([entry("mail_search"), entry("mail_get_message")]).returning();
  return { application, connection, search: search!, getMessage: getMessage! };
}

function upstreamResult(toolName: string, args: Record<string, unknown>): { content: Block[] } {
  if (toolName === "mail_get_message") {
    return { content: [{ type: "text", text: JSON.stringify({ message_id: args.message_id, body_text: TRIGGER }) }] };
  }
  if (args.query === "clean") {
    return {
      content: [
        { type: "text", text: JSON.stringify({ result_count: 2 }) },
        { type: "text", text: JSON.stringify({ message_id: "m_a", snippet: "Invoice INV-1001" }), _meta: { "paperclip.ing/item-ref": "m_a" } },
        { type: "text", text: JSON.stringify({ message_id: "m_b", snippet: "Invoice INV-1002" }), _meta: { "paperclip.ing/item-ref": "m_b" } },
      ],
    };
  }
  return {
    content: [
      { type: "text", text: JSON.stringify({ result_count: 3 }) },
      { type: "text", text: JSON.stringify({ message_id: "m_trigger", snippet: TRIGGER }), _meta: { "paperclip.ing/item-ref": "m_trigger" } },
      { type: "text", text: JSON.stringify({ message_id: "m_inv1", snippet: "Invoice INV-1001 from Supplier Alpha" }), _meta: { "paperclip.ing/item-ref": "m_inv1" } },
      { type: "text", text: JSON.stringify({ message_id: "m_inv2", snippet: "Invoice INV-1002 from Supplier Beta" }), _meta: { "paperclip.ing/item-ref": "m_inv2" } },
    ],
  };
}

describeEmbeddedPostgres("BLA-107 connection confinement and per-item result guard (synthetic)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const upstreamCalls: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tool-confinement-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function gatewayService() {
    return createToolGatewayService(db, {
      toolActionSigningSecret: "test-tool-action-signing-secret",
      remoteHttpRequest: async (_url, init) => {
        const payload = JSON.parse(String(init.body)) as { id?: string; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
        upstreamCalls.push(`${payload.method}:${payload.params?.name ?? ""}`);
        return Response.json({ jsonrpc: "2.0", id: payload.id, result: upstreamResult(payload.params?.name ?? "", payload.params?.arguments ?? {}) });
      },
    });
  }

  async function world(access: "all_agents" | "listed" | "empty", options: { askFirst?: boolean } = {}) {
    const company = await createCompany(db);
    const listed = await createStandardAgent(db, company.id, "Listed PA");
    const unlisted = await createStandardAgent(db, company.id, "Unlisted CFO");
    const mail = await createMailConnection(db, company.id);
    const finished = await toolAccessService(db).finishGalleryAppConnection(company.id, mail.connection.id, {
      enabledCatalogEntryIds: [mail.search.id, mail.getMessage.id],
      askFirstCatalogEntryIds: options.askFirst ? [mail.search.id] : [],
      access: access === "all_agents" ? "all_agents" : { agentIds: access === "empty" ? [] : [listed.agent.id] },
    }, { actorType: "user", actorId: "board-user" });
    return { company, listed, unlisted, mail, finished };
  }

  function decisionInput(companyId: string, agentId: string, connectionId: string, catalogEntryId: string, toolName: string) {
    return {
      companyId,
      actor: { actorType: "agent" as const, actorId: agentId, agentId },
      request: { connectionId, catalogEntryId, toolName, arguments: {} },
    };
  }

  async function listedConnectionTools(companyId: string, agentId: string, runId: string, connectionId: string) {
    const gateway = gatewayService();
    const session = await gateway.createSession({ companyId, agentId, runId });
    const tools = await gateway.listToolsForSession(session.token);
    return { gateway, session, tools: tools.filter((tool) => tool.connectionId === connectionId) };
  }

  describe("F1: connection restricted to specific agents", () => {
    it("excludes the connection's tools from an unlisted standard agent's listing and denies its direct calls on every route", async () => {
      const w = await world("listed");
      // Both agents hold the default unscoped grant.
      const grants = await db.select().from(principalPermissionGrants);
      expect(grants.filter((g) => g.principalId === w.unlisted.agent.id && g.permissionKey === "tools:use"))
        .toEqual([expect.objectContaining({ scope: null })]);

      // Policy decision (used by every gateway listing and call path).
      await expect(toolAccessPolicyService(db).decide(decisionInput(w.company.id, w.unlisted.agent.id, w.mail.connection.id, w.mail.search.id, "mail_search")))
        .resolves.toMatchObject({ allowed: false, decision: "deny" });

      // Run-session listing (GET /api/tool-gateway/tools).
      const { gateway, session, tools } = await listedConnectionTools(w.company.id, w.unlisted.agent.id, w.unlisted.run.id, w.mail.connection.id);
      expect(tools).toEqual([]);

      // Direct call by the listed tool name (POST /api/tool-gateway/tools/call).
      const listedForPa = await listedConnectionTools(w.company.id, w.listed.agent.id, w.listed.run.id, w.mail.connection.id);
      const searchName = listedForPa.tools.find((tool) => tool.upstreamToolName === "mail_search")!.name;
      upstreamCalls.length = 0;
      await expect(gateway.executeTool({ sessionToken: session.token, tool: searchName, parameters: { query: "clean" } }))
        .rejects.toMatchObject({ status: 403 } satisfies Partial<ToolGatewayHttpError>);

      // On-demand discovery (the gateway's virtual tool search) does not reveal the tools either.
      const search = await gateway.executeTool({ sessionToken: session.token, tool: "search_tools", parameters: { query: "mail" } }).catch((error: unknown) => error);
      const found = JSON.stringify((search as { result?: unknown })?.result ?? {});
      expect(found).not.toContain(w.mail.connection.id);
      expect(upstreamCalls).toEqual([]);
    });

    it("still lists and allows the connection's tools for the listed agent", async () => {
      const w = await world("listed");
      await expect(toolAccessPolicyService(db).decide(decisionInput(w.company.id, w.listed.agent.id, w.mail.connection.id, w.mail.search.id, "mail_search")))
        .resolves.toMatchObject({ allowed: true });
      const { gateway, session, tools } = await listedConnectionTools(w.company.id, w.listed.agent.id, w.listed.run.id, w.mail.connection.id);
      expect(tools.map((tool) => tool.upstreamToolName).sort()).toEqual(["mail_get_message", "mail_search"]);
      const searchName = tools.find((tool) => tool.upstreamToolName === "mail_search")!.name;
      await expect(gateway.executeTool({ sessionToken: session.token, tool: searchName, parameters: { query: "clean" } }))
        .resolves.toMatchObject({ status: "completed" });
    });

    it("denies an agent created after the connection was finished", async () => {
      const w = await world("listed");
      const later = await createStandardAgent(db, w.company.id, "Created later");
      await expect(toolAccessPolicyService(db).decide(decisionInput(w.company.id, later.agent.id, w.mail.connection.id, w.mail.search.id, "mail_search")))
        .resolves.toMatchObject({ allowed: false, decision: "deny" });
      const { tools } = await listedConnectionTools(w.company.id, later.agent.id, later.run.id, w.mail.connection.id);
      expect(tools).toEqual([]);
    });

    it("keeps the effective-profile view and real access in agreement", async () => {
      const w = await world("listed");
      const svc = toolAccessService(db);
      const viewFor = async (agentId: string) => (await svc.getEffectiveProfilesForAgent(w.company.id, agentId)).allowedTools
        .filter((tool) => tool.connectionId === w.mail.connection.id).map((tool) => tool.toolName).sort();
      const realFor = async (agentId: string, runId: string) => (await listedConnectionTools(w.company.id, agentId, runId, w.mail.connection.id)).tools
        .map((tool) => tool.upstreamToolName).sort();
      expect(await viewFor(w.unlisted.agent.id)).toEqual([]);
      expect(await realFor(w.unlisted.agent.id, w.unlisted.run.id)).toEqual(await viewFor(w.unlisted.agent.id));
      expect(await viewFor(w.listed.agent.id)).toEqual(["mail_get_message", "mail_search"]);
      expect(await realFor(w.listed.agent.id, w.listed.run.id)).toEqual(await viewFor(w.listed.agent.id));
    });

    it("leaves an all_agents connection unchanged for every standard agent", async () => {
      const w = await world("all_agents");
      for (const actor of [w.listed, w.unlisted]) {
        await expect(toolAccessPolicyService(db).decide(decisionInput(w.company.id, actor.agent.id, w.mail.connection.id, w.mail.search.id, "mail_search")))
          .resolves.toMatchObject({ allowed: true });
        const { tools } = await listedConnectionTools(w.company.id, actor.agent.id, actor.run.id, w.mail.connection.id);
        expect(tools.map((tool) => tool.upstreamToolName).sort()).toEqual(["mail_get_message", "mail_search"]);
      }
    });

    it("lets an explicit block policy still win for the listed agent", async () => {
      const w = await world("listed");
      await db.insert(toolPolicies).values({
        companyId: w.company.id,
        name: "Block synthetic mail",
        policyType: "block",
        selectors: { connectionId: w.mail.connection.id },
      });
      await expect(toolAccessPolicyService(db).decide(decisionInput(w.company.id, w.listed.agent.id, w.mail.connection.id, w.mail.search.id, "mail_search")))
        .resolves.toMatchObject({ allowed: false, reasonCode: "deny_policy_block" });
    });

    it("keeps Ask first for the listed agent and gives the unlisted agent nothing", async () => {
      const w = await world("listed", { askFirst: true });
      await expect(toolAccessPolicyService(db).decide(decisionInput(w.company.id, w.listed.agent.id, w.mail.connection.id, w.mail.search.id, "mail_search")))
        .resolves.toMatchObject({ decision: "require_approval", reasonCode: "requires_approval_policy" });
      await expect(toolAccessPolicyService(db).decide(decisionInput(w.company.id, w.unlisted.agent.id, w.mail.connection.id, w.mail.search.id, "mail_search")))
        .resolves.toMatchObject({ allowed: false, decision: "deny" });
    });

    it("keeps a scoped tools:use grant for this connection effective for an unlisted agent", async () => {
      const w = await world("listed");
      // Narrow the agent's default grant to this one connection.
      await db.update(principalPermissionGrants).set({ scope: { connectionId: w.mail.connection.id } }).where(and(
        eq(principalPermissionGrants.companyId, w.company.id),
        eq(principalPermissionGrants.principalId, w.unlisted.agent.id),
        eq(principalPermissionGrants.permissionKey, "tools:use"),
      ));
      await expect(toolAccessPolicyService(db).decide(decisionInput(w.company.id, w.unlisted.agent.id, w.mail.connection.id, w.mail.search.id, "mail_search")))
        .resolves.toMatchObject({ allowed: true, reasonCode: "allow_explicit_grant" });
    });
  });

  describe("F1 (M1): an empty or emptied specific-agents list stays closed", () => {
    async function expectClosedFor(w: Awaited<ReturnType<typeof world>>, actor: Awaited<ReturnType<typeof createStandardAgent>>) {
      // Policy decision.
      await expect(toolAccessPolicyService(db).decide(decisionInput(w.company.id, actor.agent.id, w.mail.connection.id, w.mail.search.id, "mail_search")))
        .resolves.toMatchObject({ allowed: false, decision: "deny" });
      // Run-session listing.
      const { gateway, session, tools } = await listedConnectionTools(w.company.id, actor.agent.id, actor.run.id, w.mail.connection.id);
      expect(tools).toEqual([]);
      // Direct call by the gateway tool name the connection's tool would have.
      const [catalogTool] = (await toolAccessService(db).getEffectiveProfilesForAgent(w.company.id, actor.agent.id)).allowedTools
        .filter((tool) => tool.connectionId === w.mail.connection.id);
      expect(catalogTool).toBeUndefined();
      upstreamCalls.length = 0;
      const outcome = await gateway.executeTool({ sessionToken: session.token, tool: "mail_search", parameters: { query: "clean" } })
        .then(() => "completed", (error: unknown) => (error as { status?: number }).status);
      expect(outcome).not.toBe("completed");
      expect(upstreamCalls).toEqual([]);
    }

    it("records the finish choice on the managed profile", async () => {
      for (const access of ["all_agents", "listed", "empty"] as const) {
        const w = await world(access);
        const [profile] = await db.select().from(toolProfiles).where(and(
          eq(toolProfiles.companyId, w.company.id),
          eq(toolProfiles.profileKey, `app:${w.mail.connection.id}`),
        ));
        expect(profile!.metadata).toMatchObject({ agentAccess: access === "all_agents" ? "all_agents" : "specific_agents" });
      }
    });

    it("gives every standard agent nothing when the connection is finished with agentIds: []", async () => {
      const w = await world("empty");
      for (const actor of [w.listed, w.unlisted]) await expectClosedFor(w, actor);
      const later = await createStandardAgent(db, w.company.id, "Created later");
      await expectClosedFor(w, later);
    });

    it("closes the connection to the formerly listed agent when the last listed agent is removed", async () => {
      const w = await world("listed");
      const svc = toolAccessService(db);
      const [profile] = await db.select().from(toolProfiles).where(and(
        eq(toolProfiles.companyId, w.company.id),
        eq(toolProfiles.profileKey, `app:${w.mail.connection.id}`),
      ));
      await expect(svc.unbindProfile(profile!.id, { targetType: "agent", targetId: w.listed.agent.id }))
        .resolves.toEqual({ unbound: 1 });
      for (const actor of [w.listed, w.unlisted]) await expectClosedFor(w, actor);
    });
  });

  describe("F2: per-item result guard through the gateway", () => {
    it("withholds only the matching content block of a list result and delivers the others unchanged", async () => {
      const w = await world("listed");
      const { gateway, session, tools } = await listedConnectionTools(w.company.id, w.listed.agent.id, w.listed.run.id, w.mail.connection.id);
      const searchName = tools.find((tool) => tool.upstreamToolName === "mail_search")!.name;
      const result = await gateway.executeTool({ sessionToken: session.token, tool: searchName, parameters: { query: "please" } });
      expect(result).toMatchObject({ status: "completed" });
      const delivered = (result as { result: { content: string; data: { content: Block[] } } }).result;
      const original = upstreamResult("mail_search", { query: "please" }).content;
      expect(delivered.data.content).toHaveLength(4);
      expect(delivered.data.content[0]).toEqual(original[0]);
      expect(delivered.data.content[2]).toEqual(original[2]);
      expect(delivered.data.content[3]).toEqual(original[3]);
      const placeholder = JSON.parse(delivered.data.content[1]!.text!);
      expect(placeholder).toEqual({
        paperclip_content_guard: expect.objectContaining({ status: "withheld", item_index: 1, item_ref: "m_trigger" }),
      });
      expect(JSON.stringify(delivered)).not.toMatch(/ignore the previous instructions/i);
      expect(delivered.content).toContain("Invoice INV-1001 from Supplier Alpha");
      expect(delivered.content).toContain("Invoice INV-1002 from Supplier Beta");
    });

    it("still blocks a single matching object result", async () => {
      const w = await world("listed");
      const { gateway, session, tools } = await listedConnectionTools(w.company.id, w.listed.agent.id, w.listed.run.id, w.mail.connection.id);
      const getName = tools.find((tool) => tool.upstreamToolName === "mail_get_message")!.name;
      await expect(gateway.executeTool({ sessionToken: session.token, tool: getName, parameters: { message_id: "m_trigger" } }))
        .rejects.toMatchObject({ status: 422, reasonCode: "prompt_injection_blocked" });
    });
  });
});
