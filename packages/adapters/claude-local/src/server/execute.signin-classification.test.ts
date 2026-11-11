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

import { appendWithCap, MAX_CAPTURE_BYTES } from "@paperclipai/adapter-utils/server-utils";
import { execute } from "./execute.js";

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

const success = event({ type: "result", subtype: "success", is_error: false, result: "Waiting for the debug run events." });

describe("claude_local sign-in classification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The three production lockouts: a successful result, then a cleanup kill
  // (exit 143), with a sign-in phrase only in tool output the agent read.
  it.each([
    ["unauthorized", 'import { badRequest, forbidden, unauthorized } from "../errors.js";'],
    ["not logged in", "You are not logged into any GitHub hosts. Run gh auth login to authenticate."],
    ["authentication required", 'res.status(403).json({ error: "Agent authentication required" })'],
  ])("does not label sign-in for %s in tool output after a successful result", async (_phrase, text) => {
    mockRun(proc({ lines: [toolResult(text), success], exitCode: 143, signal: "SIGTERM" }));
    const result = await execute(context() as never);
    expect(result.errorCode).not.toBe("claude_auth_required");
  });

  it("does not label sign-in for a phrase in tool output when the run fails for another reason", async () => {
    mockRun(proc({ lines: [toolResult("throw unauthorized();"),
      event({ type: "result", subtype: "error_max_turns", is_error: true })], exitCode: 1 }));
    expect((await execute(context() as never)).errorCode).toBe("max_turns_exhausted");
  });

  it("does not label sign-in for tool output in a run killed before any result", async () => {
    mockRun(proc({ lines: [toolResult("Please run claude login")], exitCode: 143, signal: "SIGTERM" }));
    expect((await execute(context() as never)).errorCode).not.toBe("claude_auth_required");
  });

  // Claude 2.1.286 with no credentials (record shapes from the review's real capture).
  const noAuthEvent = event({ type: "assistant", error: "authentication_failed", is_api_error_message: true,
    message: { content: [{ type: "text", text: "Not logged in · Please run /login" }] } });
  const noAuthResult = event({ type: "result", subtype: "success", is_error: true, api_error_status: null,
    result: "Not logged in · Please run /login" });

  it("still labels sign-in when the CLI auth error arrives but the result is missing", async () => {
    mockRun(proc({ exitCode: 1, lines: [noAuthEvent] }));
    expect((await execute(context() as never)).errorCode).toBe("claude_auth_required");
  });

  it("still labels sign-in when the result record is cut off", async () => {
    const full = proc({ exitCode: 1, lines: [noAuthEvent, noAuthResult] });
    mockRun({ ...full, stdout: full.stdout.slice(0, -25) });
    expect((await execute(context() as never)).errorCode).toBe("claude_auth_required");
  });

  it.each([
    ["assistant text", event({ type: "assistant", message: { content: [{ type: "text",
      text: '{"error":"authentication_failed","is_api_error_message":true}' }] } })],
    ["tool output", toolResult('{"type":"assistant","error":"authentication_failed","is_api_error_message":true}')],
  ])("does not take the CLI auth error marker from %s", async (_source, line) => {
    mockRun(proc({ exitCode: 143, signal: "SIGTERM", lines: [line] }));
    expect((await execute(context() as never)).errorCode).not.toBe("claude_auth_required");
  });

  it.each(["Not logged in · Please run /login", "Unauthorized"])(
    "still labels sign-in for %s in the singular error field of a failed result", async (error) => {
      mockRun(proc({ exitCode: 1, lines: [event({ type: "result", subtype: "error_during_execution", is_error: true, error })] }));
      expect((await execute(context() as never)).errorCode).toBe("claude_auth_required");
    });

  it("does not label sign-in from the tail of a tool record cut by the capture cap", async () => {
    // Capture keeps the last MAX_CAPTURE_BYTES characters, so a long tool record
    // loses its opening brace and its tail reads like plain output.
    let stdout = "";
    for (const line of [event({ type: "system", subtype: "init", model: "claude-sonnet" }),
      toolResult(`${"x".repeat(MAX_CAPTURE_BYTES)} unauthorized`)]) stdout = appendWithCap(stdout, `${line}\n`);
    expect(stdout.trimStart().startsWith("{")).toBe(false);
    mockRun({ ...proc({ exitCode: 143, signal: "SIGTERM", lines: [] }), stdout });
    expect((await execute(context() as never)).errorCode).not.toBe("claude_auth_required");
  });

  it("still labels sign-in for a plain stdout login prompt with no result", async () => {
    mockRun({ ...proc({ exitCode: 1, lines: [] }), stdout: "Not logged in · Please run /login" });
    expect((await execute(context() as never)).errorCode).toBe("claude_auth_required");
  });

  it.each([
    ["a not-logged-in result", proc({ exitCode: 1,
      lines: [event({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" })] })],
    ["a revoked OAuth token", proc({ exitCode: 1, lines: [event({ type: "result", subtype: "success", is_error: true,
      api_error_status: 401, error: "authentication_failed", result: "Failed to authenticate. API Error: 401 Invalid bearer token" })] })],
    ["a login prompt on stderr with no result", proc({ exitCode: 1, lines: [], stderr: "Invalid API key · Please run /login" })],
  ])("still labels sign-in for %s", async (_name, result) => {
    mockRun(result);
    expect((await execute(context() as never)).errorCode).toBe("claude_auth_required");
  });
});
