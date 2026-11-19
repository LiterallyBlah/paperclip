import type { PromptInjectionModelOutcome, PromptInjectionDetectorMetadata } from "@paperclipai/shared";
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { redactEventPayload, redactSensitiveText, REDACTED_EVENT_VALUE } from "../redaction.js";
import { deriveLocalEncryptedInstanceSecret, type LocalEncryptedKeyEnv } from "../secrets/local-encrypted-provider.js";

export class ToolContentValidationError extends Error {
  constructor(
    message: string,
    public readonly reasonCode: string,
    public readonly findings: string[],
    public readonly detectorMetadata?: PromptInjectionDetectorMetadata,
  ) {
    super(message);
  }
}

const PROMPT_INJECTION_PATTERNS: Array<{ code: string; re: RegExp }> = [
  { code: "ignore_previous_instructions", re: /\bignore\b.{0,40}\b(previous|above|earlier)\b.{0,40}\binstructions?\b/i },
  { code: "reveal_system_prompt", re: /\b(reveal|print|dump|show)\b.{0,40}\b(system|developer)\b.{0,20}\b(prompt|message|instructions?)\b/i },
  { code: "instruction_hijack", re: /\b(new|updated)\b.{0,20}\b(system|developer)\b.{0,20}\b(instructions?|message)\b/i },
  { code: "secret_exfiltration", re: /\b(exfiltrate|leak|steal|send)\b.{0,40}\b(secret|token|api[-_ ]?key|credential)s?\b/i },
];

type ToolActionSigningSecretEnv = LocalEncryptedKeyEnv & Partial<
  Record<"PAPERCLIP_TOOL_ACTION_SIGNING_SECRET" | "PAPERCLIP_AGENT_JWT_SECRET" | "BETTER_AUTH_SECRET", string | undefined>
