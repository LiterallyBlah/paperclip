import { describe, expect, it, vi } from "vitest";
import { parseClaudeAuthLoginPrompt, parseSetupTokenPrompt, SETUP_TOKEN_PROMPT } from "./setup-token-parse.js";
import { CLAUDE_AUTH_LOGIN_COMMAND, runSetupTokenLogin, type SetupTokenPtyDriver } from "./setup-token-runner.js";

// Shape of `claude auth login --claudeai` output from Claude Code 2.1.317, with
// a synthetic challenge and state. The URL is an OSC 8 hyperlink whose display
// text repeats the URL, followed by the code prompt.
const URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code+user%3Amcp_servers+user%3Afile_upload+user%3Aplugins&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&state=0123456789abcdef0123";
const OUTPUT = `Opening browser to sign in…\r\nIf the browser didn't open, visit: \x1b]8;;${URL}\x07${URL}\x1b]8;;\x07\r\nPaste code here if prompted > `;
const CODE = "SENTINEL-CODE-4471";

function driverFor(exitCode: number) {
  const writes: string[] = [];
  let exit!: (value: { exitCode: number | null }) => void;
  const exited = new Promise<{ exitCode: number | null }>((resolve) => { exit = resolve; });
  const driver: SetupTokenPtyDriver = {
    async start(_command, onData) { onData(OUTPUT); return exited; },
    write(input) { writes.push(input); if (input === "\r") exit({ exitCode }); },
    stop() {},
    async dispose() {},
  };
  return { driver, writes, exit };
}

describe("claude auth login", () => {
  it("parses the auth login prompt with the setup-token URL validation", () => {
    expect(parseClaudeAuthLoginPrompt(OUTPUT)).toEqual({ url: URL, prompt: SETUP_TOKEN_PROMPT });
    // Each parser binds only its own preamble.
    expect(parseSetupTokenPrompt(OUTPUT)).toBeNull();
    expect(parseClaudeAuthLoginPrompt(OUTPUT.replace("claude.com/cai", "claude.evil.com/cai"))).toBeNull();
    expect(parseClaudeAuthLoginPrompt(OUTPUT.replace("platform.claude.com", "attacker.example"))).toBeNull();
  });

  it("succeeds after the code is sent and never scans output for a credential", async () => {
    const fake = driverFor(0);
    const onCredential = vi.fn(async () => {});
    const onPrompt = vi.fn();
    const result = await runSetupTokenLogin(fake.driver, {
      mode: "auth_login", onPrompt, provideCode: async () => CODE, onCredential, timeoutMs: 1000, codeSubmitSettleMs: 0,
    });
    expect(result).toMatchObject({ outcome: "success", promptSurfaced: true, codeSubmitted: true, credentialDelivered: false });
    expect(onPrompt).toHaveBeenCalledWith({ url: URL, prompt: SETUP_TOKEN_PROMPT });
    expect(fake.writes).toEqual([CODE, "\r"]);
    expect(onCredential).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(CODE);
    expect(CLAUDE_AUTH_LOGIN_COMMAND).toBe("claude auth login --claudeai");
  });

  it("fails on a non-zero exit or a clean exit before any code was sent", async () => {
    const failed = driverFor(1);
    expect((await runSetupTokenLogin(failed.driver, { mode: "auth_login", onPrompt: () => {}, provideCode: async () => CODE, timeoutMs: 1000, codeSubmitSettleMs: 0 })).outcome).toBe("failure");
    const early: SetupTokenPtyDriver = { async start() { return { exitCode: 0 }; }, write() {}, stop() {}, async dispose() {} };
    expect((await runSetupTokenLogin(early, { mode: "auth_login", onPrompt: () => {}, provideCode: async () => CODE, timeoutMs: 1000 })).outcome).toBe("failure");
  });
});
