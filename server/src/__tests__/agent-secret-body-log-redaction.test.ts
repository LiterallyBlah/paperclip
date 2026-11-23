import { Writable } from "node:stream";
import express from "express";
import pino from "pino";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { HttpError } from "../errors.js";
import { errorHandler } from "../middleware/error-handler.js";
import { HTTP_LOG_REDACT_PATHS } from "../middleware/http-log-redaction.js";
import {
  isAgentSecretValueBodyHttpRequest,
  isSecretSensitiveHttpRequest,
} from "../middleware/http-log-policy.js";
import { createHttpLogger } from "../middleware/logger.js";

// Agent-callable routes that accept secret material in the request body. The
// HTTP logger must not copy any part of such a body, because a value placed in
// an unknown field cannot be found by key-name redaction.
const VALUE_CANARY = "fixture-secret-value-canary";
const EXTRA_CANARY = "fixture-unknown-field-canary";

type Outcome = "accepted" | "rejected-with-error-context" | "rejected-direct";

function buildApp(outcome: Outcome, chunks: string[]) {
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  const app = express();
  app.use(createHttpLogger(pino({ redact: [...HTTP_LOG_REDACT_PATHS] }, stream)));
  app.use(express.json());
  const handler: express.RequestHandler = (_req, res, next) => {
    if (outcome === "accepted") {
      res.status(200).json({ ok: true });
      return;
    }
    if (outcome === "rejected-with-error-context") {
      next(new HttpError(422, "Unexpected field"));
      return;
    }
    // A handler that rejects without the shared error handler leaves no error
    // context, so the logger falls back to the parsed request body.
    res.status(422).json({ error: "Unexpected field" });
  };
  app.post("/api/agents/me/secrets/:key/rotate", handler);
  app.post("/api/agents/me/secret-proposals", handler);
  app.use(errorHandler);
  return app;
}

function parseLogs(chunks: string[]) {
  return chunks.flatMap((chunk) =>
    chunk
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  );
}

describe("agent secret-value routes drop the whole request body from HTTP logs", () => {
  const routes = [
    ["rotate", "/api/agents/me/secrets/dummy_key/rotate", { value: VALUE_CANARY, extra: EXTRA_CANARY }],
    ["rotate upper case", "/API/AGENTS/ME/SECRETS/dummy_key/ROTATE", { value: VALUE_CANARY, extra: EXTRA_CANARY }],
    [
      "secret proposal",
      "/api/agents/me/secret-proposals",
      { kind: "secret", name: "Fixture", key: "fixture_key", value: VALUE_CANARY, extra: EXTRA_CANARY },
    ],
    ["secret proposal upper case", "/API/AGENTS/ME/SECRET-PROPOSALS", { kind: "secret", value: VALUE_CANARY, extra: EXTRA_CANARY }],
  ] as const;
  const outcomes: Outcome[] = ["accepted", "rejected-with-error-context", "rejected-direct"];

  for (const [name, path, body] of routes) {
    it.each(outcomes)(`${name}: %s request logs neither field value`, async (outcome) => {
      const chunks: string[] = [];
      const response = await request(buildApp(outcome, chunks)).post(path).send(body);
      expect(response.status).toBe(outcome === "accepted" ? 200 : 422);
      await new Promise((resolve) => setImmediate(resolve));

      const output = chunks.join("");
      expect(output).not.toContain(VALUE_CANARY);
      expect(output).not.toContain(EXTRA_CANARY);

      const logs = parseLogs(chunks);
      expect(logs).toHaveLength(1);
      const [line] = logs;
      if (outcome === "accepted") {
        expect(line).not.toHaveProperty("reqBody");
      } else {
        expect(line.reqBody).toBe("[REDACTED]");
      }
    });
  }

  it("classifies the covered routes and leaves unrelated agent routes alone", () => {
    for (const url of [
      "/api/agents/me/secrets/dummy_key/rotate",
      "http://localhost/api/agents/me/secrets/dummy_key/rotate",
      "/api/agents/me/secrets/dummy_key/%72otate",
      "/api/agents/me/secret-proposals",
      "/api/agents/me/secret-proposals/",
      "/API/Agents/Me/Secret-Proposals?x=1",
      "HTTPS://LOCALHOST:3100/api/agents/me/secret-proposals",
      "/api/agents/me/%73ecret-proposals",
    ]) {
      expect(isAgentSecretValueBodyHttpRequest(url), url).toBe(true);
      expect(isSecretSensitiveHttpRequest("POST", url), url).toBe(true);
    }
    for (const url of [
      "/api/agents/me/inbox-lite",
      "/api/agents/me/secrets",
      "/api/agents/me/secret-proposals-extra",
      "/api/companies/company/secret-proposals",
    ]) {
      expect(isAgentSecretValueBodyHttpRequest(url), url).toBe(false);
    }
    expect(isAgentSecretValueBodyHttpRequest(undefined)).toBe(false);
  });
});
