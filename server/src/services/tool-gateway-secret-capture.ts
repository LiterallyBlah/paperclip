/**
 * Server-side secret capture for tool-gateway calls (fork feature, BLA-4049).
 *
 * A caller may ask the gateway to lift one string out of a provider result
 * (for example a freshly minted provider token) straight into a pending
 * secret proposal. The value never reaches the caller, the invocation rows,
 * call events, audit, the prompt-injection classifier or logs: the gateway
 * replaces it with a marker that names the proposal, before any of those
 * steps run. Board approval of the proposal stays the only way to turn it
 * into a usable company secret.
 *
 * This module holds the pure parts (directive parsing, JSON-pointer
 * extraction, scrubbing) and the authorization decision. The gateway service
 * owns sequencing.
 */
import type { Db } from "@paperclipai/db";
import { accessService } from "./access.js";
import type { AuthorizationActor } from "./authorization.js";
import { normalizeSecretKey } from "./secrets.js";

export const SECRET_CAPTURE_ERROR_CODE = "secret_capture_failed";
export const SECRET_CAPTURE_FORBIDDEN_CODE = "secret_capture_forbidden";
export const SECRET_CAPTURE_MARKER_PREFIX = "[paperclip-secret-proposal:";
export const SECRET_CAPTURE_MAX_VALUE_BYTES = 4096;
export const SECRET_CAPTURE_MIN_VALUE_LENGTH = 8;

// Mirrors the proposal service rules so a bad name fails before the provider
// mints anything.
const SECRET_NAME_RE = /^[^/\s]+(?:\/[^/\s]+)*$/;
const MAX_POINTER_LENGTH = 512;
const MAX_TEXT_FIELD_LENGTH = 2000;

export type SecretCaptureReason =
  | "invalid_directive"
  | "unsupported_tool"
  | "approval_flow_unsupported"
  | "replay_unsupported"
  | "provider_error"
  | "json_parse_failed"
  | "pointer_not_found"
  | "value_not_string"
  | "value_empty"
  | "value_too_short"
  | "value_too_large"
  | "proposal_failed"
  | "scrub_failed";

export type SecretCaptureDenialReason =
  | "agent_credential_required"
  | "company_mismatch"
  | "agent_mismatch"
  | "run_mismatch"
  | "credential_class_refused"
  | "issue_scope_required"
  | "issue_scope_denied"
  | "propose_denied";

export type SecretCaptureDirective = {
  /** RFC 6901 JSON pointer into the selected result document. */
  pointer: string;
  /** Which part of the provider result the pointer applies to. */
  source: "structuredContent" | "contentText";
  /** For contentText: the index into the MCP `content` array. */
  contentIndex: number;
  proposal: {
    name: string;
    key: string | null;
    description: string | null;
    justification: string;
  };
};

