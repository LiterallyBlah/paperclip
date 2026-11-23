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

type Outcome =
  | "accepted"
  | "rejected-http-error"
  | "failed-with-error-context"
  | "rejected-direct";

const EXPECTED_STATUS: Record<Outcome, number> = {
  accepted: 200,
  "rejected-http-error": 422,
  "failed-with-error-context": 500,
  "rejected-direct": 422,
};

type Handler = express.RequestHandler;

function outcomeHandler(outcome: Outcome): Handler {
  return (_req, res, next) => {
    if (outcome === "accepted") {
      res.status(200).json({ ok: true });
      return;
    }
    if (outcome === "rejected-http-error") {
      // A 4xx HttpError passes through the shared error handler but attaches
      // no error context, so the logger falls back to the parsed body.
      next(new HttpError(422, "Unexpected field"));
      return;
    }
    if (outcome === "failed-with-error-context") {
      // An unexpected error makes the shared error handler attach error
      // context, which carries its own copy of the request body.
      next(new Error("Unexpected failure"));
      return;
    }
    // A handler that rejects without the shared error handler.
    res.status(422).json({ error: "Unexpected field" });
  };
}

function buildApp(handler: Handler, chunks: string[]) {
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  const app = express();
  app.use(createHttpLogger(pino({ redact: [...HTTP_LOG_REDACT_PATHS] }, stream)));
  app.use(express.json());
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
  const outcomes = Object.keys(EXPECTED_STATUS) as Outcome[];

  for (const [name, path, body] of routes) {
    it.each(outcomes)(`${name}: %s request logs neither field value`, async (outcome) => {
      const chunks: string[] = [];
      const response = await request(buildApp(outcomeHandler(outcome), chunks)).post(path).send(body);
      expect(response.status).toBe(EXPECTED_STATUS[outcome]);
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
      if (outcome === "failed-with-error-context") {
        // Proves the error-context path ran and was reduced to a type marker.
        expect(line.errorContext).toEqual({ name: "Error" });
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
    }
    // Rotation was already response-sensitive; proposals must stay as before.
    expect(isSecretSensitiveHttpRequest("POST", "/api/agents/me/secrets/dummy_key/rotate")).toBe(true);
    expect(isSecretSensitiveHttpRequest("POST", "/api/agents/me/secret-proposals")).toBe(false);
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

  describe("secret-proposal error responses are unchanged", () => {
    const path = "/api/agents/me/secret-proposals";

    async function send(handler: Handler, body: Record<string, unknown>) {
      const chunks: string[] = [];
      const response = await request(buildApp(handler, chunks)).post(path).send(body);
      await new Promise((resolve) => setImmediate(resolve));
      const output = chunks.join("");
      expect(output).not.toContain(EXTRA_CANARY);
      const logs = parseLogs(chunks);
      expect(logs).toHaveLength(1);
      expect(logs[0]!.reqBody).toBe("[REDACTED]");
      return response;
    }

    it("keeps a 4xx message that shares a word with a submitted value", async () => {
      const response = await send(
        (_req, _res, next) => next(new HttpError(422, "Justification is required")),
        { kind: "secret", name: "fixture", key: "fixture", value: "required", justification: "", extra: EXTRA_CANARY },
      );
      expect(response.status).toBe(422);
      expect(response.body).toEqual({ error: "Justification is required" });
    });

    it("keeps a 5xx HttpError message and details", async () => {
      const response = await send(
        (_req, _res, next) => next(new HttpError(503, "Proposal store unavailable", { reason: "retry" })),
        { kind: "secret", value: VALUE_CANARY, extra: EXTRA_CANARY },
      );
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: "Proposal store unavailable", details: { reason: "retry" } });
    });
  });
});
