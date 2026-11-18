import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, chatConversations, chatDeliveries, chatEndpoints, chatMessageLinks, companies, createDb, heartbeatRuns,
  issueComments, issues, runIdentityContexts, toolApplications, toolConnections,
} from "@paperclipai/db";
import type { ChatProvider } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { chatRunSourceMessageId } from "./run-origin.js";

// BLA-1574: a delegated task (agent A on task X created task Y for agent B) must
// not lose ordinary discovery, and must never inherit chat authority from X.
const INHERITED = "Chat tools cannot be inherited by another task";
const OPTIONS = [
  {},
  { allowLegacyWakeComment: true },
  { allowLegacyWakeComment: true, provider: "github" as const },
  { provider: "slack" as const },
];

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("delegated task chat provenance", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-channel-delegation-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); }, 60_000);

  type Fixture = Awaited<ReturnType<typeof delegation>>;

  /** A's run on X (root context) → B's first run on Y → B's retry on Y. */
  async function delegation() {
    const [company] = await db.insert(companies).values({ name: "Delegation", issuePrefix: randomUUID().slice(0, 8) }).returning();
    const [agentA, agentB] = await db.insert(agents).values([
      { companyId: company.id, name: "Agent A", role: "general", adapterType: "codex_local" },
      { companyId: company.id, name: "Agent B", role: "general", adapterType: "codex_local" },
    ]).returning();
    const [taskX] = await db.insert(issues).values({ companyId: company.id, title: "Task X", assigneeAgentId: agentA.id }).returning();
    const [taskY] = await db.insert(issues).values({ companyId: company.id, title: "Task Y", assigneeAgentId: agentB.id, parentId: taskX.id }).returning();
    const [runA, runB1, runB2] = await db.insert(heartbeatRuns).values([
      { companyId: company.id, agentId: agentA.id, status: "succeeded", nativeIssueId: taskX.id, contextSnapshot: { issueId: taskX.id }, responsibleUserId: "requester" },
      { companyId: company.id, agentId: agentB.id, status: "failed", nativeIssueId: taskY.id, contextSnapshot: { issueId: taskY.id }, responsibleUserId: "requester" },
      { companyId: company.id, agentId: agentB.id, status: "running", nativeIssueId: taskY.id, contextSnapshot: { issueId: taskY.id }, responsibleUserId: "requester" },
    ]).returning();
    const [contextA] = await db.insert(runIdentityContexts).values({ companyId: company.id, runId: runA.id, revision: 1, responsibleUserId: "requester", cause: "instruction", correlationId: "a" }).returning();
    const [contextB1] = await db.insert(runIdentityContexts).values({ companyId: company.id, runId: runB1.id, revision: 1, responsibleUserId: "requester", parentContextId: contextA.id, cause: "assignment", correlationId: "b1" }).returning();
    const [contextB2] = await db.insert(runIdentityContexts).values({ companyId: company.id, runId: runB2.id, revision: 1, responsibleUserId: "requester", parentContextId: contextB1.id, cause: "retry", correlationId: "b2" }).returning();
    const [first] = await db.update(heartbeatRuns).set({ activeIdentityContextId: contextB1.id }).where(eq(heartbeatRuns.id, runB1.id)).returning();
    const [retry] = await db.update(heartbeatRuns).set({ activeIdentityContextId: contextB2.id }).where(eq(heartbeatRuns.id, runB2.id)).returning();
    await db.update(heartbeatRuns).set({ activeIdentityContextId: contextA.id }).where(eq(heartbeatRuns.id, runA.id));
    return { company, agentA, agentB, taskX, taskY, runA, first, retry, contextA, contextB1, contextB2 };
  }

  async function boardComment(f: Fixture, issueId: string, authorUserId = "requester") {
    const [comment] = await db.insert(issueComments).values({ companyId: f.company.id, issueId, authorType: "user", authorUserId, body: "Please delegate this" }).returning();
    return comment.id;
  }

  async function chatMessage(f: Fixture, issueId: string, provider: ChatProvider, guest: boolean, agentId = f.agentA.id) {
    const commentId = await boardComment(f, issueId);
    const [application] = await db.insert(toolApplications).values({ companyId: f.company.id, applicationKey: `chat-${randomUUID().slice(0, 8)}`, name: `Synthetic chat ${randomUUID()}`, type: "mcp_http", status: "active" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId: f.company.id, applicationId: application.id, name: "Synthetic chat bot", uid: `test/${randomUUID()}`, transport: "mcp_remote", status: "active", enabled: true, healthStatus: "ok", credentialPolicy: "shared", config: {} }).returning();
    const [endpoint] = await db.insert(chatEndpoints).values({ companyId: f.company.id, connectionId: connection.id, provider, publicId: randomUUID(), assignedAgentId: agentId }).returning();
    const [conversation] = await db.insert(chatConversations).values({ companyId: f.company.id, endpointId: endpoint.id, issueId, externalConversationId: randomUUID(), externalLabel: "Synthetic thread" }).returning();
    const [delivery] = await db.insert(chatDeliveries).values({
      companyId: f.company.id, endpointId: endpoint.id, providerEventId: randomUUID(), deduplicationKey: randomUUID(), eventKind: "mention",
      normalizedEvent: { githubAuthority: { guest } },
    }).returning();
    await db.insert(chatMessageLinks).values({ companyId: f.company.id, endpointId: endpoint.id, conversationId: conversation.id, deliveryId: delivery.id, commentId, providerMessageId: randomUUID(), direction: "inbound" });
    return commentId;
  }

  async function expectNoChatSource(...runs: Fixture["first"][]) {
    for (const run of runs) for (const options of OPTIONS) expect(await chatRunSourceMessageId(db, run, options)).toBeNull();
  }

  async function expectInheritanceDenied(run: Fixture["first"], message = INHERITED) {
    for (const options of OPTIONS) await expect(chatRunSourceMessageId(db, run, options)).rejects.toMatchObject({ status: 403, message });
  }

  it("treats delegation from a task with no chat provenance as no chat source", async () => {
    const f = await delegation();
    await expectNoChatSource(f.first, f.retry);
  });

  it("allows a delegating context whose accepted message and wake comment are ordinary board comments", async () => {
    const f = await delegation();
    const message = await boardComment(f, f.taskX.id);
    await db.update(runIdentityContexts).set({ messageId: message }).where(eq(runIdentityContexts.id, f.contextA.id));
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.taskX.id, wakeCommentId: message, wakeCommentIds: [message, await boardComment(f, f.taskX.id)] } }).where(eq(heartbeatRuns.id, f.runA.id));
    await expectNoChatSource(f.first, f.retry);
  });

  it("walks the whole foreign chain: A's own retry history without chat is still no chat source", async () => {
    const f = await delegation();
    const [rootRun] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agentA.id, status: "succeeded", nativeIssueId: f.taskX.id, responsibleUserId: "requester", contextSnapshot: { wakeCommentId: await boardComment(f, f.taskX.id) } }).returning();
    const [root] = await db.insert(runIdentityContexts).values({ companyId: f.company.id, runId: rootRun.id, revision: 1, responsibleUserId: "requester", messageId: await boardComment(f, f.taskX.id), cause: "instruction", correlationId: "root" }).returning();
    await db.update(runIdentityContexts).set({ parentContextId: root.id }).where(eq(runIdentityContexts.id, f.contextA.id));
    await expectNoChatSource(f.first, f.retry);
  });

  it.each([
    ["GitHub guest", "github", true],
    ["GitHub sponsor", "github", false],
    ["Slack", "slack", false],
  ] as const)("keeps denying delegation when the delegating context carries a %s chat message", async (_label, provider, guest) => {
    const f = await delegation();
    const message = await chatMessage(f, f.taskX.id, provider, guest);
    await db.update(runIdentityContexts).set({ messageId: message }).where(eq(runIdentityContexts.id, f.contextA.id));
    await expectInheritanceDenied(f.first);
    await expectInheritanceDenied(f.retry);
  });

  it.each(["wakeCommentId", "wakeCommentIds"] as const)("keeps denying when the delegating run's legacy %s is a GitHub guest chat message", async (key) => {
    const f = await delegation();
    const message = await chatMessage(f, f.taskX.id, "github", true);
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.taskX.id, [key]: key === "wakeCommentId" ? message : [await boardComment(f, f.taskX.id), message] } }).where(eq(heartbeatRuns.id, f.runA.id));
    await expectInheritanceDenied(f.retry);
  });

  it("keeps denying when chat provenance sits deeper in the foreign chain", async () => {
    const f = await delegation();
    const [rootRun] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agentA.id, status: "succeeded", nativeIssueId: f.taskX.id, responsibleUserId: "requester" }).returning();
    const [root] = await db.insert(runIdentityContexts).values({ companyId: f.company.id, runId: rootRun.id, revision: 1, responsibleUserId: "requester", messageId: await chatMessage(f, f.taskX.id, "github", true), cause: "instruction", correlationId: "root" }).returning();
    await db.update(runIdentityContexts).set({ parentContextId: root.id }).where(eq(runIdentityContexts.id, f.contextA.id));
    await expectInheritanceDenied(f.retry);
  });

  it("fails closed when a foreign message cannot be resolved or a wake id is malformed", async () => {
    const f = await delegation();
    await db.update(runIdentityContexts).set({ messageId: randomUUID() }).where(eq(runIdentityContexts.id, f.contextA.id));
    await expectInheritanceDenied(f.retry);
    await db.update(runIdentityContexts).set({ messageId: null }).where(eq(runIdentityContexts.id, f.contextA.id));
    for (const wake of ["not-a-uuid", 7, randomUUID()]) {
      await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.taskX.id, wakeCommentId: wake } }).where(eq(heartbeatRuns.id, f.runA.id));
      await expectInheritanceDenied(f.retry);
    }
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.taskX.id, wakeCommentIds: await boardComment(f, f.taskX.id) } }).where(eq(heartbeatRuns.id, f.runA.id));
    await expectInheritanceDenied(f.retry);
    // A chat-linked comment in another company is not readable here, so it is unresolved too.
    const other = await delegation();
    const foreign = await chatMessage(other, other.taskX.id, "github", false);
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.taskX.id, wakeCommentId: foreign } }).where(eq(heartbeatRuns.id, f.runA.id));
    await expectInheritanceDenied(f.retry);
  });

  it("keeps B's own segment result at the delegation boundary instead of dropping it", async () => {
    const f = await delegation();
    const guestOnY = await chatMessage(f, f.taskY.id, "github", true, f.agentB.id);
    const [run] = await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.taskY.id, wakeCommentId: guestOnY } }).where(eq(heartbeatRuns.id, f.retry.id)).returning();
    expect(await chatRunSourceMessageId(db, run, { allowLegacyWakeComment: true, provider: "github" })).toBe(guestOnY);
    expect(await chatRunSourceMessageId(db, run)).toBeNull();
  });

  it.each(["requester", "pending", "missing", "cycle", "company"] as const)("keeps today's denial for a %s break inside the foreign chain", async (fault) => {
    const f = await delegation();
    const [rootRun] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agentA.id, status: "succeeded", nativeIssueId: f.taskX.id, responsibleUserId: "requester" }).returning();
    const [root] = await db.insert(runIdentityContexts).values({ companyId: f.company.id, runId: rootRun.id, revision: 1, responsibleUserId: "requester", cause: "instruction", correlationId: "root" }).returning();
    await db.update(runIdentityContexts).set({ parentContextId: root.id }).where(eq(runIdentityContexts.id, f.contextA.id));
    if (fault === "requester") await db.update(runIdentityContexts).set({ responsibleUserId: "another-person" }).where(eq(runIdentityContexts.id, root.id));
    if (fault === "pending") await db.update(runIdentityContexts).set({ status: "pending" }).where(eq(runIdentityContexts.id, root.id));
    if (fault === "missing") await db.update(runIdentityContexts).set({ parentContextId: randomUUID() }).where(eq(runIdentityContexts.id, f.contextA.id));
    if (fault === "cycle") await db.update(runIdentityContexts).set({ parentContextId: f.contextA.id }).where(eq(runIdentityContexts.id, root.id));
    if (fault === "company") {
      const [other] = await db.insert(companies).values({ name: "Other company", issuePrefix: randomUUID().slice(0, 8) }).returning();
      await db.update(runIdentityContexts).set({ companyId: other.id }).where(eq(runIdentityContexts.id, root.id));
    }
    await expectInheritanceDenied(f.retry);
  });

  it("rejects a cycle that loops back into B's own segment", async () => {
    const f = await delegation();
    await db.update(runIdentityContexts).set({ parentContextId: f.contextB1.id }).where(eq(runIdentityContexts.id, f.contextA.id));
    await expectInheritanceDenied(f.retry);
  });

  it("does not give B another agent's chat authority on the same task, but allows a same-task handoff without chat", async () => {
    const f = await delegation();
    const [runAOnY] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agentA.id, status: "succeeded", nativeIssueId: f.taskY.id, contextSnapshot: { issueId: f.taskY.id }, responsibleUserId: "requester" }).returning();
    await db.update(runIdentityContexts).set({ runId: runAOnY.id }).where(eq(runIdentityContexts.id, f.contextA.id));
    await expectNoChatSource(f.first, f.retry);
    for (const [provider, guest] of [["github", true], ["github", false], ["slack", false]] as const) {
      const message = await chatMessage(f, f.taskY.id, provider, guest);
      await db.update(runIdentityContexts).set({ messageId: message }).where(eq(runIdentityContexts.id, f.contextA.id));
      await expectInheritanceDenied(f.retry);
    }
  });
});