/** Raised for malformed directives and for every post-dispatch failure. */
export class SecretCaptureFailure extends Error {
  constructor(readonly reason: SecretCaptureReason) {
    super("Secret capture failed");
    this.name = "SecretCaptureFailure";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedText(value: unknown, required: boolean): string | null {
  if (value === undefined || value === null) {
    if (required) throw new SecretCaptureFailure("invalid_directive");
    return null;
  }
  if (typeof value !== "string") throw new SecretCaptureFailure("invalid_directive");
  const trimmed = value.trim();
  if (trimmed.length > MAX_TEXT_FIELD_LENGTH) throw new SecretCaptureFailure("invalid_directive");
  if (!trimmed) {
    if (required) throw new SecretCaptureFailure("invalid_directive");
    return null;
  }
  return trimmed;
}

/** Decodes an RFC 6901 pointer. Only non-empty pointers are accepted. */
export function parseJsonPointer(pointer: string): string[] {
  if (!pointer.startsWith("/") || pointer.length > MAX_POINTER_LENGTH) {
    throw new SecretCaptureFailure("invalid_directive");
  }
  return pointer.slice(1).split("/").map((token) => {
    if (/~[^01]|~$/.test(token)) throw new SecretCaptureFailure("invalid_directive");
    return token.replace(/~1/g, "/").replace(/~0/g, "~");
  });
}

export function parseSecretCaptureDirective(raw: unknown): SecretCaptureDirective {
  const record = asRecord(raw);
  if (!record) throw new SecretCaptureFailure("invalid_directive");
  const allowed = new Set(["pointer", "source", "contentIndex", "proposal"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new SecretCaptureFailure("invalid_directive");
  if (typeof record.pointer !== "string") throw new SecretCaptureFailure("invalid_directive");
  parseJsonPointer(record.pointer);
  const source = record.source ?? "contentText";
  if (source !== "structuredContent" && source !== "contentText") throw new SecretCaptureFailure("invalid_directive");
  const contentIndex = record.contentIndex ?? 0;
  if (typeof contentIndex !== "number" || !Number.isInteger(contentIndex) || contentIndex < 0 || contentIndex > 64) {
    throw new SecretCaptureFailure("invalid_directive");
  }
  if (source === "structuredContent" && record.contentIndex !== undefined) throw new SecretCaptureFailure("invalid_directive");
  const proposal = asRecord(record.proposal);
  if (!proposal) throw new SecretCaptureFailure("invalid_directive");
  const proposalAllowed = new Set(["name", "key", "description", "justification"]);
  if (Object.keys(proposal).some((key) => !proposalAllowed.has(key))) throw new SecretCaptureFailure("invalid_directive");
  const name = boundedText(proposal.name, true)!;
  if (!SECRET_NAME_RE.test(name)) throw new SecretCaptureFailure("invalid_directive");
  const key = boundedText(proposal.key, false);
  if (!normalizeSecretKey(key || name.split("/").at(-1) || "")) throw new SecretCaptureFailure("invalid_directive");
  return {
    pointer: record.pointer,
    source,
    contentIndex,
    proposal: {
      name,
      key,
      description: boundedText(proposal.description, false),
      justification: boundedText(proposal.justification, true)!,
    },
  };
}

/** What audit and call events may record about a directive. */
export function secretCaptureAuditSummary(directive: SecretCaptureDirective) {
  return {
    pointer: directive.pointer,
    source: directive.source,
    ...(directive.source === "contentText" ? { contentIndex: directive.contentIndex } : {}),
    proposalName: directive.proposal.name,
    proposalKey: directive.proposal.key ?? normalizeSecretKey(directive.proposal.name.split("/").at(-1) || ""),
  };
}

function resolvePointer(document: unknown, tokens: string[]): { found: true; value: unknown } | { found: false } {
  let current: unknown = document;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return { found: false };
      const index = Number(token);
      if (index >= current.length) return { found: false };
      current = current[index];
      continue;
    }
    const record = asRecord(current);
    if (!record || !Object.prototype.hasOwnProperty.call(record, token)) return { found: false };
    current = record[token];
  }
  return { found: true, value: current };
}

/**
 * Extracts the captured string from a gateway-normalized provider result.
 * MCP results carry `data.content` (the provider's content array) and
 * `data.structuredContent`; native REST results carry `content` (JSON text)
 * and `data.structuredContent`.
 */
export function extractCapturedValue(result: unknown, directive: SecretCaptureDirective): string {
  const record = asRecord(result);
  if (!record || record.error !== undefined) throw new SecretCaptureFailure("provider_error");
  const data = asRecord(record.data);
  if (data?.isError === true) throw new SecretCaptureFailure("provider_error");
  let document: unknown;
  if (directive.source === "structuredContent") {
    if (!data || data.structuredContent === undefined || data.structuredContent === null) {
      throw new SecretCaptureFailure("pointer_not_found");
    }
    document = data.structuredContent;
  } else {
    const items = Array.isArray(data?.content)
      ? data!.content as unknown[]
      : typeof record.content === "string" ? [{ type: "text", text: record.content }] : [];
    const item = asRecord(items[directive.contentIndex]);
    if (!item || typeof item.text !== "string") throw new SecretCaptureFailure("pointer_not_found");
    try {
      document = JSON.parse(item.text);
    } catch {
      throw new SecretCaptureFailure("json_parse_failed");
    }
  }
  const resolved = resolvePointer(document, parseJsonPointer(directive.pointer));
  if (!resolved.found) throw new SecretCaptureFailure("pointer_not_found");
  if (typeof resolved.value !== "string") throw new SecretCaptureFailure("value_not_string");
  const value = resolved.value;
  if (value.length === 0) throw new SecretCaptureFailure("value_empty");
  if (Buffer.byteLength(value, "utf8") > SECRET_CAPTURE_MAX_VALUE_BYTES) throw new SecretCaptureFailure("value_too_large");
  // Very short strings would scrub unrelated text and are never provider tokens.
  if (value.trim().length < SECRET_CAPTURE_MIN_VALUE_LENGTH) throw new SecretCaptureFailure("value_too_short");
  return value;
}

/** The literal and JSON-escaped forms a value can take inside the result. */
function valueForms(value: string): string[] {
  const escaped = JSON.stringify(value).slice(1, -1);
  const forms = new Set([value, escaped]);
  return [...forms].filter((form) => form.length > 0).sort((a, b) => b.length - a.length);
}

function scrubText(text: string, forms: string[], marker: string) {
  return forms.reduce((current, form) => current.split(form).join(marker), text);
}

function scrubValue(input: unknown, forms: string[], marker: string): unknown {
  if (typeof input === "string") return scrubText(input, forms, marker);
  if (Array.isArray(input)) return input.map((item) => scrubValue(item, forms, marker));
  const record = asRecord(input);
  if (!record) return input;
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [
    scrubText(key, forms, marker),
    scrubValue(value, forms, marker),
  ]));
}

