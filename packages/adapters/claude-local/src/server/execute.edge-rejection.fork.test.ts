import { beforeEach, describe, expect, it, vi } from "vitest";

const { runAdapterExecutionTargetProcess } = vi.hoisted(() => ({
  runAdapterExecutionTargetProcess: vi.fn(),
}));

vi.mock("./acp.js", () => ({
  createClaudeAcpExecutor: () => vi.fn(),
  resolveClaudeExecutionEngineForRun: async () => ({ engine: "cli", explicit: true }),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
    ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
    resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "claude"),
    runAdapterExecutionTargetProcess,
  };
});

import { execute } from "./execute.js";
import { detectClaudeLoginRequired } from "./parse.js";

const event = (value: Record<string, unknown>) => JSON.stringify({ session_id: "claude-session-1", ...value });

// A Bash tool result, as the stream-json transcript carries it.
function toolResult(text: string) {
  return event({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: text }] },
  });
}

function proc(input: { lines: string[]; exitCode: number; stderr?: string; signal?: string | null }) {
  return {
    exitCode: input.exitCode,
    signal: input.signal ?? null,
    timedOut: false,
    stdout: [event({ type: "system", subtype: "init", model: "claude-sonnet" }), ...input.lines].join("\n"),
    stderr: input.stderr ?? "",
    pid: 321,
    startedAt: new Date().toISOString(),
  };
}

function mockRun(result: ReturnType<typeof proc>) {
  runAdapterExecutionTargetProcess.mockImplementation(async (_runId: string, _target: unknown, _command: string, args: string[]) =>
    args.includes("--version") ? { ...result, exitCode: 0, stdout: "2.1.284 (Claude Code)" } : result,
  );
}

function context() {
  return {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "Claude Coder", adapterType: "claude_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { engine: "cli" },
    context: {},
    onLog: vi.fn(async () => {}),
  };
}

const COOKIE_MARKER = "CFBMCOOKIEMARKERvalue0123456789";
const CHALLENGE_HTML = [
  "<!DOCTYPE html>",
  '<html lang="en-US"><head><title>Attention Required! | Cloudflare</title>',
  `<script>document.cookie="__cf_bm=${COOKIE_MARKER}"</script>`,
  "</head><body><h1>Sorry, you have been blocked</h1>",
  "<p>Unauthorized request.</p>",
  '<span class="cf-footer-item">Cloudflare Ray ID: <strong>8f2a1b3c4d5e6f70</strong></span>',
  "</body></html>",
].join("");

// The CLI reports an upstream API error as an assistant event with top-level
// is_api_error_message metadata and error "authentication_failed" for a 401 or 403.
const cliApiError = (text: string) => event({ type: "assistant", error: "authentication_failed", is_api_error_message: true,
  message: { content: [{ type: "text", text }] } });
const failedResult = (status: number, result: string) => event({ type: "result", subtype: "success", is_error: true,
  api_error_status: status, error: "authentication_failed", result });

describe("claude_local edge rejections in the fork's transcript-scoped classifier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not label sign-in when the CLI auth error event and the result carry a Cloudflare 403 page", async () => {
    const text = `Failed to authenticate. API Error: 403 ${CHALLENGE_HTML}`;
    mockRun(proc({ exitCode: 1, lines: [cliApiError(text), failedResult(403, text)] }));
    const result = await execute(context() as never);
    expect(result.errorCode).toBe("claude_edge_rejected");
    expect(result.errorFamily).toBe("transient_upstream");
    expect(JSON.stringify(result.resultJson)).not.toContain(COOKIE_MARKER);
  });

  it("does not label sign-in when only the CLI auth error event with a Cloudflare 403 page arrives before the run stops", async () => {
    mockRun(proc({ exitCode: 1, lines: [cliApiError(`API Error: 403 ${CHALLENGE_HTML}`)] }));
    const result = await execute(context() as never);
    expect(result.errorCode).toBe("claude_edge_rejected");
    expect(result.errorFamily).toBe("transient_upstream");
    expect(result.resultJson?.stdout).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(COOKIE_MARKER);
  });

  it("does not label sign-in for a Cloudflare 403 page on plain stdout with no result", async () => {
    mockRun({ ...proc({ exitCode: 1, lines: [] }), stdout: `API Error: 403 ${CHALLENGE_HTML}` });
    const result = await execute(context() as never);
    expect(result.errorCode).toBe("claude_edge_rejected");
    expect(result.errorFamily).toBe("transient_upstream");
    expect(result.resultJson?.stdout).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(COOKIE_MARKER);
  });

  it("does not label sign-in for a Cloudflare 403 page on stderr with no result", async () => {
    mockRun(proc({ exitCode: 1, lines: [], stderr: `API Error: 403 ${CHALLENGE_HTML}` }));
    expect((await execute(context() as never)).errorCode).toBe("claude_edge_rejected");
  });

  it.each([
    ["a 401 authentication_error in the CLI auth error event",
      'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}'],
    ["a 403 revoked OAuth token in the CLI auth error event",
      'Failed to authenticate. API Error: 403 {"type":"error","error":{"type":"permission_error","message":"OAuth token has been revoked."}}'],
    ["a login prompt in the CLI auth error event", "Not logged in · Please run /login"],
  ])("still labels sign-in for %s with no result", async (_name, text) => {
    mockRun(proc({ exitCode: 1, lines: [cliApiError(text)] }));
    expect((await execute(context() as never)).errorCode).toBe("claude_auth_required");
  });

  it("still labels sign-in for a 401 authentication_error result with a CLI auth error event", async () => {
    const text = 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid bearer token"}}';
    mockRun(proc({ exitCode: 1, lines: [cliApiError(text), failedResult(401, text)] }));
    expect((await execute(context() as never)).errorCode).toBe("claude_auth_required");
  });

});

describe("detectClaudeLoginRequired edge override", () => {
  it("never adds a sign-in signal: an edge page in a successful run stays not-login", () => {
    expect(detectClaudeLoginRequired({
      parsed: { is_error: false, subtype: "success", result: "done" },
      stdout: "",
      stderr: `API Error: 403 ${CHALLENGE_HTML}`,
    }).requiresLogin).toBe(false);
  });

  it("does not read an edge page from model text, so assistant text cannot hide a genuine sign-in failure", () => {
    const assistant = event({ type: "assistant", message: { content: [{ type: "text", text: `Cloudflare Ray ID: 8f2a1b3c4d5e6f70 ${CHALLENGE_HTML}` }] } });
    expect(detectClaudeLoginRequired({
      parsed: null,
      stdout: [assistant, cliApiError("Not logged in · Please run /login")].join("\n"),
      stderr: "",
    }).requiresLogin).toBe(true);
  });

  it("clears sign-in for a cut-off CLI auth error event carrying an edge page", () => {
    expect(detectClaudeLoginRequired({
      parsed: null,
      stdout: cliApiError(`API Error: 403 ${CHALLENGE_HTML}`),
      stderr: "",
    }).requiresLogin).toBe(false);
  });
});
