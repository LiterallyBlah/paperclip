import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  companySecretProposals,
  companySecrets,
  connectionGrants,
  createDb,
  heartbeatRuns,
  issueComments,
  issueThreadInteractions,
  issues,
  toolAccessAuditEvents,
  toolActionRequests,
  toolApplications,
  toolCallEvents,
  toolCatalogEntries,
  toolConnections,
  toolInvocations,
  toolPolicies,
  toolStdioCommandTemplates,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { LOW_TRUST_REVIEW_PRESET, PROMPT_INJECTION_DEFAULT_MODEL } from "@paperclipai/shared";
import { providerUsageReceipt } from "../services/provider-usage.js";
import type { AuthorizationActor } from "../services/authorization.js";

const SENTINEL = "cfat_SYNTHETIC_SENTINEL_0123456789abcdef";

const hoisted = vi.hoisted(() => ({
  proposalFailure: { enabled: false },
  spawnArgs: [] as unknown[][],
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: ((...args: unknown[]) => {
      hoisted.spawnArgs.push(args);
      return (actual.spawn as (...inner: unknown[]) => unknown)(...args);
    }) as typeof actual.spawn,
  };
});

vi.mock("../services/secret-proposals.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/secret-proposals.js")>();
  return {
    ...actual,
    createSecretProposalsService: (db: Parameters<typeof actual.createSecretProposalsService>[0]) => {
      const service = actual.createSecretProposalsService(db);
      return {
        ...service,
        createSecret: async (...args: Parameters<typeof service.createSecret>) => {
          // The thrown message carries the value to prove it never surfaces.
          if (hoisted.proposalFailure.enabled) throw new Error(`proposal store down for ${args[1].value}`);
          return service.createSecret(...args);
        },
      };
    },
  };
});

const { createToolGatewayService, ToolGatewayHttpError } = await import("../services/tool-gateway.js");
const { toolGatewayRoutes } = await import("../routes/tool-gateway.js");
const { secretRoutes } = await import("../routes/secrets.js");
const { errorHandler } = await import("../middleware/error-handler.js");
const { logger } = await import("../middleware/logger.js");
const { aiConnectionService } = await import("../services/ai-connections.js");
const { promptInjectionPreventionService } = await import("../services/prompt-injection-prevention.js");
const { createRunSecretRedactionRegistry } = await import("../services/run-secret-redaction.js");
const { getSecretProvider } = await import("../secrets/provider-registry.js");
const { parseSecretCaptureDirective, scrubCapturedValue, extractCapturedValue } = await import("../services/tool-gateway-secret-capture.js");

type Db = ReturnType<typeof createDb>;
let db: Db;
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let home: string;

const safeVerdict = {
  verdict: { violation: false, findings: [] },
  receipt: { ...providerUsageReceipt(), inputTokens: 10, outputTokens: 1, costStatus: "reported", costCents: "0.0000100", pricingProvenance: { source: "provider_reported" } },
};

const logCalls: unknown[][] = [];

beforeAll(async () => {
  home = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-secret-capture-")));
  vi.stubEnv("PAPERCLIP_HOME", home);
  database = await startEmbeddedPostgresTestDatabase("paperclip-secret-capture-db-");
  db = createDb(database.connectionString);
  for (const level of ["trace", "debug", "info", "warn", "error", "fatal"] as const) {
    const original = logger[level].bind(logger);
    vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
      logCalls.push(args);
      return (original as (...inner: unknown[]) => void)(...args);
    }) as never);
  }
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[level].bind(console);
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logCalls.push(args);
      original(...args);
    });
  }
}, 90_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await database?.cleanup();
  vi.unstubAllEnvs();
  if (home) await rm(home, { recursive: true, force: true });
});

beforeEach(() => {
  hoisted.proposalFailure.enabled = false;
  hoisted.spawnArgs.length = 0;
  logCalls.length = 0;
});

afterEach(() => {
  hoisted.proposalFailure.enabled = false;
});

function cloudflareTokenText(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    success: true,
    result: {
      id: "tok_id_synthetic_1",
      name: "cmo-zone-analytics-read",
      status: "active",
      value: SENTINEL,
      count: 3,
      empty: "",
      // A duplicate occurrence that must be scrubbed too.
      note: `Store ${SENTINEL} now; it is shown once.`,
      ...overrides,
    },
  });
}

const directive = (overrides: Record<string, unknown> = {}) => ({
  pointer: "/result/value",
  proposal: {
    name: "cloudflare/cmo-analytics-token",
    key: "cloudflare-cmo-analytics-token",
    description: "Zone Analytics Read for one zone",
    justification: "CMO read-only analytics (BLA-4049 test)",
  },
  ...overrides,
});

