import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startLocalBrowserLogin } from "./local-ai-browser-login.js";
import { resolveCodexCommand } from "../vendor/paperclip-runner/index.js";

vi.mock("../vendor/paperclip-runner/index.js", () => ({
  resolveCodexCommand: vi.fn(),
}));

const initialPath = process.env.PATH;
const initialPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const initialArchitecture = Object.getOwnPropertyDescriptor(process, "arch")!;
let root: string | undefined;
afterEach(async () => {
  Object.defineProperty(process, "platform", initialPlatform);
  Object.defineProperty(process, "arch", initialArchitecture);
  process.env.PATH = initialPath;
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function fakeCli(name: string, source: string) {
  root ??= await mkdtemp(path.join(os.tmpdir(), "paperclip-browser-login-"));
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, name), `#!/bin/sh\n${source}\n`, { mode: 0o700 });
  if (name === "codex") vi.mocked(resolveCodexCommand).mockReturnValue(path.join(bin, name));
  process.env.PATH = `${bin}${path.delimiter}${initialPath}`;
  const home = path.join(root, "credential-home");
  await mkdir(home, { mode: 0o700 });
  if (name === "muse") await mkdir(path.join(home, ".config", "muse"), { recursive: true, mode: 0o700 });
  return realpath(home);
}

function targetPlatform(platform: string, architecture: string) {
  Object.defineProperty(process, "platform", { ...initialPlatform, value: platform });
  Object.defineProperty(process, "arch", { ...initialArchitecture, value: architecture });
}