export function secretCaptureMarker(proposalId: string) {
  return `${SECRET_CAPTURE_MARKER_PREFIX}${proposalId}]`;
}

/**
 * Replaces every occurrence of the value (the captured location and any
 * duplicate, in literal or JSON-escaped form) with the marker, then proves
 * the value is gone from the serialized result.
 */
export function scrubCapturedValue<T>(result: T, value: string, marker: string): T {
  const forms = valueForms(value);
  const scrubbed = scrubValue(result, forms, marker) as T;
  const serialized = JSON.stringify(scrubbed) ?? "";
  if (forms.some((form) => serialized.includes(form))) {
    throw new SecretCaptureFailure("scrub_failed");
  }
  return scrubbed;
}

export type SecretCaptureSessionScope = {
  companyId: string;
  agentId: string | null;
  runId: string | null;
  issueId: string | null;
};

/**
 * Decides whether the authenticated Paperclip caller may capture a secret
 * through this gateway session. The gateway session token alone is never
 * enough: the caller must present its own agent credential, bound to the
 * same company, agent and run as the session.
 *
 * - Run-bound agent JWTs (claude_local and similar) use the ordinary
 *   `secrets:propose` decision, exactly as `/agents/me/secret-proposals`.
 * - Agent API keys (hermes_gateway hosts, including task_bridge keys) must
 *   name the session's run, must be allowed to mutate the session's origin
 *   issue under their own key scope (task_bridge boundaries apply here), and
 *   the agent principal must hold `secrets:propose` under standard trust
 *   rules (low-trust agents stay refused). Only the provider's own response
 *   can become the proposed value, and board approval remains the gate.
 * - Skill-test tokens and every other credential class are refused.
 */
export async function decideSecretCapture(
  db: Db,
  actor: AuthorizationActor | null | undefined,
  session: SecretCaptureSessionScope,
): Promise<{ allowed: true } | { allowed: false; reason: SecretCaptureDenialReason }> {
  if (!actor || actor.type !== "agent" || !actor.agentId || !actor.companyId) {
    return { allowed: false, reason: "agent_credential_required" };
  }
  if (actor.companyId !== session.companyId) return { allowed: false, reason: "company_mismatch" };
  if (!session.agentId || actor.agentId !== session.agentId) return { allowed: false, reason: "agent_mismatch" };
  if (!session.runId || !actor.runId || actor.runId !== session.runId) return { allowed: false, reason: "run_mismatch" };
  const scopeKind = actor.keyScope?.kind ?? "standard";
  if (scopeKind === "skill_test") return { allowed: false, reason: "credential_class_refused" };
  const access = accessService(db);
  const propose = (decisionActor: AuthorizationActor) => access.decide({
    actor: decisionActor,
    action: "secrets:propose",
    resource: { type: "company", companyId: session.companyId },
  });

  if (actor.source === "agent_jwt" && scopeKind === "standard") {
    const decision = await propose(actor);
    return decision.allowed ? { allowed: true } : { allowed: false, reason: "propose_denied" };
  }
  if (actor.source === "agent_key") {
    if (!session.issueId) return { allowed: false, reason: "issue_scope_required" };
    const issueWrite = await access.decide({
      actor,
      action: "issue:mutate",
      resource: { type: "issue", companyId: session.companyId, issueId: session.issueId },
    });
    if (!issueWrite.allowed) return { allowed: false, reason: "issue_scope_denied" };
    const decision = await propose({ ...actor, keyScope: { kind: "standard" } });
    return decision.allowed ? { allowed: true } : { allowed: false, reason: "propose_denied" };
  }
  return { allowed: false, reason: "credential_class_refused" };
}