const standardActor = (f: { company: { id: string }; agent: { id: string }; run: { id: string } }): AuthorizationActor => ({
  type: "agent",
  agentId: f.agent.id,
  companyId: f.company.id,
  runId: f.run.id,
  source: "agent_jwt",
  keyScope: { kind: "standard" },
});

async function createCompanyFixture(permissions: Record<string, unknown> = {}) {
  const company = await db.insert(companies).values({
    name: `Capture ${randomUUID()}`,
    issuePrefix: `SC${randomUUID().slice(0, 6).toUpperCase()}`,
  }).returning().then((rows) => rows[0]!);
  await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: "alice", membershipRole: "owner", status: "active" });
  const agent = await db.insert(agents).values({
    companyId: company.id,
    name: `Capture Agent ${randomUUID()}`,
    role: "engineer",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    permissions,
  }).returning().then((rows) => rows[0]!);
  const issue = await db.insert(issues).values({
    companyId: company.id,
    title: "Capture work",
    status: "in_progress",
    assigneeAgentId: agent.id,
  }).returning().then((rows) => rows[0]!);
  const run = await db.insert(heartbeatRuns).values({
    companyId: company.id,
    agentId: agent.id,
    invocationSource: "assignment",
    status: "running",
    contextSnapshot: { issueId: issue.id },
  }).returning().then((rows) => rows[0]!);
  await db.update(issues).set({ executionRunId: run.id, checkoutRunId: run.id }).where(eq(issues.id, issue.id));
  return { company, agent, issue, run };
}

async function createRemoteTool(companyId: string) {
  const application = await db.insert(toolApplications).values({
    companyId, applicationKey: `cf-${randomUUID().slice(0, 8)}`, name: "Cloudflare (synthetic)", type: "mcp_http", status: "active",
  }).returning().then((rows) => rows[0]!);
  const connection = await db.insert(toolConnections).values({
    companyId, applicationId: application.id, name: "Cloudflare synthetic", uid: `test/${randomUUID()}`,
    transport: "mcp_remote", status: "active", enabled: true, healthStatus: "ok", credentialPolicy: "shared",
    config: { url: "https://8.8.8.8/mcp" },
  }).returning().then((rows) => rows[0]!);
  await db.insert(connectionGrants).values({
    companyId, connectionId: connection.id, kind: "organization", credentialSecretRefs: [], status: "active", isDefault: true,
  });
  await db.insert(toolCatalogEntries).values({
    companyId, applicationId: application.id, connectionId: connection.id, entryKind: "tool", name: "execute", toolName: "execute",
    title: "Execute", riskLevel: "write", isWrite: true, status: "active", versionHash: randomUUID(), schemaHash: randomUUID(),
  });
  await db.insert(toolPolicies).values({ companyId, name: "Allow capture fixture", policyType: "allow", priority: 500, selectors: { connectionId: connection.id } });
  return { application, connection };
}

