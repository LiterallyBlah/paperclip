import { describe, expect, it } from "vitest";
import { markdownToPlainPreview } from "./markdown-plain-text.js";

describe("markdownToPlainPreview", () => {
  it("flattens a Markdown card summary to one plain line", () => {
    const summary = [
      "**Decision needed.** Pick the _launch_ plan.",
      "",
      "- First option keeps `scope`",
      "- Second adds the [draft brief](/api/attachments/attachment-1/content)",
      "1. ![chart](https://example.com/c.png) attached",
      "## Next",
      "> Quoted ~~old~~ text",
    ].join("\n");
    expect(markdownToPlainPreview(summary)).toBe(
      "Decision needed. Pick the launch plan. First option keeps scope Second adds the draft brief chart attached Next Quoted old text",
    );
  });

  it("keeps plain text, hyphenated words and identifiers unchanged", () => {
    expect(markdownToPlainPreview("Approve the follow-up for TASK-12 at 3*4 units")).toBe(
      "Approve the follow-up for TASK-12 at 3*4 units",
    );
    expect(markdownToPlainPreview("snake_case_name stays")).toBe("snake_case_name stays");
  });
});
