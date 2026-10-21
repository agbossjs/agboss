import { describe, expect, it } from "vitest";
import { COMMANDS, helpFor, usage } from "../../src/cli/usage.js";

describe("agboss help (#104)", () => {
  it("AC1: lists every operation with a one-line description", () => {
    const text = usage();

    for (const [name, command] of Object.entries(COMMANDS))
      expect(text).toContain(`${name.padEnd(11)} ${command.summary}`);
    expect(text).toContain("(short: agb)");
  });

  it("AC2: one command's usage and all its options; unknown → undefined", () => {
    const compare = helpFor("compare") ?? "";

    expect(compare).toContain(
      "agboss compare — profiles side by side on the same tasks of a start's workflow",
    );
    expect(compare).toContain(
      "Usage: agboss compare [--start <name>] --profiles base,<p>… [--golden <name> | --last N]",
    );
    expect(compare).toMatch(/--profiles <list>\s+comma-separated/);
    expect(helpFor("help")).toContain("Usage: agboss help [<command>]");
    expect(helpFor("nope")).toBeUndefined();
  });

  it("AC3: every command in the list has its own help, from the same description", () => {
    for (const name of Object.keys(COMMANDS))
      expect(helpFor(name)).toContain(`agboss ${name} — ${COMMANDS[name]?.summary ?? ""}`);
  });
});
