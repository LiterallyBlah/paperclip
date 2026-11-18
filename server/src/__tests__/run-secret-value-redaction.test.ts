import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { createAgentIdentityRedactor, runSecretEnvValues, runSecretRedactionForms } from "../services/agent-identity-redaction.js";
import { createHeartbeatRunOutput } from "../services/heartbeat/run-output.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import { AI_AUTH_ENV_KEYS, AI_CONFIG_ENV_KEYS } from "../services/ai-connection-runtime.js";

// Synthetic fixtures only. None of these is, or resembles, a real credential.
const BOUND_SECRET = 'synthetic-bound-"quoted"\\value-0001';
const BOUND_URL = "postgres://fixture:synthetic-db-pass-0002@db.example.invalid/app";
const BROKER_TOKEN = "synthetic-broker-value-0003-abcdefgh";
const RUN_API_KEY = "synthetic-run-api-value-0004-abcdefgh";
const TOOLS_TOKEN = "synthetic-tools-value-0005-abcdefgh";

const env = {
  CUSTOMER_SETTING: BOUND_SECRET,
  CUSTOMER_DB_URL: BOUND_URL,
  PAPERCLIP_GITHUB_BROKER_TOKEN: BROKER_TOKEN,
  FEATURE_FLAG: "true",
  WORKER_COUNT: "5432",
  SHORT_SETTING: "abc1234",
  PUBLIC_SETTING: "not-a-declared-secret-value",
};
const secretKeys = new Set(["CUSTOMER_SETTING", "CUSTOMER_DB_URL", "PAPERCLIP_GITHUB_BROKER_TOKEN", "FEATURE_FLAG", "WORKER_COUNT", "SHORT_SETTING"]);
const classes = {
  bound: { name: "CUSTOMER_SETTING", value: BOUND_SECRET },
  boundUrl: { name: "CUSTOMER_DB_URL", value: BOUND_URL },
  broker: { name: "PAPERCLIP_GITHUB_BROKER_TOKEN", value: BROKER_TOKEN },
  apiKey: { name: "PAPERCLIP_API_KEY", value: RUN_API_KEY },
  tools: { name: "PAPERCLIP_RUNTIME_TOOLS_TOKEN", value: TOOLS_TOKEN },
};

function forms(name: string, value: string) {
  return {
    keyValue: `${name}=${value}\n`,
    json: `${JSON.stringify({ [name]: value })}\n`,
    jsonEscaped: `escaped: ${JSON.stringify(value).slice(1, -1)}\n`,
    bare: `value ${value} end\n`,
    url: `https://hooks.example.invalid/callback?code=${value}&x=1\n`,
  };
}

function plaintextFragments(value: string) {
  const escaped = JSON.stringify(value).slice(1, -1);
  const half = Math.floor(value.length / 2);
  return [value, escaped, value.slice(0, half), value.slice(half)];
}

function fakeDb() {
  const chain: Record<string, unknown> = {};
  chain.set = () => chain;
  chain.where = async () => [];
  return { update: () => chain } as unknown as Db;
}

function prepareRedactor() {
  const redactor = createAgentIdentityRedactor();
  redactor.add(runSecretEnvValues(env, secretKeys));
  redactor.add([RUN_API_KEY]);
  redactor.add([TOOLS_TOKEN, undefined, null]);
  return redactor;
}

