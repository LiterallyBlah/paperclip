import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("gives the upstream provider union and Muse successor distinct receipt hashes", async () => {
  const files = ["0361_mighty_dracula.sql", "0375_muse_subscription_provider.sql"];
  const contents = await Promise.all(files.map(file => readFile(new URL(`./migrations/${file}`, import.meta.url), "utf8")));
  const hashes = contents.map(content => createHash("sha256").update(content).digest("hex"));
  // Receipt lookup uses content hashes; identical SQL otherwise stays pending.
  expect(new Set(hashes).size).toBe(files.length);
  expect(contents.map(content => content.replace(/--[^\n]*/g, "").trim())[1]).toBe(
    contents[0].replace(/--[^\n]*/g, "").trim(),
  );
});
