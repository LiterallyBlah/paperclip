import { describe, expect, it } from "vitest";
import { stripMarkdown } from "../services/attention.js";

describe("attention stripMarkdown (detail excerpts)", () => {
  it("drops Markdown table delimiter rows and cell pipes", () => {
    const text = "Run the synthetic cut-over now?\n\n| Step | Time |\n|---|---|\n| Drain | 5 min |\n| Switch | 1 min |";
    const stripped = stripMarkdown(text);
    expect(stripped).not.toContain("|");
    expect(stripped).toContain("Step Time Drain 5 min Switch 1 min");
  });

  it("handles aligned delimiter rows and tables without outer pipes", () => {
    expect(stripMarkdown("A | B\n:--- | ---:\n1 | 2")).toBe("A | B 1 | 2");
  });

  it("keeps a plain pipe in prose", () => {
    expect(stripMarkdown("Choose read | write access")).toBe("Choose read | write access");
  });
});
