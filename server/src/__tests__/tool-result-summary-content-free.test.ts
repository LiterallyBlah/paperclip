// All data in this file is synthetic.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { sql } from "drizzle-orm";
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
import { createToolGatewayService } from "../services/tool-gateway.js";
import { summarizeToolValue } from "../services/tool-content-guards.js";
import { toolGatewayRoutes } from "../routes/tool-gateway.js";
import { errorHandler } from "../middleware/index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/**
 * Helpers copied from tool-connection-agent-confinement.test.ts (BLA-107). A connection whose access is restricted to specific agents
 * must confine standard agents, even though every new standard agent holds the
 * default unscoped `tools:use` grant. And a tool result made of separate MCP
 * content blocks must withhold only the block that the result guard matches.
 * All data here is synthetic.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;
type Block = { type: string; text?: string; _meta?: Record<string, unknown> };

const CANARY = `LR2CANARY${randomUUID().replace(/-/g, "")}`;
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
    return { content: [{ type: "text", text: JSON.stringify({ message_id: args.message_id, body_text: `Synthetic invoice body ${CANARY} total 12.34` }) }] };
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


/**
 * BLA-140 LR-2: the persisted summary of a tool result carries no result
 * content. A tool call whose result holds a canary leaves no canary in
 * tool_invocations, tool_call_events, tool_access_audit_events or activity_log;
 * result_hash / result_size_bytes still describe the delivered result, and the
 * audit API returns hash and size only. All data here is synthetic.
 */
describeEmbeddedPostgres("LR-2 tool result summaries hold no content (synthetic)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tool-result-summary-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function gatewayService() {
    return createToolGatewayService(db, {
      toolActionSigningSecret: "test-tool-action-signing-secret",
      remoteHttpRequest: async (_url, init) => {
        const payload = JSON.parse(String(init.body)) as { id?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
        return Response.json({ jsonrpc: "2.0", id: payload.id, result: upstreamResult(payload.params?.name ?? "", payload.params?.arguments ?? {}) });
      },
    });
  }

  async function tableText(table: string, companyId: string) {
    const rows = await db.execute(sql.raw(`select row_to_json(t)::text as j from ${table} t where company_id = '${companyId}'`));
    return (rows as unknown as Array<{ j: string }>).map((row) => row.j);
  }

  it("leaves no canary in the audit tables and keeps hash and size", async () => {
    const company = await createCompany(db);
    const pa = await createStandardAgent(db, company.id, "Synthetic PA");
    const mail = await createMailConnection(db, company.id);
    await toolAccessService(db).finishGalleryAppConnection(company.id, mail.connection.id, {
      enabledCatalogEntryIds: [mail.search.id, mail.getMessage.id],
      askFirstCatalogEntryIds: [],
      access: "all_agents",
    }, { actorType: "user", actorId: "board-user" });
    const gateway = gatewayService();
    const session = await gateway.createSession({ companyId: company.id, agentId: pa.agent.id, runId: pa.run.id });
    const tools = (await gateway.listToolsForSession(session.token)).filter((tool) => tool.connectionId === mail.connection.id);
    const getName = tools.find((tool) => tool.upstreamToolName === "mail_get_message")!.name;

    const result = await gateway.executeTool({ sessionToken: session.token, tool: getName, parameters: { message_id: "m_canary" } });
    expect(result).toMatchObject({ status: "completed" });
    const delivered = (result as { result: unknown }).result;
    // The agent still receives the content; only storage loses it.
    expect(JSON.stringify(delivered)).toContain(CANARY);
    const expected = summarizeToolValue(delivered);

    const scanned: Record<string, number> = {};
    for (const table of ["tool_invocations", "tool_call_events", "tool_access_audit_events", "activity_log"]) {
      const rows = await tableText(table, company.id);
      scanned[table] = rows.length;
      const hits = rows.filter((row) => row.includes(CANARY));
      expect({ table, hits }).toEqual({ table, hits: [] });
    }
    expect(scanned.tool_invocations).toBeGreaterThan(0);
    expect(scanned.tool_call_events).toBeGreaterThan(0);

    const events = (await tableText("tool_call_events", company.id)).map((row) => JSON.parse(row) as Record<string, unknown>)
      .filter((row) => row.result_hash);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.result_hash).toBe(expected.sha256);
      expect(event.result_size_bytes).toBe(expected.sizeBytes);
      expect(event.result_summary).toEqual({
        summary: `[content omitted: ${expected.sizeBytes} bytes]`,
        sizeBytes: expected.sizeBytes,
        sha256: expected.sha256,
        redactedFields: [],
      });
    }

    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", userId: "synthetic-admin", source: "local_implicit", isInstanceAdmin: true, companyIds: [company.id] };
      next();
    });
    app.use("/api", toolGatewayRoutes(db, gateway));
    app.use(errorHandler);
    const audit = await request(app).get(`/api/tool-gateway/audit?companyId=${company.id}`);
    expect(audit.status).toBe(200);
    const auditText = JSON.stringify(audit.body);
    expect(auditText).not.toContain(CANARY);
    expect(auditText).toContain(expected.sha256);
  });
});