async function createStdioTool(companyId: string) {
  const application = await db.insert(toolApplications).values({
    companyId, applicationKey: `stdio-${randomUUID().slice(0, 8)}`, name: "Stdio (synthetic)", type: "mcp_stdio", status: "active",
  }).returning().then((rows) => rows[0]!);
  const templateKey = `test.capture-stdio.${randomUUID()}`;
  // The child assembles the value at run time, so its argv never carries it.
  const encoded = Buffer.from(cloudflareTokenText()).toString("base64");
  const script = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const text = Buffer.from(${JSON.stringify(encoded)}, "base64").toString("utf8");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "capture-stdio", version: "0.0.0" } } }) + "\\n");
    return;
  }
  if (message.method === "tools/call") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text }] } }) + "\\n");
  }
});
`;
  await db.insert(toolStdioCommandTemplates).values({
    companyId, templateKey, name: `Capture stdio ${randomUUID()}`, command: process.execPath, args: ["-e", script], envKeys: [],
    tools: [{ name: "execute", title: "Execute", description: "Call execute", inputSchema: { type: "object", properties: { code: { type: "string" } }, additionalProperties: false } }],
  });
  const connection = await db.insert(toolConnections).values({
    companyId, applicationId: application.id, name: "Stdio synthetic", uid: `test/${randomUUID()}`, transport: "local_stdio",
    status: "active", enabled: true, healthStatus: "ok", credentialPolicy: "shared",
    config: { templateId: templateKey }, transportConfig: { templateId: templateKey }, credentialSecretRefs: [],
  }).returning().then((rows) => rows[0]!);
  await db.insert(connectionGrants).values({
    companyId, connectionId: connection.id, kind: "organization", credentialSecretRefs: [], status: "active", isDefault: true,
  });
  await db.insert(toolCatalogEntries).values({
    companyId, applicationId: application.id, connectionId: connection.id, entryKind: "tool", name: `execute-${randomUUID()}`, toolName: "execute",
    title: "Execute", inputSchema: { type: "object", properties: { code: { type: "string" } }, additionalProperties: false },
    riskLevel: "write", isWrite: true, status: "active", versionHash: randomUUID(), schemaHash: randomUUID(),
  });
  await db.insert(toolPolicies).values({ companyId, name: "Allow stdio fixture", policyType: "allow", priority: 500, selectors: { connectionId: connection.id } });
  return { application, connection, templateKey };
}

type ProviderReply = { result?: unknown; error?: unknown; status?: number; extra?: Record<string, unknown>; sse?: (id: unknown) => string };

async function fixture(options: { permissions?: Record<string, unknown>; reply?: () => ProviderReply } = {}) {
  const f = await createCompanyFixture(options.permissions);
  const binding = await aiConnectionService(db).save(f.company.id, "alice", {
    provider: "openrouter", method: "api_key", name: "Classifier", ownership: "shared", apiKey: "fixture-key", agentIds: [], allAgents: true,
  }, "fixture-key");
  await promptInjectionPreventionService(db).configure(f.company.id, "alice", { ...binding, enabled: true, model: PROMPT_INJECTION_DEFAULT_MODEL });
  const classifier = vi.fn().mockResolvedValue(safeVerdict);
  const remote = await createRemoteTool(f.company.id);
  const upstreamBodies: string[] = [];
  let reply = options.reply ?? (() => ({ result: { content: [{ type: "text", text: cloudflareTokenText() }], structuredContent: JSON.parse(cloudflareTokenText()) } }));
  const remoteHttpRequest = vi.fn(async (_url: string, init: RequestInit) => {
    const body = String(init.body);
    upstreamBodies.push(body);
    const message = JSON.parse(body);
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (message.method === "initialize") {
      return Response.json({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } });
    }
    // A client reply to a server request (for example an elicitation cancel).
    if (message.method === undefined) return new Response(null, { status: 202 });
    const next: ProviderReply = reply();
    if (next.status && next.status >= 400) return new Response(`upstream failure ${SENTINEL}`, { status: next.status });
    if (next.sse) return new Response(next.sse(message.id), { headers: { "content-type": "text/event-stream" } });
    return Response.json({ jsonrpc: "2.0", id: message.id, ...(next.error ? { error: next.error } : { result: next.result }), ...next.extra });
  });
  const gateway = createToolGatewayService(db, { promptInjectionProvider: classifier, remoteHttpRequest, toolActionSigningSecret: "capture-signing" });
  const session = await gateway.createSession({ companyId: f.company.id, agentId: f.agent.id, runId: f.run.id });
  const tool = (await gateway.listToolsForSession(session.token)).find((t) => t.connectionId === remote.connection.id)!;
  expect(tool).toBeTruthy();
  return {
    ...f, remote, classifier, remoteHttpRequest, upstreamBodies, gateway, session, tool,
    setReply: (next: () => ProviderReply) => { reply = next; },
  };
}

/** Every sink the issue names, serialized for one company. */
async function sinkDump(companyId: string, extra: unknown[] = []) {
  const [invocations, events, audit, activity, interactions, comments, proposals, runs, secrets] = await Promise.all([
    db.select().from(toolInvocations).where(eq(toolInvocations.companyId, companyId)),
    db.select().from(toolCallEvents).where(eq(toolCallEvents.companyId, companyId)),
    db.select().from(toolAccessAuditEvents).where(eq(toolAccessAuditEvents.companyId, companyId)),
    db.select().from(activityLog).where(eq(activityLog.companyId, companyId)),
    db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.companyId, companyId)),
    db.select().from(issueComments).where(eq(issueComments.companyId, companyId)),
    db.select().from(companySecretProposals).where(eq(companySecretProposals.companyId, companyId)),
    db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)),
    db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId)),
  ]);
  return {
    invocations, events, audit, activity, interactions, comments, proposals, runs, secrets,
    text: JSON.stringify({ invocations, events, audit, activity, interactions, comments, proposals, runs, secrets, extra }),
  };
}

function expectSentinelAbsent(label: string, value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  expect(text.includes(SENTINEL), `${label} must not contain the captured value`).toBe(false);
}

async function expectNoLeak(f: Awaited<ReturnType<typeof fixture>>, response: unknown) {
  expectSentinelAbsent("response", response);
  const dump = await sinkDump(f.company.id);
  expectSentinelAbsent("tool_invocations", dump.invocations);
  expectSentinelAbsent("tool_call_events", dump.events);
  expectSentinelAbsent("tool_access_audit_events", dump.audit);
  expectSentinelAbsent("activity_log", dump.activity);
  expectSentinelAbsent("issue_thread_interactions", dump.interactions);
  expectSentinelAbsent("issue_comments", dump.comments);
  expectSentinelAbsent("company_secret_proposals", dump.proposals);
  expectSentinelAbsent("heartbeat_runs", dump.runs);
  expectSentinelAbsent("classifier input", f.classifier.mock.calls);
  expectSentinelAbsent("server logger output", logCalls.map((call) => call.map((part) => part instanceof Error ? `${part.message} ${part.stack}` : part)));
  for (const body of f.upstreamBodies) expectSentinelAbsent("arguments sent upstream", body);
  for (const body of f.upstreamBodies) expect(body.includes("secretCapture") || body.includes("/result/value")).toBe(false);
  return dump;
}

describe("secret capture directive helpers", () => {
  it("parses a directive and rejects unknown or malformed fields", () => {
    expect(parseSecretCaptureDirective(directive())).toMatchObject({ pointer: "/result/value", source: "contentText", contentIndex: 0 });
    for (const bad of [
      null, "x", { ...directive(), pointer: "result/value" }, { ...directive(), extra: true },
      { ...directive(), proposal: { name: "bad name", justification: "x" } },
      { ...directive(), proposal: { name: "ok/name" } },
      { ...directive(), source: "headers" }, { ...directive(), contentIndex: -1 },
      { ...directive(), pointer: "/a/~2" },
    ]) {
      expect(() => parseSecretCaptureDirective(bad)).toThrow("Secret capture failed");
    }
  });

  it("scrubs literal and JSON-escaped occurrences and proves the value is gone", () => {
    const tricky = 'tok"en\\with-escapes-0123';
    const result = { content: JSON.stringify({ v: tricky }), data: { structuredContent: { v: tricky, [tricky]: 1 } } };
    const scrubbed = scrubCapturedValue(result, tricky, "[m]");
    expect(JSON.stringify(scrubbed)).not.toContain(JSON.stringify(tricky).slice(1, -1));
    expect(JSON.stringify(scrubbed)).not.toContain(tricky);
    expect(extractCapturedValue({ content: JSON.stringify({ a: [{ b: SENTINEL }] }), data: {} }, parseSecretCaptureDirective({ ...directive(), pointer: "/a/0/b" }))).toBe(SENTINEL);
  });
});

describe("tool gateway secret capture", () => {
  it("captures the value into a pending encrypted proposal and returns only the marker", async () => {
    const f = await fixture();
    const result = await f.gateway.executeTool({
      sessionToken: f.session.token, tool: f.tool.name, parameters: { code: "mint scoped token" },
      secretCapture: { directive: directive(), actor: standardActor(f) },
    });
    expect(result.status).toBe("completed");
    const proposalId = (result as { secretProposal?: { id: string } }).secretProposal?.id;
    expect(proposalId).toEqual(expect.any(String));
    const marker = `[paperclip-secret-proposal:${proposalId}]`;
    const serialized = JSON.stringify(result);
    expect(serialized).toContain(marker);
    expect(serialized).toContain("tok_id_synthetic_1");
    // The pointer location, the duplicate in `note` and structuredContent are all scrubbed.
    expect(serialized.split(marker).length - 1).toBeGreaterThanOrEqual(4);

    const dump = await expectNoLeak(f, result);
    expect(dump.proposals).toHaveLength(1);
    const [proposal] = dump.proposals;
    expect(proposal).toMatchObject({
      id: proposalId, kind: "secret", status: "pending", proposedName: "cloudflare/cmo-analytics-token",
      proposedKey: "cloudflare-cmo-analytics-token", proposedByAgentId: f.agent.id, originRunId: f.run.id, originIssueId: f.issue.id,
    });
    await expect(getSecretProvider("local_encrypted").resolveVersion({ material: proposal.valueCiphertext as never, externalRef: null })).resolves.toBe(SENTINEL);
    // Only the classifier fixture's own secret exists: capture created no company secret.
    expect(dump.secrets.filter((row) => row.key === "cloudflare-cmo-analytics-token")).toHaveLength(0);
    // A bare secret proposal has no card of its own: board admins resolve it
    // in Secrets > Proposals, exactly as for /agents/me/secret-proposals.
    expect(dump.activity.some((row) => row.action === "secret.proposal.created" && row.entityId === proposalId)).toBe(true);
    // Registered for run redaction.
    await expect(createRunSecretRedactionRegistry(db).redactForRun(f.company.id, f.run.id, `x ${SENTINEL} y`)).resolves.not.toContain(SENTINEL);
    // The normal pipeline still ran on the scrubbed content.
    expect(f.classifier).toHaveBeenCalled();
    const [invocation] = dump.invocations;
    expect(invocation).toMatchObject({ status: "succeeded" });
    expect(JSON.stringify(invocation.resultSummary)).toContain(marker);
    const completedAudit = dump.audit.find((row) => row.action === "call_completed");
    expect(completedAudit?.details).toMatchObject({ secretCapture: { pointer: "/result/value", proposalName: "cloudflare/cmo-analytics-token", proposalKey: "cloudflare-cmo-analytics-token", proposalId } });
  });

  it("captures from structuredContent", async () => {
    const f = await fixture({ reply: () => ({ result: { content: [{ type: "text", text: "minted" }], structuredContent: JSON.parse(cloudflareTokenText()) } }) });
    const result = await f.gateway.executeTool({
      sessionToken: f.session.token, tool: f.tool.name, parameters: { code: "mint" },
      secretCapture: { directive: directive({ source: "structuredContent" }), actor: standardActor(f) },
    });
    expect(result.status).toBe("completed");
    await expectNoLeak(f, result);
  });

  const failCases: Array<{ name: string; reason: string; directive?: Record<string, unknown>; reply?: () => ProviderReply; proposalFailure?: boolean }> = [
    { name: "pointer not found", reason: "pointer_not_found", directive: { pointer: "/result/missing" } },
    { name: "content index missing", reason: "pointer_not_found", directive: { contentIndex: 3 } },
    { name: "non-string value", reason: "value_not_string", directive: { pointer: "/result/count" } },
    { name: "empty value", reason: "value_empty", directive: { pointer: "/result/empty" } },
    { name: "JSON parse failure", reason: "json_parse_failed", reply: () => ({ result: { content: [{ type: "text", text: `token=${SENTINEL}` }] } }) },
    { name: "value over the size limit", reason: "value_too_large", reply: () => ({ result: { content: [{ type: "text", text: cloudflareTokenText({ value: SENTINEL.repeat(200) }) }] } }) },
    { name: "provider error result", reason: "provider_error", reply: () => ({ result: { content: [{ type: "text", text: `failed after minting ${SENTINEL}` }], isError: true } }) },
    { name: "provider JSON-RPC error", reason: "provider_error", reply: () => ({ error: { code: -32000, message: `boom ${SENTINEL}` } }) },
    { name: "provider HTTP error", reason: "provider_error", reply: () => ({ status: 500 }) },
    { name: "proposal creation failure", reason: "proposal_failed", proposalFailure: true },
  ];

  for (const testCase of failCases) {
    it(`fails closed without content: ${testCase.name}`, async () => {
      const f = await fixture(testCase.reply ? { reply: testCase.reply } : {});
      hoisted.proposalFailure.enabled = Boolean(testCase.proposalFailure);
      let caught: unknown;
      try {
        await f.gateway.executeTool({
          sessionToken: f.session.token, tool: f.tool.name, parameters: { code: "mint" },
          secretCapture: { directive: directive(testCase.directive), actor: standardActor(f) },
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ToolGatewayHttpError);
      const error = caught as InstanceType<typeof ToolGatewayHttpError>;
      expect(error.reasonCode).toBe("secret_capture_failed");
      expect(error.details.captureReason).toBe(testCase.reason);
      expectSentinelAbsent("error message", error.message);
      expectSentinelAbsent("error details", error.details);
      const dump = await expectNoLeak(f, { message: error.message, details: error.details });
      expect(f.classifier).not.toHaveBeenCalled();
      expect(dump.proposals).toHaveLength(0);
      const [invocation] = dump.invocations;
      expect(invocation).toMatchObject({ status: "failed", errorCode: "secret_capture_failed", resultSummary: null, resultHash: null });
      expect(dump.audit.some((row) => row.action === "call_failed" && (row.details as { secretCapture?: { captureReason?: string } }).secretCapture?.captureReason === testCase.reason)).toBe(true);
    });
  }

  // Provider interactions are refused in capture mode before anything records
  // them (issue interactions, call events, retained handoff summaries).
  const tokenResult = () => ({ content: [{ type: "text", text: cloudflareTokenText() }] });
  const formElicitation = { message: `Confirm ${SENTINEL}`, requestedSchema: { type: "object", properties: { answer: { type: "string", description: SENTINEL } } } };
  const sseEvent = (message: unknown) => `event: message\ndata: ${JSON.stringify(message)}\n\n`;
  const interactionCases: Array<{ name: string; reply: () => ProviderReply }> = [
    { name: "result elicitation", reply: () => ({ result: { ...tokenResult(), elicitation: formElicitation } }) },
    { name: "result _meta elicitation", reply: () => ({ result: { ...tokenResult(), _meta: { elicitation: formElicitation } } }) },
    { name: "top-level elicitation", reply: () => ({ result: tokenResult(), extra: { elicitation: formElicitation } }) },
    { name: "streamed elicitation request", reply: () => ({ sse: (id) =>
      sseEvent({ jsonrpc: "2.0", id: "elicit-1", method: "elicitation/create", params: formElicitation })
      + sseEvent({ jsonrpc: "2.0", id, result: tokenResult() }) }) },
    { name: "upstream authorization handoff", reply: () => ({ error: { code: -32042, message: `Authorize ${SENTINEL}`, data: { elicitations: [
      { mode: "url", elicitationId: `elic-${SENTINEL}`, url: `https://dash.cloudflare.com/oauth?code=${SENTINEL}`, message: SENTINEL },
    ] } } }) },
    { name: "streamed upstream handoff", reply: () => ({ sse: (id) =>
      sseEvent({ jsonrpc: "2.0", id: "elicit-2", method: "elicitation/create", params: {
        mode: "url", elicitationId: `elic-${SENTINEL}`, url: `https://dash.cloudflare.com/oauth?code=${SENTINEL}`, message: SENTINEL } })
      + sseEvent({ jsonrpc: "2.0", id, result: tokenResult() }) }) },
  ];

  for (const testCase of interactionCases) {
    it(`refuses a provider interaction before it is recorded: ${testCase.name}`, async () => {
      const f = await fixture({ reply: testCase.reply });
      let caught: unknown;
      try {
        await f.gateway.executeTool({
          sessionToken: f.session.token, tool: f.tool.name, parameters: { code: "mint" },
          secretCapture: { directive: directive(), actor: standardActor(f) },
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ToolGatewayHttpError);
      const error = caught as InstanceType<typeof ToolGatewayHttpError>;
      expect(error.reasonCode).toBe("secret_capture_failed");
      expect(error.details).toEqual({ captureReason: "provider_error", upstreamReasonCode: "secret_capture_interaction_refused" });
      const dump = await expectNoLeak(f, { message: error.message, details: error.details });
      expect(f.classifier).not.toHaveBeenCalled();
      expect(dump.proposals).toHaveLength(0);
      expect(dump.interactions).toHaveLength(0);
      expect(dump.events.some((row) => /elicitation|provider_interaction/.test(JSON.stringify(row)))).toBe(false);
      const [invocation] = dump.invocations;
      expect(invocation).toMatchObject({ status: "failed", errorCode: "secret_capture_failed", resultSummary: null, resultHash: null });
    });
  }

  it("still records an elicitation for an ordinary call without a directive", async () => {
    const f = await fixture({ reply: () => ({ result: { content: [{ type: "text", text: "ok" }], elicitation: { message: "Pick one", requestedSchema: { type: "object", properties: { answer: { type: "string" } } } } } }) });
    const issueSession = await f.gateway.createSession({ companyId: f.company.id, agentId: f.agent.id, runId: f.run.id, issueId: f.issue.id });
    await expect(f.gateway.executeTool({ sessionToken: issueSession.token, tool: f.tool.name, parameters: { code: "plain" } }))
      .rejects.toMatchObject({ reasonCode: "elicitation_required" });
    const dump = await sinkDump(f.company.id);
    expect(dump.interactions).toHaveLength(1);
  });

  it("keeps the stdio child argv free of the value", async () => {
    const f = await createCompanyFixture();
    const stdio = await createStdioTool(f.company.id);
    const classifier = vi.fn().mockResolvedValue(safeVerdict);
    const gateway = createToolGatewayService(db, { promptInjectionProvider: classifier, toolActionSigningSecret: "capture-signing", runtimeSupervisor: { idleTtlMs: 5_000 } });
    const session = await gateway.createSession({ companyId: f.company.id, agentId: f.agent.id, runId: f.run.id });
    const tool = (await gateway.listToolsForSession(session.token)).find((t) => t.connectionId === stdio.connection.id)!;
    const result = await gateway.executeTool({
      sessionToken: session.token, tool: tool.name, parameters: { code: "mint" },
      secretCapture: { directive: directive(), actor: standardActor(f) },
    });
    expect(result).toMatchObject({ status: "completed", result: { data: { spawnedLocalProcess: true } } });
    expect(hoisted.spawnArgs.length).toBeGreaterThan(0);
    expectSentinelAbsent("child-process argv", hoisted.spawnArgs);
    expectSentinelAbsent("response", result);
    const dump = await sinkDump(f.company.id);
    expectSentinelAbsent("stdio sinks", dump.text);
    expect(dump.proposals).toEqual([expect.objectContaining({ status: "pending" })]);
  });

  it("refuses capture for an agent that cannot call the tool, before the provider runs", async () => {
    const f = await fixture();
    await db.insert(toolPolicies).values({ companyId: f.company.id, name: "Block", policyType: "block", priority: 1, selectors: { connectionId: f.remote.connection.id } });
    await expect(f.gateway.executeTool({
      sessionToken: f.session.token, tool: f.tool.name, parameters: { code: "mint" },
      secretCapture: { directive: directive(), actor: standardActor(f) },
    })).rejects.toMatchObject({ status: 403 });
    expect(f.upstreamBodies.some((body) => JSON.parse(body).method === "tools/call")).toBe(false);
    expect((await sinkDump(f.company.id)).proposals).toHaveLength(0);
  });

  it("refuses capture when the tool would need per-call approval", async () => {
    const f = await fixture();
    await db.insert(toolPolicies).values({ companyId: f.company.id, name: "Ask", policyType: "require_approval", priority: 1, selectors: { connectionId: f.remote.connection.id } });
    await expect(f.gateway.executeTool({
      sessionToken: f.session.token, tool: f.tool.name, parameters: { code: "mint" },
      secretCapture: { directive: directive(), actor: standardActor(f) },
    })).rejects.toMatchObject({ reasonCode: "secret_capture_failed", details: { captureReason: "approval_flow_unsupported" } });
    expect(f.upstreamBodies.some((body) => JSON.parse(body).method === "tools/call")).toBe(false);
    expect(await db.select().from(toolActionRequests).where(eq(toolActionRequests.companyId, f.company.id))).toHaveLength(0);
  });

  it("refuses a cross-company or foreign-agent caller", async () => {
    const f = await fixture();
    const other = await createCompanyFixture();
    const sameCompanyAgent = await db.insert(agents).values({ companyId: f.company.id, name: "Peer", role: "engineer", adapterType: "process" }).returning().then((rows) => rows[0]!);
    for (const [actor, denial] of [
      [standardActor(other), "company_mismatch"],
      [{ ...standardActor(f), agentId: sameCompanyAgent.id }, "agent_mismatch"],
      [{ ...standardActor(f), runId: randomUUID() }, "run_mismatch"],
      [null, "agent_credential_required"],
      [{ ...standardActor(f), keyScope: { kind: "skill_test", issueId: f.issue.id } }, "credential_class_refused"],
    ] as Array<[AuthorizationActor | null, string]>) {
      await expect(f.gateway.executeTool({
        sessionToken: f.session.token, tool: f.tool.name, parameters: { code: "mint" },
        secretCapture: { directive: directive(), actor },
      })).rejects.toMatchObject({ status: 403, reasonCode: "secret_capture_forbidden", details: { denial } });
    }
    expect(f.upstreamBodies.some((body) => JSON.parse(body).method === "tools/call")).toBe(false);
    expect((await sinkDump(f.company.id)).proposals).toHaveLength(0);
  });

  it("refuses an actor without the propose decision (low-trust agent)", async () => {
    const f = await fixture({
      permissions: {
        trustPreset: LOW_TRUST_REVIEW_PRESET,
        authorizationPolicy: { trustBoundary: { mode: LOW_TRUST_REVIEW_PRESET, projectIds: [randomUUID()] } },
      },
    });
    for (const actor of [
      standardActor(f),
      { ...standardActor(f), source: "agent_key", keyScope: { kind: "standard" } },
    ] as AuthorizationActor[]) {
      await expect(f.gateway.executeTool({
        sessionToken: f.session.token, tool: f.tool.name, parameters: { code: "mint" },
        secretCapture: { directive: directive(), actor },
      })).rejects.toMatchObject({ status: 403, reasonCode: "secret_capture_forbidden" });
    }
    expect(f.upstreamBodies.some((body) => JSON.parse(body).method === "tools/call")).toBe(false);
  });

  it("refuses a task_bridge key whose boundary does not cover the session issue", async () => {
    const f = await fixture();
    // Reassign the issue away from the agent: the bridge may no longer mutate it.
    const peer = await db.insert(agents).values({ companyId: f.company.id, name: "Peer", role: "engineer", adapterType: "process" }).returning().then((rows) => rows[0]!);
    await db.update(issues).set({ assigneeAgentId: peer.id }).where(eq(issues.id, f.issue.id));
    await expect(f.gateway.executeTool({
      sessionToken: f.session.token, tool: f.tool.name, parameters: { code: "mint" },
      secretCapture: {
        directive: directive(),
        actor: { ...standardActor(f), source: "agent_key", keyId: randomUUID(), keyScope: { kind: "task_bridge", parentIssueId: randomUUID() } },
      },
    })).rejects.toMatchObject({ status: 403, reasonCode: "secret_capture_forbidden", details: { denial: "issue_scope_denied" } });
  });

  it("rejects a malformed directive before the provider runs", async () => {
    const f = await fixture();
    await expect(f.gateway.executeTool({
      sessionToken: f.session.token, tool: f.tool.name, parameters: { code: "mint" },
      secretCapture: { directive: { pointer: "nope" }, actor: standardActor(f) },
    })).rejects.toMatchObject({ reasonCode: "secret_capture_failed", details: { captureReason: "invalid_directive" } });
    expect(f.upstreamBodies.some((body) => JSON.parse(body).method === "tools/call")).toBe(false);
  });
});

