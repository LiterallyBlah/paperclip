import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, chatConversations, chatDeliveries, chatEndpoints, chatMessageLinks, companies, connectionGrants, createDb,
  heartbeatRuns, issueComments, issues, runIdentityContexts, toolApplications, toolCatalogEntries, toolConnections, toolPolicies,
} from "@paperclipai/db";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// BLA-1574: discovery for a delegated task (A on X created Y for B) must list
// ordinary managed connections, and no chat authority from X may reach B. On v2026.1117.0
// upstream #17340 covers this, so the fork's run-origin change is dropped; these tests stay.
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("tool gateway delegated discovery", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tool-gateway-delegation-");
    db = createDb(tempDb.connectionString);
  }, 30_000);
  afterAll(async () => { await tempDb?.cleanup(); }, 60_000);

  async function connection(companyId: string, name: string, transport: typeof toolConnections.$inferInsert.transport = "mcp_remote") {
    const [application] = await db.insert(toolApplications).values({ companyId, applicationKey: `app-${randomUUID().slice(0, 8)}`, name: `${name} ${randomUUID()}`, type: "mcp_http", status: "active" }).returning();
    const [row] = await db.insert(toolConnections).values({
      companyId, applicationId: application.id, name, uid: `test/${randomUUID()}`, transport, status: "active", enabled: true,
      healthStatus: "ok", credentialPolicy: "shared", config: { url: "https://8.8.8.8/mcp" },
    }).returning();
    return { application, connection: row };
  }

  async function delegation() {
    const [company] = await db.insert(companies).values({ name: `Delegation ${randomUUID()}`, issuePrefix: `DG${randomUUID().slice(0, 6).toUpperCase()}` }).returning();
    const [agentA, agentB] = await db.insert(agents).values([
      { companyId: company.id, name: `Agent A ${randomUUID()}`, role: "engineer", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { companyId: company.id, name: `Agent B ${randomUUID()}`, role: "engineer", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]).returning();
    const [taskX] = await db.insert(issues).values({ companyId: company.id, title: "Task X", status: "in_progress", assigneeAgentId: agentA.id }).returning();
    const [taskY] = await db.insert(issues).values({ companyId: company.id, title: "Task Y", status: "in_progress", assigneeAgentId: agentB.id, parentId: taskX.id }).returning();
    const [runA, runB1, runB2] = await db.insert(heartbeatRuns).values([
      { companyId: company.id, agentId: agentA.id, invocationSource: "assignment", status: "succeeded", nativeIssueId: taskX.id, contextSnapshot: { issueId: taskX.id }, responsibleUserId: "requester" },
      { companyId: company.id, agentId: agentB.id, invocationSource: "assignment", status: "failed", nativeIssueId: taskY.id, contextSnapshot: { issueId: taskY.id }, responsibleUserId: "requester" },
      { companyId: company.id, agentId: agentB.id, invocationSource: "assignment", status: "running", nativeIssueId: taskY.id, contextSnapshot: { issueId: taskY.id }, responsibleUserId: "requester" },
    ]).returning();
    const [contextA] = await db.insert(runIdentityContexts).values({ companyId: company.id, runId: runA.id, revision: 1, responsibleUserId: "requester", cause: "instruction", correlationId: "a" }).returning();
    const [contextB1] = await db.insert(runIdentityContexts).values({ companyId: company.id, runId: runB1.id, revision: 1, responsibleUserId: "requester", parentContextId: contextA.id, cause: "assignment", correlationId: "b1" }).returning();
    const [contextB2] = await db.insert(runIdentityContexts).values({ companyId: company.id, runId: runB2.id, revision: 1, responsibleUserId: "requester", parentContextId: contextB1.id, cause: "retry", correlationId: "b2" }).returning();
    await db.update(heartbeatRuns).set({ activeIdentityContextId: contextA.id }).where(eq(heartbeatRuns.id, runA.id));
    await db.update(heartbeatRuns).set({ activeIdentityContextId: contextB1.id }).where(eq(heartbeatRuns.id, runB1.id));
    await db.update(heartbeatRuns).set({ activeIdentityContextId: contextB2.id }).where(eq(heartbeatRuns.id, runB2.id));

    // An ordinary, organisation-granted managed connection that B may use on Y.
    const managed = await connection(company.id, "Managed notes");
    await db.insert(connectionGrants).values({ companyId: company.id, connectionId: managed.connection.id, kind: "organization", credentialSecretRefs: [], status: "active", isDefault: true });
    await db.insert(toolCatalogEntries).values({
      companyId: company.id, applicationId: managed.application.id, connectionId: managed.connection.id, entryKind: "tool", name: "list_notes",
      toolName: "list_notes", title: "List notes", riskLevel: "read", isReadOnly: true, status: "active", versionHash: randomUUID(), schemaHash: randomUUID(),
    });
    await db.insert(toolPolicies).values({ companyId: company.id, name: "Allow reads", policyType: "allow", selectors: { riskLevel: "read" } });

    // A's GitHub chat bot on X. Its conversation is X's; nothing of it may reach B.
    const bot = await connection(company.id, "A's GitHub bot", "rest_api");
    const [endpoint] = await db.insert(chatEndpoints).values({ companyId: company.id, connectionId: bot.connection.id, provider: "github", publicId: randomUUID(), assignedAgentId: agentA.id, status: "active" }).returning();
    const [conversation] = await db.insert(chatConversations).values({ companyId: company.id, endpointId: endpoint.id, issueId: taskX.id, externalConversationId: randomUUID(), externalLabel: "Synthetic PR thread" }).returning();
    return { company, agentA, agentB, taskX, taskY, runB2, contextA, managed, endpoint, conversation };
  }

  async function guestMessageOnX(f: Awaited<ReturnType<typeof delegation>>) {
    const [comment] = await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.taskX.id, authorType: "user", authorUserId: "requester", body: "@bot please delegate" }).returning();
    const [delivery] = await db.insert(chatDeliveries).values({
      companyId: f.company.id, endpointId: f.endpoint.id, providerEventId: randomUUID(), deduplicationKey: randomUUID(), eventKind: "mention",
      normalizedEvent: { githubAuthority: { guest: true } },
    }).returning();
    await db.insert(chatMessageLinks).values({ companyId: f.company.id, endpointId: f.endpoint.id, conversationId: f.conversation.id, deliveryId: delivery.id, commentId: comment.id, providerMessageId: randomUUID(), direction: "inbound" });
    return comment.id;
  }

  function gateway() {
    return createToolGatewayService(db, {
      toolActionSigningSecret: "test-tool-action-signing-secret",
      remoteHttpRequest: async () => { throw new Error("discovery must not call providers"); },
    });
  }

  it("lists ordinary managed connections for B's retry on the delegated task, and no chat bot tool from X", async () => {
    const f = await delegation();
    const service = gateway();
    const session = await service.createSession({ companyId: f.company.id, agentId: f.agentB.id, runId: f.runB2.id });
    expect(session.issueId).toBe(f.taskY.id);
    const tools = await service.listToolsForSession(session.token);
    expect(tools.some(tool => tool.connectionId === f.managed.connection.id)).toBe(true);
    expect(tools.filter(tool => /github|slack|speko/i.test(String(tool.providerType)) && tool.connectionId)).toEqual([]);
    expect(tools.some(tool => tool.connectionId === f.endpoint.connectionId)).toBe(false);
  });

  // On v2026.1117.0 the guest refusal is scoped to the session's own task (upstream #17340,
  // ee29e2850): a guest request on X confers nothing on Y, and B on Y gets no chat tool from X.
  it("gives B no chat tool and no guest authority from a GitHub guest request on X", async () => {
    const f = await delegation();
    const message = await guestMessageOnX(f);
    await db.update(runIdentityContexts).set({ messageId: message }).where(eq(runIdentityContexts.id, f.contextA.id));
    const service = gateway();
    const session = await service.createSession({ companyId: f.company.id, agentId: f.agentB.id, runId: f.runB2.id });
    const tools = await service.listToolsForSession(session.token);
    expect(tools.some(tool => tool.connectionId === f.endpoint.connectionId)).toBe(false);
    expect(tools.filter(tool => /github|slack|speko/i.test(String(tool.providerType)) && tool.connectionId)).toEqual([]);
  });

  it("refuses discovery with a 403 when Y itself is GitHub-guest-sponsored and B's chain continues A's task", async () => {
    const f = await delegation();
    const bot = await connection(f.company.id, "B's GitHub bot", "rest_api");
    const [endpoint] = await db.insert(chatEndpoints).values({ companyId: f.company.id, connectionId: bot.connection.id, provider: "github", publicId: randomUUID(), assignedAgentId: f.agentB.id, status: "active" }).returning();
    const [conversation] = await db.insert(chatConversations).values({ companyId: f.company.id, endpointId: endpoint.id, issueId: f.taskY.id, externalConversationId: randomUUID(), externalLabel: "Synthetic guest thread on Y" }).returning();
    const [comment] = await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.taskY.id, authorType: "user", authorUserId: "requester", body: "@bot please review" }).returning();
    const [delivery] = await db.insert(chatDeliveries).values({
      companyId: f.company.id, endpointId: endpoint.id, providerEventId: randomUUID(), deduplicationKey: randomUUID(), eventKind: "mention",
      normalizedEvent: { githubAuthority: { guest: true } },
    }).returning();
    await db.insert(chatMessageLinks).values({ companyId: f.company.id, endpointId: endpoint.id, conversationId: conversation.id, deliveryId: delivery.id, commentId: comment.id, providerMessageId: randomUUID(), direction: "inbound" });
    const service = gateway();
    const session = await service.createSession({ companyId: f.company.id, agentId: f.agentB.id, runId: f.runB2.id });
    await expect(service.listToolsForSession(session.token)).rejects.toMatchObject({ status: 403, message: "Chat tools cannot be inherited by another task" });
  });
});
