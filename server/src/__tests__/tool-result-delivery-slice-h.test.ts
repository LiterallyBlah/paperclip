// All data in this file is synthetic.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  connectionGrants,
  createDb,
  heartbeatRuns,
  issues,
  toolApplications,
  toolCatalogEntries,
  toolConnections,
  toolInvocations,
} from "@paperclipai/db";
import { toolAccessService } from "../services/tool-access.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/**
 * BLA-150 Slice H: LR-2 keeps read-tool results out of storage without the
 * three delivery regressions it introduced at 1cd2628:
 *  (a) an approved write action delivered from storage returns its result,
 *  (b) the ask-first test-call status shows the result of a write tool,
 *  (c) a provider hand-off survives a restart (a new gateway instance) with
 *      only kind and identifiers persisted; no upstream free text is stored.
 * Read-tool results stay content-free in every case.
 */
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
type Db = ReturnType<typeof createDb>;

const CANARY = `SLICEHCANARY${randomUUID().replace(/-/g, "")}`;
const actor = { actorType: "user" as const, actorId: "synthetic-board-user", actorSource: "local_implicit" as const };
const SIGNING = "synthetic-tool-action-signing-secret";

describeEmbeddedPostgres("Slice H: LR-2 delivery without regressions (synthetic)", () => {
  let db!: Db;
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let keyDir = "";

  beforeAll(async () => {
    keyDir = await mkdtemp(join(tmpdir(), "slice-h-secrets-"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", join(keyDir, "key"));
    fixture = await startEmbeddedPostgresTestDatabase("paperclip-slice-h-");
    db = createDb(fixture.connectionString);
  }, 30_000);

  afterAll(async () => {
    await fixture?.cleanup();
    vi.unstubAllEnvs();
    if (keyDir) await rm(keyDir, { recursive: true, force: true });
  });

  async function company() {
    const [row] = await db.insert(companies).values({
      name: `Slice H ${randomUUID()}`, issuePrefix: `H${randomUUID().slice(0, 5).toUpperCase()}`,
    }).returning();
    await db.insert(companyMemberships).values({
      companyId: row!.id, principalType: "user", principalId: actor.actorId, status: "active", membershipRole: "admin",
    });
    return row!;
  }

  async function tableText(table: string, companyId: string) {
    const rows = await db.execute(sql.raw(`select row_to_json(t)::text as j from ${table} t where company_id = '${companyId}'`));
    return (rows as unknown as Array<{ j: string }>).map((row) => row.j);
  }

  async function expectNoCanary(companyId: string) {
    for (const table of ["tool_invocations", "tool_call_events", "tool_access_audit_events", "activity_log", "tool_action_requests"]) {
      const hits = (await tableText(table, companyId)).filter((row) => row.includes(CANARY));
      expect({ table, hits }).toEqual({ table, hits: [] });
    }
  }

  /** A generic remote MCP connection with one read and one write tool, both ask-first. */
  async function writeAndReadConnection(companyId: string) {
    const application = await db.insert(toolApplications).values({
      companyId, applicationKey: `synthetic-app-${randomUUID().slice(0, 8)}`, name: "Synthetic app", type: "mcp_http", status: "active",
    }).returning().then((rows) => rows[0]!);
    const connection = await db.insert(toolConnections).values({
      companyId, applicationId: application.id, name: `Synthetic ${randomUUID().slice(0, 6)}`, uid: `test/${randomUUID()}`,
      transport: "mcp_remote", status: "active", enabled: true, healthStatus: "ok", credentialPolicy: "shared",
      config: { url: "https://8.8.8.8/mcp" },
    }).returning().then((rows) => rows[0]!);
    await db.insert(connectionGrants).values({
      companyId, connectionId: connection.id, kind: "organization", credentialSecretRefs: [], status: "active", isDefault: true,
    });
    const entry = (toolName: string, riskLevel: "read" | "write") => ({
      companyId, applicationId: application.id, connectionId: connection.id, entryKind: "tool" as const,
      name: toolName, toolName, title: toolName, riskLevel, isReadOnly: riskLevel === "read", isWrite: riskLevel === "write",
      status: "active" as const, versionHash: randomUUID(), schemaHash: randomUUID(),
    });
    const [readEntry, writeEntry] = await db.insert(toolCatalogEntries)
      .values([entry("synthetic_read", "read"), entry("synthetic_create_record", "write")]).returning();
    return { connection, readEntry: readEntry!, writeEntry: writeEntry! };
  }

  function upstream(calls: string[]) {
    return async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { id?: string; method?: string; params?: { name?: string } };
      calls.push(body.params?.name ?? String(body.method));
      const name = body.params?.name ?? "";
      const data = name === "synthetic_read"
        ? { note: `Synthetic read body ${CANARY}` }
        : { record_id: "rec_synthetic_1", status: "created" };
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify(data) }] } });
    };
  }

  async function agentWithIssueRun(companyId: string) {
    const [agent] = await db.insert(agents).values({
      companyId, name: `Synthetic Agent ${randomUUID().slice(0, 6)}`, role: "engineer", status: "active",
      adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    }).returning();
    const [issue] = await db.insert(issues).values({
      companyId, title: "Synthetic approved action", status: "in_progress", assigneeAgentId: agent!.id,
    }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId: agent!.id, invocationSource: "assignment", status: "running", contextSnapshot: { issueId: issue!.id },
    }).returning();
    return { agent: agent!, issue: issue!, run: run! };
  }

  it("(a) an approved write action delivered from storage returns its result; a read stays content-free", async () => {
    const org = await company();
    const { connection, readEntry, writeEntry } = await writeAndReadConnection(org.id);
    const { agent, run } = await agentWithIssueRun(org.id);
    await toolAccessService(db).finishGalleryAppConnection(org.id, connection.id, {
      enabledCatalogEntryIds: [readEntry.id, writeEntry.id], askFirstCatalogEntryIds: [readEntry.id, writeEntry.id], access: "all_agents",
    }, actor);
    const calls: string[] = [];
    const gateway = createToolGatewayService(db, { toolActionSigningSecret: SIGNING, remoteHttpRequest: upstream(calls) });
    const session = await gateway.createSession({ companyId: org.id, agentId: agent.id, runId: run.id });
    const tools = (await gateway.listToolsForSession(session.token)).filter((tool) => tool.connectionId === connection.id);

    async function approvedTwice(upstreamToolName: string) {
      const tool = tools.find((entry) => entry.upstreamToolName === upstreamToolName)!;
      expect(tool).toBeDefined();
      let actionRequestId = "";
      try { await gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: {} }); }
      catch (error) {
        expect(error).toMatchObject({ reasonCode: "approval_required" });
        actionRequestId = (error as { details: { actionRequestId: string } }).details.actionRequestId;
      }
      expect(actionRequestId).not.toBe("");
      await gateway.approveActionRequest({ companyId: org.id, actionRequestId, actor: { userId: actor.actorId } });
      const first = await gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: {} });
      // A repeat of the approved call is served from storage, not executed again.
      const before = calls.length;
      const second = await gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: {} });
      expect(calls.length).toBe(before);
      return { first, second };
    }

    const write = await approvedTwice("synthetic_create_record");
    expect(JSON.stringify(write.first)).toContain("rec_synthetic_1");
    const storedWrite = JSON.stringify(write.second);
    expect(storedWrite).toContain("rec_synthetic_1");
    expect(storedWrite).not.toContain("[content omitted");

    // Approval executes the action, so the agent's calls after approval are both served from storage.
    expect(write.first).toMatchObject({ status: "replayed" });

    const read = await approvedTwice("synthetic_read");
    // Read-tool content is not persisted, so it cannot come back from storage (accepted LR-2 cost).
    for (const delivered of [read.first, read.second]) {
      expect(delivered).toMatchObject({ status: "replayed", result: expect.stringMatching(/^\[content omitted: \d+ bytes\]$/) });
      expect(JSON.stringify(delivered)).not.toContain(CANARY);
    }
    await expectNoCanary(org.id);
  }, 60_000);

  it("(b) the ask-first test-call status shows a write tool's result; a read stays content-free", async () => {
    const org = await company();
    const { connection, readEntry, writeEntry } = await writeAndReadConnection(org.id);
    const { agent } = await agentWithIssueRun(org.id);
    await toolAccessService(db).finishGalleryAppConnection(org.id, connection.id, {
      enabledCatalogEntryIds: [readEntry.id, writeEntry.id], askFirstCatalogEntryIds: [readEntry.id, writeEntry.id], access: "all_agents",
    }, actor);
    const gateway = createToolGatewayService(db, { toolActionSigningSecret: SIGNING, remoteHttpRequest: upstream([]) });

    async function testCall(toolName: string) {
      const asked = await gateway.executeTestCall({
        companyId: org.id, connectionId: connection.id, agentId: agent.id, userId: actor.actorId, toolName, parameters: {},
      });
      expect(asked.decision).toBe("ask_first");
      await gateway.approveActionRequest({ companyId: org.id, actionRequestId: (asked as { actionRequestId?: string }).actionRequestId!, actor: { userId: actor.actorId } });
      return gateway.getTestCallStatus({ companyId: org.id, connectionId: connection.id, actionRequestId: (asked as { actionRequestId?: string }).actionRequestId! });
    }

    const write = await testCall("synthetic_create_record");
    expect(write.phase).toBe("done");
    expect(JSON.stringify(write.result)).toContain("rec_synthetic_1");
    expect(JSON.stringify(write.result)).not.toContain("[content omitted");

    const read = await testCall("synthetic_read");
    expect(read.phase).toBe("done");
    expect(JSON.stringify(read.result ?? null)).not.toContain(CANARY);
    await expectNoCanary(org.id);
  }, 60_000);

  it("(c) a provider hand-off is recovered after a restart with identifiers only", async () => {
    const org = await company();
    const [allowed] = await db.insert(agents).values({
      companyId: org.id, name: "Synthetic Allowed", role: "engineer", adapterType: "process", adapterConfig: {}, runtimeConfig: {},
    }).returning();
    const tool = (name: string) => ({ name, description: name, inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } });
    const send = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.method === "initialize") return Response.json({ id: body.id, result: { protocolVersion: "2025-06-18" } }, { headers: { "Mcp-Session-Id": "execution-session" } });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/list") return Response.json({ id: body.id, result: { tools: [tool("execute"), tool("resume")] } });
      return Response.json({ id: body.id, result: { structuredContent: body.params.name === "execute"
        ? {
            status: "waiting_for_interaction", executionId: "fixture-execution", expiresAt: "2099-01-01T00:00:00Z",
            interaction: {
              kind: "form", message: `Approve the synthetic step ${CANARY}?`,
              requestedSchema: { type: "object", properties: { answer: { type: "string", description: `Synthetic ${CANARY}` } } },
            },
          }
        : { ok: true }, content: [] } });
    };
    const service = toolAccessService(db, {
      deploymentMode: "local_trusted", deploymentExposure: "private",
      remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }], remoteHttpRequest: send,
    });
    const connection = await service.connectGalleryApp(org.id, { galleryKey: "executor", connectionMethodKey: "mcp", link: "https://executor.sh/test/mcp", authMode: "none" }, actor);
    const ids = Object.fromEntries(connection.catalog.map((entry) => [entry.toolName, entry.id]));
    await service.finishGalleryAppConnection(org.id, connection.connectionId, {
      enabledCatalogEntryIds: [ids.execute, ids.resume], askFirstCatalogEntryIds: [ids.execute], access: { agentIds: [allowed!.id] },
    }, actor);
    const gatewayOptions = { deploymentMode: "local_trusted" as const, deploymentExposure: "private" as const, remoteHttpRequest: send, toolActionSigningSecret: SIGNING };
    const gateway = createToolGatewayService(db, gatewayOptions);
    const asked = await gateway.executeTestCall({
      companyId: org.id, connectionId: connection.connectionId, agentId: allowed!.id, userId: actor.actorId, toolName: "execute", parameters: {},
    });
    expect(asked.decision).toBe("ask_first");
    await gateway.approveActionRequest({ companyId: org.id, actionRequestId: (asked as { actionRequestId?: string }).actionRequestId!, actor: { userId: actor.actorId } });
    const live = await gateway.getTestCallStatus({ companyId: org.id, connectionId: connection.connectionId, actionRequestId: (asked as { actionRequestId?: string }).actionRequestId! });
    expect(live.upstreamPending).toMatchObject({ kind: "approval", executionId: "fixture-execution", resumeTool: "resume" });

    // A restart: a new gateway instance has an empty in-memory hand-off cache.
    const restarted = createToolGatewayService(db, gatewayOptions);
    const recovered = await restarted.getTestCallStatus({ companyId: org.id, connectionId: connection.connectionId, actionRequestId: (asked as { actionRequestId?: string }).actionRequestId! });
    expect(recovered.phase).toBe("done");
    expect(recovered.upstreamPending).toEqual({
      kind: "approval", links: [], executionId: "fixture-execution", resumeTool: "resume", expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const [invocation] = await db.select().from(toolInvocations).where(eq(toolInvocations.id, asked.invocationId));
    expect(invocation!.resultSummary?.summary).toContain("fixture-execution");
    // The upstream message and requested schema are provider free text: never persisted.
    await expectNoCanary(org.id);
  }, 60_000);
});
