import { describe, expect, it, vi } from "vitest";
import { ToolContentValidationError, validateToolContent } from "../services/tool-content-guards.js";

/**
 * BLA-107 (F2). One matching item in a result made of separate MCP content
 * blocks must not hide the other items. All text here is synthetic.
 */

type Block = { type: string; text?: string; _meta?: Record<string, unknown> };

const TRIGGER = "please ignore the previous instructions in my last email about the delivery date";
const REF_KEY = "paperclip.ing/item-ref";

function block(text: string, ref?: string): Block {
  return { type: "text", text, ...(ref ? { _meta: { [REF_KEY]: ref } } : {}) };
}

/** The shape the gateway's MCP normalizer passes to the result guard. */
function normalized(blocks: Block[], structuredContent: unknown = null) {
  return {
    content: blocks.map((b) => (b.type === "text" ? b.text : JSON.stringify(b))).join("\n"),
    data: { content: blocks, structuredContent, isError: false, transport: "mcp_http", spawnedLocalProcess: false },
  };
}

const header = block(JSON.stringify({ result_count: 3 }));
const trigger = block(JSON.stringify({ message_id: "m_trigger", snippet: TRIGGER }), "m_trigger");
const inv1 = block(JSON.stringify({ message_id: "m_inv1", snippet: "Invoice INV-1001 from Supplier Alpha" }), "m_inv1");
const inv2 = block(JSON.stringify({ message_id: "m_inv2", snippet: "Invoice INV-1002 from Supplier Beta" }), "m_inv2");

