import { describe, expect, it } from "vitest";
import { wrapCommandWithEnv } from "../../src/pod-exec.js";

describe("wrapCommandWithEnv", () => {
  it("returns the command unchanged when there is no env", () => {
    expect(wrapCommandWithEnv(["opencode", "run"], undefined)).toEqual({ command: ["opencode", "run"], stdinPrefix: null });
    expect(wrapCommandWithEnv(["opencode", "run"], {})).toEqual({ command: ["opencode", "run"], stdinPrefix: null });
  });

  it("puts the env values in the stdin prefix and only the target in the argv (BLA-4139)", () => {
    const out = wrapCommandWithEnv(
      ["opencode", "run", "--model", "anthropic/x"],
      { XDG_CONFIG_HOME: "/tmp/cfg", ANTHROPIC_API_KEY: "sk-bf-1" },
    );
    expect(out.command.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(out.command.slice(3)).toEqual(["paperclip-env", "opencode", "run", "--model", "anthropic/x"]);
    expect(JSON.stringify(out.command)).not.toContain("sk-bf-1");
    expect(JSON.stringify(out.command)).not.toContain("/tmp/cfg");
    expect(out.stdinPrefix).toMatch(/^\d+\n/);
    expect(out.stdinPrefix).toContain("'sk-bf-1'");
    expect(out.stdinPrefix).toContain("export XDG_CONFIG_HOME=");
  });

  it("never propagates PATH (would break command resolution in the sandbox image)", () => {
    const out = wrapCommandWithEnv(["opencode"], { PATH: "/server/bin", XDG_CONFIG_HOME: "/c" });
    expect(out.stdinPrefix).not.toContain("PATH");
    expect(out.stdinPrefix).not.toContain("/server/bin");
    expect(out.stdinPrefix).toContain("XDG_CONFIG_HOME=");
  });

  it("skips invalid identifiers and non-string values", () => {
    const out = wrapCommandWithEnv(["opencode"], {
      "BAD-KEY": "x",
      GOOD_KEY: "y",
      // @ts-expect-error intentional non-string to exercise the guard
      NUMERIC: 5,
    });
    expect(out.stdinPrefix).toContain("export GOOD_KEY=");
    expect(out.stdinPrefix).not.toContain("BAD-KEY");
    expect(out.stdinPrefix).not.toContain("NUMERIC");
  });

  it("shell-escapes single quotes in values", () => {
    const out = wrapCommandWithEnv(["opencode"], { V: "a'b" });
    expect(out.stdinPrefix).toContain(`__paperclip_env_0='a'"'"'b'`);
  });
});