describe("REST capture route and secret endpoints", () => {
  function gatewayApp(gateway: ReturnType<typeof createToolGatewayService>, actor: () => AuthorizationActor | null) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = (actor() ?? { type: "none", source: "none" }) as never;
      next();
    });
    app.use("/api", toolGatewayRoutes(db, gateway));
    app.use("/api", secretRoutes(db));
    app.use(errorHandler);
    return app;
  }

  it("captures for Oracle's task_bridge agent key and grants no secret read or create access", async () => {
    const f = await fixture();
    const bridgeActor: AuthorizationActor = {
      type: "agent", agentId: f.agent.id, companyId: f.company.id, runId: f.run.id, source: "agent_key",
      keyId: randomUUID(), keyScope: { kind: "task_bridge", parentIssueId: randomUUID() },
    };
    const app = gatewayApp(f.gateway, () => bridgeActor);
    const response = await request(app)
      .post("/api/tool-gateway/tools/call")
      .set("x-paperclip-tool-gateway-token", f.session.token)
      .send({ tool: f.tool.name, parameters: { code: "mint" }, secretCapture: directive() });
    expect(response.status).toBe(200);
    expect(response.body.secretProposal).toMatchObject({ status: "pending" });
    expect(response.text).toContain(`[paperclip-secret-proposal:${response.body.secretProposal.id}]`);
    await expectNoLeak(f, response.text);

    // The directive opens nothing else for the same caller.
    const listed = await request(app).get("/api/agents/me/secrets");
    expect(listed.text).not.toContain("cloudflare-cmo-analytics-token");
    const read = await request(app).post("/api/agents/me/secrets/cloudflare-cmo-analytics-token/value").send({});
    expect(read.status).toBe(403);
    expectSentinelAbsent("secret read", read.text);
    const proposeDirect = await request(app).post("/api/agents/me/secret-proposals")
      .send({ kind: "secret", name: "x/y", value: "direct-value-123", justification: "j" });
    expect(proposeDirect.status).toBe(403);
    const createSecret = await request(app).post(`/api/companies/${f.company.id}/secrets`)
      .send({ name: "direct", provider: "local_encrypted", value: "direct-value-123" });
    expect(createSecret.status).toBe(403);
    expect((await db.select().from(companySecrets).where(eq(companySecrets.companyId, f.company.id)))
      .filter((row) => row.name === "direct" || row.key === "cloudflare-cmo-analytics-token")).toHaveLength(0);
  });

  it("refuses capture with only the gateway session token", async () => {
    const f = await fixture();
    const app = gatewayApp(f.gateway, () => null);
    const response = await request(app)
      .post("/api/tool-gateway/tools/call")
      .set("x-paperclip-tool-gateway-token", f.session.token)
      .send({ tool: f.tool.name, parameters: { code: "mint" }, secretCapture: directive() });
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ reasonCode: "secret_capture_forbidden", denial: "agent_credential_required" });
    expect(f.upstreamBodies.some((body) => JSON.parse(body).method === "tools/call")).toBe(false);
  });

  it("leaves ordinary calls without a directive unchanged", async () => {
    const f = await fixture({ reply: () => ({ result: { content: [{ type: "text", text: "plain" }] } }) });
    const app = gatewayApp(f.gateway, () => null);
    const response = await request(app)
      .post("/api/tool-gateway/tools/call")
      .set("x-paperclip-tool-gateway-token", f.session.token)
      .send({ tool: f.tool.name, parameters: { code: "read" } });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "completed", result: { content: "plain" } });
    expect(response.body.secretProposal).toBeUndefined();
  });
});
