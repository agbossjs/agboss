import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandContext } from "../../src/cli/context.js";
import { regenerateFlowTypes } from "../../src/cli/flow-types.js";
import {
  CHECKS_RUN,
  envelope,
  fixture,
  agboss,
  ledgerWarning,
  PARTS_APPLICATION_REPORT,
  piiKeyWarning,
  TEST_APPLICATION_REPORT,
} from "./agboss.js";

/** `agboss check` / `agboss generate` write `.agboss/types.d.ts` for v2 workflows (#270 AC13, #272 S2, S7). */

const PARTS = fixture("cli/parts.workflow.ts");
const HIDDEN = fixture("cli/hidden.workflow.ts");
const THROWS = fixture("cli/throws.workflow.ts");
const STAR = fixture("test-workflow/test.workflow.ts");
const NOTE = "six-parts-agent: 64 input shapes — InputOf is flat (no narrowing between fields)";

const projects: string[] = [];
const project = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "agboss-check-types-"));
  projects.push(directory);
  return directory;
};
const typesOf = (directory: string): string => join(directory, ".agboss/types.d.ts");

afterEach(() => {
  for (const directory of projects.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("#270 AC13: agboss check writes .agboss/types.d.ts", () => {
  it("a v2 workflow: the types are written, the S4 note printed, exit 0", async () => {
    const cwd = project();

    const call = await agboss(["check", "--application", PARTS], cwd);

    expect(call).toMatchObject({ code: 0, stderr: "" });
    expect(call.stdout).toBe(
      `${NOTE}\ntypes: .agboss/types.d.ts\n${PARTS_APPLICATION_REPORT}${ledgerWarning(PARTS)}${piiKeyWarning(PARTS)}ok: ${PARTS} — ${CHECKS_RUN}\n`,
    );
    expect(readFileSync(typesOf(cwd), "utf8")).toContain('"six-parts-agent": SummaryDto;');
  });

  it("S2: a stale file never blocks regeneration", async () => {
    const cwd = project();
    mkdirSync(join(cwd, ".agboss"));
    writeFileSync(typesOf(cwd), "export {}; // stale\n");

    const call = await agboss(["check", "--application", PARTS, "--json"], cwd);

    expect(envelope(call)).toMatchObject({
      ok: true,
      result: {
        checks: ["assembly", "environment", "application", "prompts", "types"],
        problems: [],
        types: ".agboss/types.d.ts",
      },
      warnings: [NOTE],
    });
    expect(readFileSync(typesOf(cwd), "utf8")).not.toContain("stale");
  });

  it("[types.unexported-class]: a problem line, exit 3, nothing written", async () => {
    const cwd = project();

    const call = await agboss(["check", "--application", HIDDEN], cwd);

    expect(call.code).toBe(3);
    expect(call.stdout).toContain(`${HIDDEN} types.unexported-class HiddenAgent (`);
    expect(call.stdout).toContain(`${HIDDEN} types.unexported-class HiddenDto is not exported`);
    expect(existsSync(typesOf(cwd))).toBe(false);
  });

  it("every check runs on the application, the types written first", async () => {
    const cwd = project();

    const call = await agboss(["check", "--application", STAR], cwd);

    expect(call.stdout).toBe(
      `types: .agboss/types.d.ts\n${TEST_APPLICATION_REPORT}${ledgerWarning(STAR)}${piiKeyWarning(STAR)}ok: ${STAR} — ${CHECKS_RUN}\n`,
    );
    expect(existsSync(typesOf(cwd))).toBe(true);
  });
});

describe("S7: agboss generate regenerates the types at its end", () => {
  const contextIn = (cwd: string, lines: string[]): CommandContext => ({
    command: "generate",
    values: {},
    positionals: [],
    json: false,
    io: {
      stdout: { write: () => true },
      stderr: { write: () => true },
      env: {},
      cwd,
      registerTypeScript: false,
    },
    say: (line) => lines.push(`say ${line}`),
    warn: (line) => lines.push(`warn ${line}`),
  });

  it("the changed v2 workflow's types are written; other changes write none", async () => {
    const cwd = project();
    const lines: string[] = [];

    await regenerateFlowTypes(contextIn(cwd, lines), ["src/x.agent.ts"]);
    await regenerateFlowTypes(contextIn(cwd, lines), ["src/x.agent.ts", PARTS]);

    expect(lines).toEqual(["say   types: .agboss/types.d.ts"]);
    expect(existsSync(typesOf(cwd))).toBe(true);
  });

  it("a generation that fails, or a module that does not load, is a warning — never a failure", async () => {
    const cwd = project();
    const lines: string[] = [];

    await regenerateFlowTypes(contextIn(cwd, lines), [HIDDEN]);
    await regenerateFlowTypes(contextIn(cwd, lines), [THROWS]);

    expect(lines).toEqual([
      expect.stringMatching(/^warn \S+hidden\.workflow\.ts types\.unexported-class HiddenAgent /),
      expect.stringMatching(/^warn \S+hidden\.workflow\.ts types\.unexported-class HiddenDto /),
      "warn types not regenerated: the module fails while it loads — run agboss check",
    ]);
  });
});

describe("#263 AC11: agboss check --strict — the analyser's warnings are errors", () => {
  const DEEP = fixture("cli/deep.workflow.ts");

  it("without --strict a warning is printed and the check passes; with it the check fails", async () => {
    const warned = await agboss(["check", "--application", DEEP], project());
    const strict = await agboss(["check", "--strict", "--application", DEEP], project());

    expect(warned.code).toBe(0);
    expect(warned.stdout).toContain(`${DEEP} flow.path-too-deep deep-workflow: the path`);
    expect(strict.code).toBe(3);
    expect(strict.stdout).toContain(`${DEEP} flow.path-too-deep deep-workflow: the path`);
    expect(strict.stdout).not.toContain("ok: ");
  });
});