async function startOutput(redactor = prepareRedactor(), declaredKeys: Set<string> = secretKeys) {
  const companyId = randomUUID();
  const runId = randomUUID();
  const run = { id: runId, companyId, agentId: randomUUID(), status: "running", lastOutputSeq: 0, logBytes: 0, lastOutputAt: null } as never;
  const stored: Array<{ stream: string; chunk: string }> = [];
  const live: Array<{ stream: string; chunk: string }> = [];
  const events: Array<{ eventType: string; payload?: Record<string, unknown>; message?: string }> = [];
  const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
    if (event.type === "heartbeat.run.log") live.push(event.payload as { stream: string; chunk: string });
  });
  const output = createHeartbeatRunOutput(fakeDb(), {
    run, runId, issueId: null,
    runLogStore: {
      begin: async () => ({ store: "local_file", logRef: "fixture" }),
      append: async (_handle, entry) => { stored.push({ stream: entry.stream, chunk: entry.chunk }); return entry.chunk.length; },
    } as never,
    identityRedactor: redactor,
    secretKeys: declaredKeys,
    appendRunEvent: (async (_run: unknown, event: { eventType: string; payload?: Record<string, unknown>; message?: string }) => { events.push(event); }) as never,
    getCurrentUserRedactionOptions: async () => ({ enabled: false, replacement: "*" }) as never,
  });
  const handlers = await output.begin(run);
  const finish = async () => {
    for (const stream of ["stdout", "stderr"] as const) {
      const tail = redactor.finish(stream);
      if (tail) await handlers.appendIdentityRedactedLog(stream, tail);
    }
    unsubscribe();
  };
  return { redactor, handlers, stored, live, events, finish };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("run secret value redaction", () => {
  it("collects only declared, non-trivial secret values with their JSON-escaped forms", () => {
    const redactor = prepareRedactor();
    expect(redactor.values).toEqual(expect.arrayContaining([
      BOUND_SECRET, JSON.stringify(BOUND_SECRET).slice(1, -1), BOUND_URL, BROKER_TOKEN, RUN_API_KEY, TOOLS_TOKEN,
    ]));
    for (const ignored of ["true", "5432", "abc1234", env.PUBLIC_SETTING]) expect(redactor.values).not.toContain(ignored);
    expect(new Set(redactor.values).size).toBe(redactor.values.length);
    expect([...redactor.values].sort((a, b) => b.length - a.length)).toEqual(redactor.values);
    expect(runSecretRedactionForms(["FALSE", "-12.5", "  short  ", 12345678, "1234567890"])).toEqual([]);
  });

  for (const stream of ["stdout", "stderr"] as const) {
    for (const [className, { name, value }] of Object.entries(classes)) {
      it(`masks ${className} values on ${stream} in every form, including split chunks`, async () => {
        const { handlers, stored, live, events, finish } = await startOutput();
        for (const text of Object.values(forms(name, value))) await handlers.onLog(stream, text);
        for (const text of Object.values(forms(name, value))) {
          const cut = Math.floor(text.length / 2);
          await handlers.onLog(stream, text.slice(0, cut));
          await handlers.onLog(stream, text.slice(cut));
        }
        await handlers.onAdapterMeta?.({
          adapterType: "process", command: "fixture", commandArgs: [`--value=${value}`],
          env: { [name]: value, OTHER_SETTING: `prefix-${value}` }, prompt: `prompt ${value}`,
          context: { nested: { value } },
        });
        await handlers.onAdapterEvent({ eventType: "fixture.output", stream, level: "info", message: `event ${value}`, payload: { output: value, url: `https://x.example.invalid/?v=${value}` } });
        await finish();

        const storedText = stored.map(entry => entry.chunk).join("");
        const liveText = live.map(entry => entry.chunk).join("");
        expect(stored.length).toBeGreaterThan(0);
        expect(live.length).toBe(stored.length);
        expect(stored.every(entry => entry.stream === stream)).toBe(true);
        const meta = events.find(event => event.eventType === "adapter.invoke");
        const adapterEvent = events.find(event => event.eventType === "fixture.output");
        expect(meta).toBeTruthy();
        expect(adapterEvent).toBeTruthy();
        for (const [label, text] of Object.entries({ storedText, liveText, meta: JSON.stringify(meta), adapterEvent: JSON.stringify(adapterEvent) })) {
          for (const fragment of plaintextFragments(value)) expect(text, `${label} leaked part of ${className}`).not.toContain(fragment);
        }
        expect(storedText).toContain("***REDACTED***");
      });
    }
  }

  it("masks managed AI credentials but not model, endpoint or config-home values", async () => {
    const managedEnv: Record<string, string> = {
      ANTHROPIC_API_KEY: "synthetic-provider-value-0006-abcdefgh",
      PAPERCLIP_AI_PROVIDER_KEY: "synthetic-routing-value-0007-abcdefgh",
      ANTHROPIC_MODEL: "synthetic-model-x1",
      ANTHROPIC_BASE_URL: "https://gateway.example.invalid/v1",
      CLAUDE_CONFIG_DIR: "/fixture/synthetic/claude-config",
      CODEX_HOME: "/fixture/synthetic/codex-home",
    };
    const managedKeys = new Set<string>(AI_AUTH_ENV_KEYS);
    const redactor = createAgentIdentityRedactor();
    redactor.add(runSecretEnvValues(managedEnv, managedKeys, new Set(AI_CONFIG_ENV_KEYS)));
    expect(redactor.values).toEqual(expect.arrayContaining([managedEnv.ANTHROPIC_API_KEY, managedEnv.PAPERCLIP_AI_PROVIDER_KEY]));
    for (const key of ["ANTHROPIC_MODEL", "ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) {
      expect(redactor.values).not.toContain(managedEnv[key]);
    }

    const { handlers, stored, events, finish } = await startOutput(redactor, managedKeys);
    const config = `${JSON.stringify({ type: "system", model: managedEnv.ANTHROPIC_MODEL, url: managedEnv.ANTHROPIC_BASE_URL })}\n` +
      `transcript ${managedEnv.CLAUDE_CONFIG_DIR}/projects/a.jsonl\n`;
    await handlers.onLog("stdout", config);
    await handlers.onLog("stdout", `key ${managedEnv.ANTHROPIC_API_KEY} route ${managedEnv.PAPERCLIP_AI_PROVIDER_KEY}\n`);
    await handlers.onAdapterMeta?.({ adapterType: "claude_local", command: "fixture", env: managedEnv, prompt: "fixture" });
    await finish();
    const storedText = stored.map(entry => entry.chunk).join("");
    expect(storedText.startsWith(config)).toBe(true);
    expect(storedText).not.toContain(managedEnv.ANTHROPIC_API_KEY);
    expect(storedText).not.toContain(managedEnv.PAPERCLIP_AI_PROVIDER_KEY);
    // Names stay masked in the invoke env, as before value registration.
    expect(JSON.stringify(events.find(event => event.eventType === "adapter.invoke"))).not.toContain(managedEnv.ANTHROPIC_MODEL);

    const adapterResult = {
      model: managedEnv.ANTHROPIC_MODEL,
      sessionParams: { transcript: `${managedEnv.CLAUDE_CONFIG_DIR}/projects/a.jsonl`, home: managedEnv.CODEX_HOME },
    };
    expect(redactor.redact(adapterResult)).toEqual(adapterResult);
  });

  it("leaves short, boolean and numeric env values and ordinary output unchanged", async () => {
    const { handlers, stored, live, finish } = await startOutput();
    const text = "FEATURE_FLAG=true WORKER_COUNT=5432 SHORT_SETTING=abc1234 PUBLIC_SETTING=not-a-declared-secret-value done-\n";
    await handlers.onLog("stdout", text);
    await handlers.onLog("stderr", "ordinary synthetic- prefix");
    await finish();
    expect(stored.filter(entry => entry.stream === "stdout").map(entry => entry.chunk).join("")).toBe(text);
    expect(live.filter(entry => entry.stream === "stderr").map(entry => entry.chunk).join("")).toBe("ordinary synthetic- prefix");
  });
});
