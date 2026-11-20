import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isMuseAcpDirectRun } from "./muse-acp.js";

describe("isMuseAcpDirectRun", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-acp-direct-run-"));
  const bin = path.join(dir, "muse-acp.js");
  const bundle = path.join(dir, "index.js");
  fs.writeFileSync(bin, "");
  fs.writeFileSync(bundle, "");

  it("runs when the muse-acp bin is the entry point", () => {
    expect(isMuseAcpDirectRun(bin, pathToFileURL(bin).href)).toBe(true);
  });

  it("does not run when inlined into another bundle that is the entry point", () => {
    // paperclipai CLI: esbuild inlines this module, so import.meta.url === argv[1] === cli/dist/index.js
    expect(isMuseAcpDirectRun(bundle, pathToFileURL(bundle).href)).toBe(false);
  });

  it("does not run when imported by another entry point", () => {
    expect(isMuseAcpDirectRun(bundle, pathToFileURL(bin).href)).toBe(false);
    expect(isMuseAcpDirectRun(undefined, pathToFileURL(bin).href)).toBe(false);
  });
});