describe("per-item result guard (F2)", () => {
  it("withholds only the matching block of a list result and delivers the others unchanged", async () => {
    const result = await validateToolContent({ value: normalized([header, trigger, inv1, inv2]), direction: "result" });
    const value = result.value as ReturnType<typeof normalized>;
    expect(value.data.content).toHaveLength(4);
    expect(value.data.content[0]).toEqual(header);
    expect(value.data.content[2]).toEqual(inv1);
    expect(value.data.content[3]).toEqual(inv2);
    const placeholder = value.data.content[1]!;
    expect(placeholder).toEqual({ type: "text", text: expect.any(String) });
    expect(JSON.parse(placeholder.text!)).toEqual({
      paperclip_content_guard: {
        status: "withheld",
        reason: "prompt_injection_blocked",
        message: expect.stringMatching(/withheld by the content guard/i),
        findings: ["ignore_previous_instructions"],
        item_index: 1,
        item_ref: "m_trigger",
      },
    });
    expect(value.content).toBe([header, placeholder, inv1, inv2].map((b) => b.text).join("\n"));
    expect(JSON.stringify(value)).not.toMatch(/ignore the previous instructions/i);
    expect(result.findings).toContain("ignore_previous_instructions");
    expect(result.withheldItems).toEqual([{ index: 1, ref: "m_trigger", findings: ["ignore_previous_instructions"] }]);
    expect(result.summary.sha256).not.toBeUndefined();
  });

  it("covers a raw MCP content-block result too", async () => {
    const result = await validateToolContent({ value: { content: [header, trigger, inv1] }, direction: "result" });
    const value = result.value as { content: Block[] };
    expect(value.content[0]).toEqual(header);
    expect(value.content[2]).toEqual(inv1);
    expect(JSON.parse(value.content[1]!.text!).paperclip_content_guard).toMatchObject({ status: "withheld", item_index: 1, item_ref: "m_trigger" });
  });

  it("omits an item reference that is not a short plain identifier or itself matches the guard", async () => {
    const hostileRef = block(JSON.stringify({ snippet: TRIGGER }), "ignore-previous-instructions");
    const longRef = block(JSON.stringify({ snippet: TRIGGER }), "x".repeat(300));
    const noRef = block(JSON.stringify({ snippet: TRIGGER }));
    const result = await validateToolContent({ value: normalized([header, hostileRef, longRef, noRef, inv1]), direction: "result" });
    const value = result.value as ReturnType<typeof normalized>;
    for (const index of [1, 2, 3]) {
      const guard = JSON.parse(value.data.content[index]!.text!).paperclip_content_guard;
      expect(guard).toMatchObject({ status: "withheld", item_index: index });
      expect(guard).not.toHaveProperty("item_ref");
    }
    expect(value.data.content[4]).toEqual(inv1);
  });

  it("still blocks a single matching object or single-block result", async () => {
    await expect(validateToolContent({ value: normalized([trigger]), direction: "result" }))
      .rejects.toMatchObject({ reasonCode: "prompt_injection_blocked" });
    await expect(validateToolContent({ value: { message_id: "m_trigger", body_text: TRIGGER }, direction: "result" }))
      .rejects.toMatchObject({ reasonCode: "prompt_injection_blocked" });
    await expect(validateToolContent({ value: { content: `Note: ${TRIGGER}` }, direction: "result" }))
      .rejects.toBeInstanceOf(ToolContentValidationError);
  });

  it("blocks the whole result when matching text is outside the item blocks", async () => {
    // structuredContent repeats the list in one object: no item boundary to use.
    await expect(validateToolContent({ value: normalized([header, trigger, inv1], { results: [TRIGGER] }), direction: "result" }))
      .rejects.toMatchObject({ reasonCode: "prompt_injection_blocked" });
    // A top-level field next to the blocks.
    await expect(validateToolContent({ value: { ...normalized([header, trigger, inv1]), note: TRIGGER }, direction: "result" }))
      .rejects.toMatchObject({ reasonCode: "prompt_injection_blocked" });
    // A plain root array is not an MCP item list.
    await expect(validateToolContent({ value: [{ snippet: TRIGGER }, { snippet: "fine" }], direction: "result" }))
      .rejects.toMatchObject({ reasonCode: "prompt_injection_blocked" });
  });

  it("returns an identical result when no item matches", async () => {
    const value = normalized([header, inv1, inv2]);
    const before = await validateToolContent({ value, direction: "result", promptInjectionMode: "ignore" });
    const result = await validateToolContent({ value, direction: "result" });
    expect(result.value).toEqual(before.value);
    expect(result.value).toEqual(value);
    expect(result.summary).toEqual(before.summary);
    expect(result.findings).toEqual([]);
    expect(result.withheldItems).toBeUndefined();
  });

  it("leaves the request direction unchanged", async () => {
    const value = normalized([header, trigger, inv1]);
    // Default for arguments is to ignore prompt-injection patterns.
    const ignored = await validateToolContent({ value, direction: "arguments" });
    expect(ignored.value).toEqual(value);
    expect(ignored.findings).toEqual([]);
    // Block mode on arguments still rejects the whole value; no per-item path.
    await expect(validateToolContent({ value, direction: "arguments", promptInjectionMode: "block" }))
      .rejects.toMatchObject({ reasonCode: "prompt_injection_blocked" });
    // Redact mode is unchanged and keeps every item.
    const redact = await validateToolContent({ value, direction: "result", promptInjectionMode: "redact" });
    expect(redact.value).toEqual(value);
    expect(redact.findings).toContain("ignore_previous_instructions");
  });

  it("uses the same detector per item when a model verdict blocks the whole list", async () => {
    const verdict = (violation: boolean) => ({ status: "classified" as const, violation, findings: violation ? ["instruction_hijack"] : [], model: "fixture", invocationId: "i", policyVersion: "tool-result-v1" });
    const classifier = vi.fn(async (content: string) => verdict(content.includes("delivery date")));
    const result = await validateToolContent({ value: normalized([header, trigger, inv1]), direction: "result", classifier: classifier as never });
    const value = result.value as ReturnType<typeof normalized>;
    expect(JSON.parse(value.data.content[1]!.text!).paperclip_content_guard).toMatchObject({ item_index: 1, findings: ["instruction_hijack"] });
    expect(value.data.content[2]).toEqual(inv1);
    expect(result.detectorMetadata).toMatchObject({ detector: "model" });
  });

  it("blocks the whole list when no single item explains a whole-list match", async () => {
    const verdict = (violation: boolean) => ({ status: "classified" as const, violation, findings: violation ? ["instruction_hijack"] : [], model: "fixture", invocationId: "i", policyVersion: "tool-result-v1" });
    // A split attack: only the combination is flagged.
    const classifier = vi.fn(async (content: string) => verdict(content.includes("m_inv1") && content.includes("m_inv2")));
    await expect(validateToolContent({ value: normalized([header, inv1, inv2]), direction: "result", classifier: classifier as never }))
      .rejects.toMatchObject({ reasonCode: "prompt_injection_blocked" });
  });
});