>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableSerialize(nested)}`);
  return `{${entries.join(",")}}`;
}

function scanPromptInjection(value: unknown): string[] {
  const text = typeof value === "string" ? value : stableSerialize(value);
  return PROMPT_INJECTION_PATTERNS
    .filter((pattern) => pattern.re.test(text))
    .map((pattern) => pattern.code);
}

export class ToolActionSigningSecretMissingError extends Error {
  constructor(cause?: unknown) {
    super(
      "The tool action signing key could not be loaded. Restore this instance's secrets master key " +
        "or configure PAPERCLIP_TOOL_ACTION_SIGNING_SECRET; existing approvals require their original key.",
      { cause },
    );
    this.name = "ToolActionSigningSecretMissingError";
  }
}

// Creating an approval is a two-step insert/sign operation. Readers must allow
// a short window for the creator to attach the signature before treating a null
// signature as an abandoned, unapprovable request.
export const TOOL_ACTION_REQUEST_SIGNING_GRACE_MS = 2 * 60 * 1000;

export function resolveToolActionSigningSecret(env: ToolActionSigningSecretEnv = process.env as ToolActionSigningSecretEnv) {
  const secret = env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET?.trim();
  if (secret) return secret;
  try {
    // Existing deployments already persist this master key with their instance
    // data. Reuse its atomic publication and configured path, with a separate
    // derived key for tool actions; never fall back to auth keys or process RNG.
    return deriveLocalEncryptedInstanceSecret("tool-action-signing", env);
  } catch (cause) {
    throw new ToolActionSigningSecretMissingError(cause);
  }
}

function signingSecret(explicitSecret?: string) {
  const secret = explicitSecret?.trim();
  return secret || resolveToolActionSigningSecret();
}

export function canonicalToolArguments(value: unknown) {
  return stableSerialize(value ?? {});
}

export function hashToolValue(value: unknown) {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

export function toolRequestIdentityHash(value: unknown, explicitSigningSecret?: string) {
  const canonical = canonicalToolArguments(value);
  // Request identity must cover complete arguments, including secrets and text
  // omitted from audit previews. Key sensitive identities so persisted hashes
  // cannot be used to guess low-entropy passwords or configuration secrets.
  return containsSensitiveToolArguments(canonical)
    ? createHmac("sha256", signingSecret(explicitSigningSecret))
      .update("paperclip:tool-request-identity:v1\0").update(canonical).digest("hex")
    : createHash("sha256").update(canonical).digest("hex");
}

type SignedToolArgumentsEnvelope = { payload: string; signature: string };
const TOOL_ARGUMENTS_ENCRYPTION_CONTEXT = "paperclip:tool-action-arguments:v2:A256GCM";

function toolArgumentsEncryptionKey(secret: string) {
  // Separate the encryption key from the existing HS256 signing key. The
  // dedicated instance signing secret already supplies high-entropy key material.
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), TOOL_ARGUMENTS_ENCRYPTION_CONTEXT, 32));
}

function containsSensitiveToolArguments(canonicalArguments: string) {
  try {
    const value: unknown = JSON.parse(canonicalArguments);
    // Wrapping preserves recursive redaction for root arrays and strings too.
    const redacted = redactEventPayload({ value })?.value;
    return redactSensitiveText(stableSerialize(redacted)) !== stableSerialize(value);
  } catch {
    // Canonical arguments normally come from canonicalToolArguments. Never
    // persist an unparseable caller-supplied string as an unencrypted fallback.
    return true;
  }
}

function encodeEncryptedToolArguments(envelope: SignedToolArgumentsEnvelope, secret: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", toolArgumentsEncryptionKey(secret), iv);
  cipher.setAAD(Buffer.from(TOOL_ARGUMENTS_ENCRYPTION_CONTEXT));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(envelope), "utf8"), cipher.final()]);
  return Buffer.from(JSON.stringify({
    version: 2, alg: "A256GCM", iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"),
  }), "utf8").toString("base64url");
}

function decodeBase64Url(value: unknown): Buffer | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64url");
  return decoded.toString("base64url") === value ? decoded : null;
}

function readToolArgumentsEnvelope(signedArguments: string, explicitSecret?: string): SignedToolArgumentsEnvelope | null {
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(signedArguments, "base64url").toString("utf8")); }
  catch { return null; }
  if (!isPlainObject(parsed)) return null;
  if (parsed.version === 1 && parsed.alg === "HS256") {
    return typeof parsed.payload === "string" && typeof parsed.signature === "string"
      ? { payload: parsed.payload, signature: parsed.signature } : null;
  }
  if (parsed.version !== 2 || parsed.alg !== "A256GCM") return null;
  const iv = decodeBase64Url(parsed.iv), ciphertext = decodeBase64Url(parsed.ciphertext), tag = decodeBase64Url(parsed.tag);
  if (iv?.length !== 12 || !ciphertext?.length || tag?.length !== 16) return null;
  // Keep missing-key configuration failures distinct from invalid signatures,
  // matching the legacy reader and allowing callers to handle them as before.
  const secret = signingSecret(explicitSecret);
  try {
    const decipher = createDecipheriv("aes-256-gcm", toolArgumentsEncryptionKey(secret), iv);
    decipher.setAAD(Buffer.from(TOOL_ARGUMENTS_ENCRYPTION_CONTEXT));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const envelope: unknown = JSON.parse(plaintext.toString("utf8"));
    return isPlainObject(envelope) && typeof envelope.payload === "string" && typeof envelope.signature === "string"
      ? { payload: envelope.payload, signature: envelope.signature } : null;
  } catch {
    // Authentication failures must never include ciphertext or decrypted content
    // in errors, logs or an approval response.
    return null;
  }
}

export function signToolArguments(args: {
  invocationId: string;
  toolName: string;
  canonicalArguments: string;
  approvalSnapshot?: unknown;
  executionOnApprove?: boolean;
  identityContextId?: string;
  signingSecret?: string;
}) {
  const payloadValue: Record<string, unknown> = {
    invocationId: args.invocationId,
    toolName: args.toolName,
    canonicalArguments: args.canonicalArguments,
  };
  if (args.identityContextId) payloadValue.identityContextId = args.identityContextId;
  if (args.executionOnApprove === true) {
    payloadValue.executionOnApprove = true;
  }
  if (args.approvalSnapshot !== undefined) {
    payloadValue.approvalSnapshot = args.approvalSnapshot;
  }
  const payload = stableSerialize(payloadValue);
  const secret = signingSecret(args.signingSecret);
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  if (containsSensitiveToolArguments(args.canonicalArguments)) {
    return encodeEncryptedToolArguments({ payload, signature }, secret);
  }
  return Buffer.from(JSON.stringify({ version: 1, alg: "HS256", payload, signature }), "utf8").toString("base64url");
}

type ToolArgumentsSignatureInput = {
  signedArguments: string | null | undefined;
  invocationId: string;
  toolName: string;
  canonicalArguments: string;
  approvalSnapshot?: unknown;
  executionOnApprove?: boolean;
  identityContextId?: string;
  signingSecret?: string;
};

function verifyToolArgumentsEnvelope(parsed: SignedToolArgumentsEnvelope, input: ToolArgumentsSignatureInput) {
  const expectedPayloadValue: Record<string, unknown> = {
    invocationId: input.invocationId,
    toolName: input.toolName,
    canonicalArguments: input.canonicalArguments,
  };
  if (input.identityContextId) expectedPayloadValue.identityContextId = input.identityContextId;
  if (input.executionOnApprove !== undefined) {
    expectedPayloadValue.executionOnApprove = input.executionOnApprove;
  }
  if (input.approvalSnapshot !== undefined) {
    expectedPayloadValue.approvalSnapshot = input.approvalSnapshot;
  }
  const expectedPayload = stableSerialize(expectedPayloadValue);
  if (parsed.payload !== expectedPayload) return false;
  const expected = createHmac("sha256", signingSecret(input.signingSecret)).update(parsed.payload).digest("base64url");
  const left = Buffer.from(parsed.signature);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function verifyToolArgumentsSignature(input: ToolArgumentsSignatureInput) {
  if (!input.signedArguments) return false;
  const parsed = readToolArgumentsEnvelope(input.signedArguments, input.signingSecret);
  return parsed !== null && verifyToolArgumentsEnvelope(parsed, input);
}

export function readSignedToolArgumentsPayload(input: {
  signedArguments: string | null | undefined;
  invocationId: string;
  toolName: string;
  signingSecret?: string;
}): { arguments: unknown; approvalSnapshot?: unknown; executionOnApprove?: boolean; identityContextId?: string } | null {
  if (!input.signedArguments) return null;
  const parsed = readToolArgumentsEnvelope(input.signedArguments, input.signingSecret);
  if (!parsed) return null;
  let payload: {
    invocationId?: unknown;
    toolName?: unknown;
    canonicalArguments?: unknown;
    approvalSnapshot?: unknown;
    executionOnApprove?: unknown;
    identityContextId?: unknown;
  };
  try {
    payload = JSON.parse(parsed.payload);
  } catch {
    return null;
  }
  if (!isPlainObject(payload)) return null;
  if (payload.invocationId !== input.invocationId || payload.toolName !== input.toolName) return null;
  if (typeof payload.canonicalArguments !== "string") return null;
  if (!verifyToolArgumentsEnvelope(parsed, {
    signedArguments: input.signedArguments,
    invocationId: input.invocationId,
    toolName: input.toolName,
    canonicalArguments: payload.canonicalArguments,
    approvalSnapshot: payload.approvalSnapshot,
    executionOnApprove: payload.executionOnApprove === true ? true : undefined,
    identityContextId: typeof payload.identityContextId === "string" ? payload.identityContextId : undefined,
    signingSecret: input.signingSecret,
  })) {
    return null;
  }
  try {
    return {
      arguments: JSON.parse(payload.canonicalArguments) as unknown,
      ...(payload.approvalSnapshot !== undefined ? { approvalSnapshot: payload.approvalSnapshot } : {}),
      ...(payload.executionOnApprove === true ? { executionOnApprove: true } : {}),
      ...(typeof payload.identityContextId === "string" ? { identityContextId: payload.identityContextId } : {}),
    };
  } catch {
    return null;
  }
}

export function readSignedToolArguments(input: {
  signedArguments: string | null | undefined;
  invocationId: string;
  toolName: string;
  signingSecret?: string;
}) {
  return readSignedToolArgumentsPayload(input)?.arguments ?? null;
}

export function summarizeToolValue(value: unknown) {
  const redacted = isPlainObject(value) ? redactEventPayload(value) : value;
  const serialized = stableSerialize(redacted);
  const redactedText = redactSensitiveText(serialized);
  return {
    summary: redactedText.length > 4000 ? `${redactedText.slice(0, 3997)}...` : redactedText,
    sizeBytes: Buffer.byteLength(serialized, "utf8"),
    sha256: createHash("sha256").update(serialized).digest("hex"),
    redactedFields: redactedText.includes(REDACTED_EVENT_VALUE) ? ["sensitive_value"] : [],
  };
}

/**
 * LR-2: the persisted summary of a tool *result* carries no result content.
 * Size, hash and redacted-field markers are computed exactly as in
 * summarizeToolValue; only the content `summary` becomes a fixed marker.
 * Argument summaries keep the summarizeToolValue form.
 */
export function summarizeToolResultValue(value: unknown): ReturnType<typeof summarizeToolValue> {
  const full = summarizeToolValue(value);
  return { ...full, summary: `[content omitted: ${full.sizeBytes} bytes]` };
}

type PromptInjectionDetection = { findings: string[]; detectorMetadata: PromptInjectionDetectorMetadata };

async function detectPromptInjection(
  value: unknown,
  classifier?: (content: string) => Promise<PromptInjectionModelOutcome>,
): Promise<PromptInjectionDetection> {
  const redactedValue = isPlainObject(value) ? redactEventPayload(value) : value;
  // Wrapping allows the existing recursive redactor to handle root arrays and
  // strings, without changing the tool return value or its historical hash.
  const outbound = redactSensitiveText(stableSerialize(redactEventPayload({ value })?.value));
  // A verdict cannot cover text hidden from the model but still delivered to
  // the caller by the legacy return contract. Fall back before dispatch, so a
  // secret-named field cannot conceal instructions behind a safe verdict.
  const outcome: PromptInjectionModelOutcome | undefined = classifier
    ? outbound !== stableSerialize(redactedValue)
      ? { status: "unavailable", reason: "input_redaction_mismatch" }
      : await classifier(outbound)
    : undefined;
  if (outcome?.status === "classified") {
    return {
      findings: outcome.findings,
      detectorMetadata: { detector: "model", model: outcome.model, invocationId: outcome.invocationId, policyVersion: outcome.policyVersion },
    };
  }
  return {
    findings: scanPromptInjection(value),
    detectorMetadata: { detector: "regex", ...(outcome ? { fallbackReason: outcome.reason, model: outcome.model, invocationId: outcome.invocationId } : {}) },
  };
}

/** MCP content-block metadata key a connector may set to name the item a block carries (for example a message id). */
export const TOOL_RESULT_ITEM_REF_META_KEY = "paperclip.ing/item-ref";
const ITEM_REF_PATTERN = /^[A-Za-z0-9._:@-]{1,128}$/;

export type WithheldToolResultItem = { index: number; ref?: string; findings: string[] };

function isMcpContentBlock(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value) || typeof value.type !== "string") return false;
  return value.type !== "text" || typeof value.text === "string";
}

/** Same text join as the gateway's MCP result normalizer. */
function joinMcpContentBlocks(blocks: Record<string, unknown>[]) {
  return blocks.map((block) => (block.type === "text" ? block.text as string : JSON.stringify(block))).join("\n");
}

type ToolResultItemList = {
  blocks: Record<string, unknown>[];
  /** Everything in the result except the item blocks and the text derived from them. */
  outside: unknown;
  rebuild: (blocks: Record<string, unknown>[]) => Record<string, unknown>;
};

/**
 * Recognises the two result shapes with real item boundaries: a raw MCP result
 * (`{ content: Block[] }`) and the gateway's normalized MCP result
 * (`{ content: joinedText, data: { content: Block[], ... } }`, where the text
 * must be exactly the join of the blocks). Any other shape has no item list.
 */
function toolResultItemList(value: unknown): ToolResultItemList | null {
  if (!isPlainObject(value)) return null;
  const isBlockList = (blocks: unknown): blocks is Record<string, unknown>[] =>
    Array.isArray(blocks) && blocks.length >= 2 && blocks.every(isMcpContentBlock);
  if (isBlockList(value.content)) {
    return {
      blocks: value.content,
      outside: { ...value, content: [] },
      rebuild: (blocks) => ({ ...value, content: blocks }),
    };
  }
  const data = value.data;
  if (typeof value.content === "string" && isPlainObject(data) && isBlockList(data.content)
    && joinMcpContentBlocks(data.content) === value.content) {
    return {
      blocks: data.content,
      outside: { ...value, content: "", data: { ...data, content: [] } },
      rebuild: (blocks) => ({ ...value, content: joinMcpContentBlocks(blocks), data: { ...data, content: blocks } }),
    };
  }
  return null;
}

function itemRefOf(block: Record<string, unknown>): string | undefined {
  const meta = block._meta;
  const ref = isPlainObject(meta) ? meta[TOOL_RESULT_ITEM_REF_META_KEY] : undefined;
  if (typeof ref !== "string" || !ITEM_REF_PATTERN.test(ref) || scanPromptInjection(ref).length > 0) return undefined;
  return ref;
}

function withheldItemPlaceholder(item: WithheldToolResultItem) {
  return {
    type: "text",
    text: JSON.stringify({
      paperclip_content_guard: {
        status: "withheld",
        reason: "prompt_injection_blocked",
        message: "This item was withheld by the content guard. Its content is not available to this caller.",
        findings: item.findings,
        item_index: item.index,
        ...(item.ref ? { item_ref: item.ref } : {}),
      },
    }),
  };
}

/**
 * Per-item result guard. Returns the result with only the matching items
 * replaced by placeholders, or null when the match cannot be confined to
 * separate items (no item list, a match outside the items, no single item
 * matching, every item matching, or a match left after withholding).
 */
async function withholdMatchingItems(
  value: unknown,
  classifier?: (content: string) => Promise<PromptInjectionModelOutcome>,
): Promise<{ value: Record<string, unknown>; withheldItems: WithheldToolResultItem[] } | null> {
  const list = toolResultItemList(value);
  if (!list) return null;
  if ((await detectPromptInjection(list.outside, classifier)).findings.length > 0) return null;
  const withheldItems: WithheldToolResultItem[] = [];
  for (const [index, block] of list.blocks.entries()) {
    const { findings } = await detectPromptInjection(block, classifier);
    if (findings.length > 0) withheldItems.push({ index, ...(itemRefOf(block) ? { ref: itemRefOf(block) } : {}), findings });
  }
  if (withheldItems.length === 0 || withheldItems.length === list.blocks.length) return null;
  const withheldByIndex = new Map(withheldItems.map((item) => [item.index, item]));
  const rewritten = list.rebuild(list.blocks.map((block, index) => {
    const withheld = withheldByIndex.get(index);
    return withheld ? withheldItemPlaceholder(withheld) : block;
  }));
  // The delivered result must pass the same detector as a whole.
  if ((await detectPromptInjection(rewritten, classifier)).findings.length > 0) return null;
  return { value: rewritten, withheldItems };
}

export async function validateToolContent(input: {
  value: unknown;
  direction: "arguments" | "result";
  sensitiveMode?: "redact" | "block";
  promptInjectionMode?: "redact" | "block" | "ignore";
  classifier?: (content: string) => Promise<PromptInjectionModelOutcome>;
  /**
   * Slice H: keep the bounded pre-LR-2 content summary for a result. Callers
   * set this only for tools whose risk level is not `read`, so approved
   * actions and ask-first test calls can be delivered from storage. Read-tool
   * results (every Proton connector tool) stay content-free. Default false.
   */
  retainResultSummary?: boolean;
}) {
  const sensitiveMode = input.sensitiveMode ?? "redact";
  const promptInjectionMode = input.promptInjectionMode ?? (input.direction === "result" ? "block" : "ignore");
  let redactedValue = isPlainObject(input.value) ? redactEventPayload(input.value) : input.value;
  const summarize = input.direction === "result" && !input.retainResultSummary ? summarizeToolResultValue : summarizeToolValue;
  let redactedSummary = summarize(redactedValue);
  const findings: string[] = [];

  if (redactedSummary.redactedFields?.length) {
    findings.push("sensitive_value");
    if (sensitiveMode === "block") {
      throw new ToolContentValidationError("Tool content contains sensitive values", "sensitive_value_blocked", findings);
    }
  }

  let promptFindings: string[] = [];
  let detectorMetadata: PromptInjectionDetectorMetadata | undefined;
  let withheldItems: WithheldToolResultItem[] | undefined;
  if (promptInjectionMode !== "ignore") {
    ({ findings: promptFindings, detectorMetadata } = await detectPromptInjection(input.value, input.classifier));
  }
  if (promptFindings.length > 0) {
    findings.push(...promptFindings);
    if (promptInjectionMode === "block") {
      // A result made of separate items loses only the matching items; every
      // other result (and every request) is still blocked as a whole.
      const confined = input.direction === "result" ? await withholdMatchingItems(input.value, input.classifier) : null;
      if (!confined) {
        throw new ToolContentValidationError(
          "Tool result contained prompt-injection instructions and was blocked",
          "prompt_injection_blocked",
          promptFindings,
          detectorMetadata,
        );
      }
      withheldItems = confined.withheldItems;
      redactedValue = redactEventPayload(confined.value);
      redactedSummary = summarize(redactedValue);
    }
  }

  return {
    value: redactedValue,
    summary: redactedSummary,
    findings,
    detectorMetadata,
    ...(withheldItems ? { withheldItems } : {}),
  };
}
