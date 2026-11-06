import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { runSetupTokenLogin } from "@paperclipai/adapter-claude-local/server";
import { runDeviceLogin } from "@paperclipai/adapter-codex-local/server";
import { ensureCommandResolvable, resolveCommandForLogs } from "@paperclipai/adapter-utils/server-utils";
import { resolveCodexCommand } from "../vendor/paperclip-runner/index.js";
import { readVerifiedLocalAiCredential } from "./local-ai-credentials.js";

export type LocalBrowserLoginState = {
  authorizationUrl?: string;
  code?: string;
  outcome?: "success" | "failure";
  error?: string;
  submitCode?: (code: string) => void;
  abort: () => void;
};

// Node has no built-in PTY API. Python's standard-library pty module supplies
// the terminal required by the provider CLIs. The Docker image already includes
// python3. This bridge forwards only bytes; provider output is never logged.
const PYTHON_PTY_BRIDGE = String.raw`
import errno, os, pty, select, signal, sys
pid, master = pty.fork()
if pid == 0:
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)
def stop(_signal, _frame):
    try: os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError: pass
    try: os.waitpid(pid, 0)
    except ChildProcessError: pass
    sys.exit(1)
signal.signal(signal.SIGTERM, stop)
while True:
    readable, _, _ = select.select([master, 0], [], [])
    if 0 in readable:
        data = os.read(0, 4096)
        if data: os.write(master, data)
        else: stop(None, None)
    if master in readable:
        try: data = os.read(master, 4096)
        except OSError as error:
            if error.errno == errno.EIO: break
            raise
        if not data: break
        os.write(1, data)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;

/** Run the same browser-code login used by sandbox connections on the local host. */
export function startLocalBrowserLogin(provider: "anthropic" | "openai" | "muse", home: string): LocalBrowserLoginState {
  const controller = new AbortController();
  const state: LocalBrowserLoginState = { abort: () => controller.abort() };
  const args = provider === "anthropic" ? ["setup-token"] : provider === "muse" ? ["login"] : ["login", "--device-auth"];
  let child: ChildProcessWithoutNullStreams | null = null;
  const driver = {
    async start(_command: string, onData: (chunk: string) => void): Promise<{ exitCode: number | null }> {
      let executable = "claude";
      if (provider === "openai") {
        const legacyPlatform = !((process.platform === "linux" || process.platform === "darwin")
          && (process.arch === "x64" || process.arch === "arm64"));
        try {
          if (legacyPlatform) {
            await ensureCommandResolvable("codex", home, process.env);
            executable = path.resolve(home, await resolveCommandForLogs("codex", home, process.env));
          } else {
            executable = resolveCodexCommand();
          }
        } catch {
          state.error = legacyPlatform
            ? "Codex browser sign-in requires the Codex CLI on this platform. Install Codex on this execution host and ensure codex is on Paperclip's PATH, then start sign-in again."
            : "Codex browser sign-in requires an installed Codex CLI. Install Codex on this execution host or restore Paperclip's runtime dependencies, then start sign-in again.";
          throw new Error("Browser login runtime unavailable");
        }
      }
      if (provider === "muse") {
        try {
          await ensureCommandResolvable("muse", home, process.env);
          executable = path.resolve(home, await resolveCommandForLogs("muse", home, process.env));
        } catch {
          state.error = "Muse browser sign-in requires the Muse CLI. Install Muse on this execution host and ensure muse is on Paperclip's PATH, then start sign-in again.";
          throw new Error("Browser login runtime unavailable");
        }
      }
      if (controller.signal.aborted) throw new Error("Local sign-in cancelled before launch");
      const env = { ...process.env,
        ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CODE_OAUTH_TOKEN: "",
        OPENAI_API_KEY: "", CODEX_API_KEY: "",
        CLAUDE_CONFIG_DIR: provider === "anthropic" ? home : process.env.CLAUDE_CONFIG_DIR,
        CODEX_HOME: provider === "openai" ? home : process.env.CODEX_HOME,
        ...(provider === "muse" ? {
          // MUSE_AUTH_PATH is launcher-only; the native CLI uses XDG paths.
          HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"),
          XDG_DATA_HOME: path.join(home, ".local", "share"),
          META_API_KEY: "", MUSE_API_KEY: "", MUSE_AUTH_PATH: path.join(home, ".config", "muse", "auth.json"),
          MUSE_NO_AUTO_UPDATE: "1", NO_COLOR: "1",
        } : {}),
        BROWSER: "true",
      };
      return new Promise((resolve, reject) => {
        child = spawn("python3", ["-u", "-c", PYTHON_PTY_BRIDGE, executable, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
        child.stdout.on("data", (bytes: Buffer) => onData(bytes.toString("utf8")));
        // Provider output may contain secrets. Never log or retain stderr.
        child.stderr.resume();
        child.once("error", () => {
          state.error = "Browser sign-in requires Python 3 and a working local terminal. Install Python 3 on this execution host, then start sign-in again.";
          reject(new Error("Browser login terminal unavailable"));
        });
        child.once("close", (exitCode) => resolve({ exitCode }));
      });
    },
    write(input: string) { child?.stdin.write(input); },
    stop() { child?.kill("SIGTERM"); },
    async dispose() { child?.kill("SIGTERM"); },
    async readFile(file: string) { const { readLocalAiCredentialFile } = await import("./local-ai-credential-file.js"); return Buffer.from(await readLocalAiCredentialFile(file)); },
  };
  if (provider === "anthropic") {
    let deliverCode: ((code: string) => void) | undefined;
    const codeReady = new Promise<string>((resolve) => { deliverCode = resolve; });
    state.submitCode = (code) => { deliverCode?.(code); deliverCode = undefined; };
    void runSetupTokenLogin(driver, {
      timeoutMs: 300_000, signal: controller.signal,
      onPrompt: (prompt) => { state.authorizationUrl = prompt.url; },
      provideCode: (signal) => new Promise<string>((resolve, reject) => {
        const abort = () => reject(new Error("Local sign-in cancelled"));
        if (signal.aborted) { abort(); return; }
        signal.addEventListener("abort", abort, { once: true });
        codeReady.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
      }),
      onCredential: async (bytes) => {
        const file = await open(path.join(home, ".credentials.json"),
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try {
          await file.writeFile(JSON.stringify({ claudeAiOauth: { accessToken: bytes.toString("utf8") } }));
        } finally {
          await file.close();
        }
      },
    }).then((result) => { state.outcome = result.outcome === "success" ? "success" : "failure"; })
      .catch(() => { state.outcome = "failure"; });
  } else if (provider === "muse") {
    // Parse only the launcher's documented prompts, never store/log its raw
    // transcript (which can contain credentials). The ordinary credential
    // verifier remains authoritative for promoting the completed attempt.
    let line = "";
    let phase: "idle" | "url" | "label" | "code" | "done" = "idle";
    let candidateUrl: string | undefined;
    let invalid = false;
    const nativeFailures = {
      access_denied: "Meta did not approve this sign-in. Start sign-in again and approve the device code.",
      expired: "The Meta approval code expired. Start sign-in again.",
      mint_failed: "Meta could not issue a Muse credential for this account. Check that the account has an active Muse Code subscription.",
      flow_failed: "Meta could not complete browser sign-in. Start sign-in again.",
      store_failed: "Muse could not save the approved account on this host. Paperclip\'s private credential storage needs fixing.",
    } as const;
    const fail = () => {
      invalid = true;
      state.authorizationUrl = undefined;
      state.code = undefined;
      state.error = "Muse returned an unexpected sign-in prompt. Start sign-in again.";
      driver.stop();
    };
    const onLine = (raw: string) => {
      const text = raw.replace(/\x1b\[[0-9;]*m/g, "").trim();
      if (!text || invalid) return;
      const failure = /(?:^|[^a-z_])(access_denied|expired|mint_failed|flow_failed|store_failed)(?:$|[^a-z_])/.exec(text.toLowerCase());
      if (failure) state.error = nativeFailures[failure[1] as keyof typeof nativeFailures];
      if (phase === "idle" && text === "Open this page to sign in:") { phase = "url"; return; }
      if (phase === "url") {
        // Exact origin/path, no credentials, ports, redirects or arbitrary
        // query parameters. Do not expose a provider-supplied generic URL.
        if (!/^https:\/\/auth\.meta\.com\/oauth\/device\/?(?:\?(?:code|user_code)=[A-Z0-9]{4}-[A-Z0-9]{4})?$/.test(text)) { fail(); return; }
        candidateUrl = text;
        phase = "label";
      } else if (phase === "label") {
        if (!/^(?:confirm this code matches:|enter this code:)$/i.test(text)) { fail(); return; }
        phase = "code";
      } else if (phase === "code") {
        if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(text)) { fail(); return; }
        const embeddedCode = new URL(candidateUrl!).searchParams;
        const expected = embeddedCode.get("code") ?? embeddedCode.get("user_code");
        if (expected && expected !== text) { fail(); return; }
        state.authorizationUrl = candidateUrl;
        state.code = text;
        phase = "done";
      }
      // Completion is established from the private credential, not CLI prose.
    };
    const abort = () => { driver.stop(); };
    controller.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), 1_800_000);
    timer.unref();
    void driver.start("muse login", (chunk) => {
      for (const character of chunk) {
        if (character === "\n" || character === "\r") {
          onLine(line);
          line = "";
        } else {
          line += character;
          if (line.length > 4096) { line = ""; fail(); return; }
        }
      }
      // The launcher waits on /dev/tty before polling. Send terminal EOF to
      // skip its optional host-browser launch, only after validating the prompt.
      if (!invalid && phase === "done" && line.includes("Press Enter to open it in your browser:")) {
        driver.write("\x04");
        line = "";
      }
    }).then(async ({ exitCode }) => {
      if (line) onLine(line);
      if (invalid || controller.signal.aborted || exitCode !== 0 || phase !== "done") {
        state.outcome = "failure";
        state.error ??= controller.signal.aborted
          ? "Muse browser sign-in was cancelled or timed out. Start sign-in again."
          : `Muse browser sign-in stopped before an account was saved (exit ${exitCode ?? "interrupted"}). Start sign-in again.`;
        return;
      }
      try {
        // Native Muse prints "Logged in. Credential saved...", not the
        // launcher's "Signed in.". Neither message is proof of usable auth.
        await readVerifiedLocalAiCredential("muse", home);
        state.outcome = controller.signal.aborted ? "failure" : "success";
      } catch {
        state.error ??= "Muse did not save a verified OAuth subscription in this sign-in's private directory. Start sign-in again.";
        state.outcome = "failure";
      }
    }).catch(() => {
      state.error ??= "Muse browser sign-in could not run on this host. Start sign-in again.";
      state.outcome = "failure";
    })
      .finally(() => {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", abort);
        void driver.dispose();
        line = "";
      });
  } else {
    void runDeviceLogin(driver, {
      timeoutMs: 300_000, signal: controller.signal,
      onPrompt: (prompt) => { state.authorizationUrl = prompt.url; state.code = prompt.code; },
    }).then((result) => { state.outcome = result.outcome === "success" ? "success" : "failure"; })
      .catch(() => { state.outcome = "failure"; });
  }
  return state;
}