describe.skipIf(process.platform === "win32")("local browser subscription login", () => {
  it.each([false, true])("uses the selected Codex command with its credential home and ambient HOME/cwd (legacy Linux ARM64: %s)", async (legacy) => {
    if (legacy) targetPlatform("linux", "arm64");
    const home = await fakeCli("codex", [
      '[ "$1 $2" = "login --device-auth" ] || exit 11',
      '[ "$HOME" = "$CLAUDE_CONFIG_DIR" ] && [ "$HOME" != "$CODEX_HOME" ] && [ "$CODEX_HOME" = "$PAPERCLIP_TEST_LOGIN_CODEX_HOME" ] || exit 12',
      '[ "$PWD" = "$PAPERCLIP_TEST_LOGIN_CWD" ] || exit 13',
      '[ -z "$OPENAI_API_KEY$CODEX_API_KEY$ANTHROPIC_API_KEY$ANTHROPIC_AUTH_TOKEN$CLAUDE_CODE_OAUTH_TOKEN" ] || exit 14',
      'printf "1. Open this link in your browser and sign in to your account\\nhttps://auth.openai.com/codex/device\\n2. Enter this one-time code (expires in 15 minutes)\\nABCD-EFGHJ\\n"',
    ].join("\n"));
    if (legacy) vi.mocked(resolveCodexCommand).mockImplementation(() => { throw new Error("native artifact is unavailable"); });
    else process.env.PATH = "/usr/bin:/bin";
    const ambientHome = path.join(root!, "unrelated-host-home");
    await mkdir(ambientHome, { mode: 0o700 });
    for (const key of ["HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"]) vi.stubEnv(key, ambientHome);
    vi.stubEnv("PAPERCLIP_TEST_LOGIN_CODEX_HOME", home);
    vi.stubEnv("PAPERCLIP_TEST_LOGIN_CWD", process.cwd());
    for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"])
      vi.stubEnv(key, "unrelated-host-value");
    const login = startLocalBrowserLogin("openai", home);
    await vi.waitFor(() => expect(login.outcome).toBe("success"), { timeout: 5000 });
    if (legacy) expect(resolveCodexCommand).not.toHaveBeenCalled();
    else expect(resolveCodexCommand).toHaveBeenCalledOnce();
    expect(login.code).toBe("ABCD-EFGHJ");
  });

  it.each([["linux", "x64"], ["darwin", "arm64"], ["darwin", "x64"]] as const)("reports an unavailable Codex CLI on %s/%s without revealing private details", async (platform, architecture) => {
    targetPlatform(platform, architecture);
    const home = await fakeCli("codex", 'echo invoked > "$CODEX_HOME/unreviewed-cli"');
    const failure = new Error("private-installation-path-or-provider-output");
    vi.mocked(resolveCodexCommand).mockImplementation(() => { throw failure; });
    const login = startLocalBrowserLogin("openai", home);
    await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5000 });
    expect(login.error).toMatch(/requires an installed Codex CLI.*Install Codex/);
    expect(JSON.stringify(login)).not.toContain(failure.message);
    await expect(readFile(path.join(home, "unreviewed-cli"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(login.authorizationUrl).toBeUndefined();
  });

  it("reports a missing Linux ARM64 Codex CLI without revealing the host PATH", async () => {
    targetPlatform("linux", "arm64");
    const home = await fakeCli("codex", "exit 0");
    process.env.PATH = "/usr/bin:/bin";
    const login = startLocalBrowserLogin("openai", home);
    await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5000 });
    expect(login.error).toMatch(/requires the Codex CLI.*Install Codex.*Paperclip's PATH/);
    expect(JSON.stringify(login)).not.toContain(process.env.PATH);
    expect(resolveCodexCommand).not.toHaveBeenCalled();
  });

  it("reports a missing terminal prerequisite without exposing spawn details", async () => {
    const home = await fakeCli("codex", "exit 0");
    process.env.PATH = path.join(root!, "no-python");
    const login = startLocalBrowserLogin("openai", home);
    await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5000 });
    expect(login.error).toMatch(/requires Python 3.*Install Python 3/);
    expect(JSON.stringify(login)).not.toContain(process.env.PATH);
  });

  it("cancels before launching the resolved Codex command", async () => {
    const home = await fakeCli("codex", 'echo invoked > "$CODEX_HOME/cancelled-cli"');
    const login = startLocalBrowserLogin("openai", home);
    login.abort();
    await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5000 });
    await expect(readFile(path.join(home, "cancelled-cli"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("surfaces a Codex device link and code from a local PTY without a user shell command", async () => {
    const home = await fakeCli("codex", [
      'printf "1. Open this link in your browser and sign in to your account\\n"',
      'printf "https://auth.openai.com/codex/device\\n"',
      'printf "2. Enter this one-time code (expires in 15 minutes)\\n"',
      'printf "ABCD-EFGHJ\\n"',
    ].join("\n"));
    const login = startLocalBrowserLogin("openai", home);
    await vi.waitFor(() => expect(login.outcome).toBe("success"), { timeout: 5000 });
    expect(login.authorizationUrl).toBe("https://auth.openai.com/codex/device");
    expect(login.code).toBe("ABCD-EFGHJ");
  });

  it("accepts a Claude browser code and stores its token only in the attempt home", async () => {
    const url = "https://claude.com/cai/oauth/authorize?client_id=cid&code=abcdefgh&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&response_type=code&scope=user&state=0123456789abcdef";
    const home = await fakeCli("claude", [
      'printf "Welcome to Claude Code\\nOpening browser to sign in…\\nBrowser didn\x27t open? Use the url below to sign in (c to copy)\\n"',
      `printf '%s\\n' '${url}'`,
      'printf "Paste code here if prompted >\\n"',
      'read -r entered',
      'printf "✓ Long-lived authentication token created successfully!\\n\\nYour OAuth token (valid for 1 year):\\n\\nsk-ant-oat01-AAAABBBBCCCCDDDDEEEE11112222FFFFGGGG_HHHH-IIII\\n\\nStore this token securely. You won\x27t be able to see it again.\\n"',
    ].join("\n"));
    const login = startLocalBrowserLogin("anthropic", home);
    await vi.waitFor(() => expect(login.authorizationUrl).toBe(url), { timeout: 5000 });
    login.submitCode?.("fixture-code");
    await vi.waitFor(() => expect(login.outcome).toBe("success"), { timeout: 5000 });
    const credential = JSON.parse(await readFile(path.join(home, ".credentials.json"), "utf8"));
    expect(credential.claudeAiOauth.accessToken).toMatch(/^sk-ant-oat01-/);
    expect((await stat(path.join(home, ".credentials.json"))).mode & 0o777).toBe(0o600);
  });

  it("terminates the local provider process when sign-in is cancelled", async () => {
    const home = await fakeCli("codex", 'echo $$ > "$CODEX_HOME/login.pid"\nexec sleep 60');
    const login = startLocalBrowserLogin("openai", home);
    let pid = 0;
    await vi.waitFor(async () => { pid = Number(await readFile(path.join(home, "login.pid"), "utf8")); expect(pid).toBeGreaterThan(0); });
    login.abort();
    await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5000 });
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5000 });
  });

  it("cancels Claude while waiting for its browser code and terminates the provider", async () => {
    const home = await fakeCli("claude", [
      'echo $$ > "$CLAUDE_CONFIG_DIR/login.pid"',
      'printf "Welcome to Claude Code\\nOpening browser to sign in…\\nBrowser didn\x27t open? Use the url below to sign in (c to copy)\\n"',
      'printf "https://claude.com/cai/oauth/authorize?client_id=cid&code=abcdefgh&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&redirect_uri=https%%3A%%2F%%2Fplatform.claude.com%%2Foauth%%2Fcode%%2Fcallback&response_type=code&scope=user&state=0123456789abcdef\\n"',
      'printf "Paste code here if prompted >\\n"',
      'read -r entered',
    ].join("\n"));
    const login = startLocalBrowserLogin("anthropic", home);
    await vi.waitFor(() => expect(login.authorizationUrl).toBeDefined());
    const pid = Number(await readFile(path.join(home, "login.pid"), "utf8"));
    login.abort();
    await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5000 });
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5000 });
    await expect(readFile(path.join(home, ".credentials.json"))).rejects.toThrow();
  });

  it.each([true, false])("runs isolated Muse device sign-in and handles its terminal prompt (complete URL: %s)", async (completeUrl) => {
    const url = `https://auth.meta.com/oauth/device/${completeUrl ? "?code=ABCD-EFGH" : ""}`;
    const home = await fakeCli("muse", [
      '[ "$#" = 1 ] && [ "$1" = login ] || exit 11',
      '[ "${META_API_KEY+x}" = x ] && [ -z "$META_API_KEY" ] || exit 12',
      '[ "${MUSE_API_KEY+x}" = x ] && [ -z "$MUSE_API_KEY" ] || exit 17',
      '[ "$MUSE_AUTH_PATH" = "$PAPERCLIP_TEST_MUSE_AUTH_PATH" ] || exit 13',
      '[ "$MUSE_NO_AUTO_UPDATE" = 1 ] && [ "$BROWSER" = true ] || exit 14',
      '[ "$HOME" = "$PAPERCLIP_TEST_LOGIN_HOME" ] || exit 15',
      '[ "$XDG_CONFIG_HOME" = "$HOME/.config" ] && [ "$XDG_DATA_HOME" = "$HOME/.local/share" ] || exit 18',
      // Prompts go to stderr in the real launcher; the PTY merges the streams.
      'printf "Open this page to sign in:\\n  https://auth.meta.com/oa" >&2',
      'sleep 0.05',
      `printf '%s\\n' 'uth/device/${completeUrl ? "?code=ABCD-EFGH" : ""}' >&2`,
      `printf '${completeUrl ? "confirm this code matches:" : "Enter this code:"}\\n  \\033[1mABCD-EFGH\\033[0m\\n\\nPress Enter to open it in your browser: ' >&2`,
      'if read -r answer </dev/tty; then exit 16; fi',
      // Native Muse ignores MUSE_AUTH_PATH and uses XDG_CONFIG_HOME.
      'umask 077; printf \'{"providers":{"meta":{"mechanism":"oauth","access_token":"fixture-only","subs_active":true}}}\\n\' > "$XDG_CONFIG_HOME/muse/auth.json"',
      `printf '%s\\n' '${completeUrl ? "Logged in. Credential saved to " : "Login credential saved to "}private-file' >&2`,
    ].join("\n"));
    vi.stubEnv("META_API_KEY", "must-not-be-used");
    vi.stubEnv("MUSE_API_KEY", "must-not-be-used-either");
    vi.stubEnv("MUSE_AUTH_PATH", path.join(root!, "ambient-auth-do-not-use.json"));
    vi.stubEnv("MUSE_NO_AUTO_UPDATE", "0");
    vi.stubEnv("PAPERCLIP_TEST_MUSE_AUTH_PATH", path.join(home, ".config", "muse", "auth.json"));
    vi.stubEnv("PAPERCLIP_TEST_LOGIN_HOME", home);
    const login = startLocalBrowserLogin("muse", home);
    await vi.waitFor(() => expect(login.outcome).toBe("success"), { timeout: 5000 });
    expect(login.authorizationUrl).toBe(url);
    expect(login.code).toBe("ABCD-EFGH");
    expect(login.submitCode).toBeUndefined();
    expect(JSON.parse(await readFile(path.join(home, ".config", "muse", "auth.json"), "utf8"))).toEqual({ providers: { meta: { mechanism: "oauth", access_token: "fixture-only", subs_active: true } } });
    expect((await stat(path.join(home, ".config", "muse", "auth.json"))).mode & 0o777).toBe(0o600);
    await expect(readFile(path.join(home, "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(process.env.MUSE_AUTH_PATH!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.stringify(login)).not.toContain("fixture-only");
  });

  it.each(["missing", "api-key", "inactive", "insecure"])("does not accept printed success with an unusable private Muse credential (%s)", async (kind) => {
    const credential = JSON.stringify({ providers: { meta: kind === "api-key"
      ? { mechanism: "api_key", api_key: "metered-private-fixture" }
      : { mechanism: "oauth", access_token: "private-fixture-token", subs_active: kind !== "inactive" } } });
    const home = await fakeCli("muse", [
      'printf "Open this page to sign in:\\nhttps://auth.meta.com/oauth/device/\\nEnter this code:\\nABCD-EFGH\\n"',
      ...(kind === "missing" ? [] : [
        `umask 077; printf '%s' '${credential}' > "$XDG_CONFIG_HOME/muse/auth.json"`,
        ...(kind === "insecure" ? ['chmod 0644 "$XDG_CONFIG_HOME/muse/auth.json"'] : []),
      ]),
      'printf "Logged in. Credential saved to private-file\\n"',
    ].join("\n"));
    const login = startLocalBrowserLogin("muse", home);
    await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5000 });
    expect(login.error).toContain("did not save a verified OAuth subscription");
    expect(JSON.stringify(login)).not.toContain("private-fixture-token");
    expect(JSON.stringify(login)).not.toContain("metered-private-fixture");
    expect(JSON.stringify(login)).not.toContain(home);
  });

  it.each([
    ["access_denied", "Meta did not approve"],
    ["expired", "approval code expired"],
    ["mint_failed", "could not issue a Muse credential"],
    ["flow_failed", "could not complete browser sign-in"],
    ["store_failed", "could not save the approved account"],
  ])("reports only a sanitised native Muse failure category (%s)", async (category, message) => {
    const home = await fakeCli("muse", `printf 'error: ${category}: private-provider-details\\n' >&2\nexit 1`);
    const login = startLocalBrowserLogin("muse", home);
    await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5000 });
    expect(login.error).toContain(message);
    expect(JSON.stringify(login)).not.toContain("private-provider-details");
    expect(login.authorizationUrl).toBeUndefined();
  });

  it.each([
    "https://evil.example/oauth/device/?code=ABCD-EFGH",
    "https://auth.meta.com.evil.example/oauth/device/?code=ABCD-EFGH",
    "https://auth.meta.com@evil.example/oauth/device/?code=ABCD-EFGH",
    "http://auth.meta.com/oauth/device/?code=ABCD-EFGH",
    "https://auth.meta.com:444/oauth/device/?code=ABCD-EFGH",
    "https://auth.meta.com/unexpected/?code=ABCD-EFGH",
    "https://auth.meta.com/oauth/device/?code=ABCD-EFGH&redirect=https://evil.example",
    "https://auth.meta.com/oauth/device/?code=ABCD-EFGH#unexpected",
    "https://auth.meta.com/oauth/device/?code=IJKL-MNOP",
  ])("rejects an untrusted or unexpected Muse device URL: %s", async (url) => {
    const home = await fakeCli("muse", [
      'echo $$ > "${MUSE_AUTH_PATH}.pid"',
      `printf '%s\\n' 'Open this page to sign in:' '${url}' 'Confirm this code matches:' 'ABCD-EFGH'`,
      'exec sleep 60',
    ].join("\n"));
    const login = startLocalBrowserLogin("muse", home);
    await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5000 });
    expect(login.authorizationUrl).toBeUndefined();
    expect(login.code).toBeUndefined();
    expect(login.error).toBe("Muse returned an unexpected sign-in prompt. Start sign-in again.");
    expect(JSON.stringify(login)).not.toContain(url);
    const pid = Number(await readFile(path.join(home, ".config", "muse", "auth.json.pid"), "utf8"));
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5000 });
  });

  it("reports a missing Muse CLI without exposing host paths", async () => {
    const home = await fakeCli("muse", "exit 0");
    process.env.PATH = "/usr/bin:/bin";
    const login = startLocalBrowserLogin("muse", home);
    await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5000 });
    expect(login.error).toMatch(/requires the Muse CLI.*Install Muse/);
    expect(JSON.stringify(login)).not.toContain(process.env.PATH);
    expect(login.authorizationUrl).toBeUndefined();
  });

  it("rejects oversized Muse output without retaining provider details", async () => {
    const home = await fakeCli("muse", 'printf "%5000s" "private-provider-output"\nexec sleep 60');
    const login = startLocalBrowserLogin("muse", home);
    await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5000 });
    expect(login.error).toMatch(/unexpected sign-in prompt/);
    expect(JSON.stringify(login)).not.toContain("private-provider-output");
  });

  it("cancels Muse before launching the command", async () => {
    const home = await fakeCli("muse", 'echo invoked > "${MUSE_AUTH_PATH}.invoked"');
    const login = startLocalBrowserLogin("muse", home);
    login.abort();
    await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5000 });
    await expect(readFile(path.join(home, ".config", "muse", "auth.json.invoked"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("terminates Muse and its child when cancelled during browser approval", async () => {
    const home = await fakeCli("muse", [
      'echo $$ > "${MUSE_AUTH_PATH}.pid"',
      'sleep 60 &',
      'echo $! > "${MUSE_AUTH_PATH}.child.pid"',
      'printf "Open this page to sign in:\\nhttps://auth.meta.com/oauth/device/\\nEnter this code:\\nABCD-EFGH\\n" >&2',
      'wait',
    ].join("\n"));
    const login = startLocalBrowserLogin("muse", home);
    try {
      await vi.waitFor(() => expect(login.code).toBe("ABCD-EFGH"), { timeout: 5000 });
    } finally { login.abort(); }
    await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5000 });
    for (const file of ["auth.json.pid", "auth.json.child.pid"]) {
      const pid = Number(await readFile(path.join(home, ".config", "muse", file), "utf8"));
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5000 });
    }
  });

  it.each([0, 1])("does not expose Muse provider output or claim success without approval (exit %s)", async (exitCode) => {
    const home = await fakeCli("muse", `printf 'private-provider-output\\n' >&2\nexit ${exitCode}`);
    const login = startLocalBrowserLogin("muse", home);
    await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5000 });
    expect(JSON.stringify(login)).not.toContain("private-provider-output");
    expect(login.authorizationUrl).toBeUndefined();
  });

  it("returns a fixed failure without exposing provider error output", async () => {
    const home = await fakeCli("codex", 'echo "private-provider-error" >&2\nexit 1');
    const login = startLocalBrowserLogin("openai", home);
    await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5000 });
    expect(JSON.stringify(login)).not.toContain("private-provider-error");
    expect(login.authorizationUrl).toBeUndefined();
  });
});
