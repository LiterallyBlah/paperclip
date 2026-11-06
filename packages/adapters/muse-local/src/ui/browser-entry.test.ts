import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("Muse browser metadata entry", () => {
  it("bundles model metadata without importing the Node-only server adapter", async () => {
    const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
    const result = await build({
      stdin: { contents: `import { DEFAULT_MUSE_LOCAL_MODEL } from ${JSON.stringify(entry)}; console.log(DEFAULT_MUSE_LOCAL_MODEL);`, resolveDir: process.cwd(), loader: "ts" },
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
      logLevel: "silent",
    });
    expect(result.outputFiles[0].text).toContain("muse-wonder-1.0");
  });
});
