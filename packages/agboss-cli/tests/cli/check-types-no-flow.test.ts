import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CheckProblem } from "../../src/cli/check-problems.js";
import { checkProblemsOf } from "../../src/cli/types-problems.js";
import { envelope, fixture, agboss } from "./agboss.js";

/** #376: `agboss check` never prints `ok` without written types; a DTO clash names its files. */

const TRIP_ONLY = fixture("cli/flights/trip-only.workflow.ts");
const STAY = fixture("cli/stay/stay.workflow.ts");
const PARTS = fixture("cli/parts.workflow.ts");
const NO_FLOW = `.agboss/types.d.ts was not written: no workflow found to type — export the application's workflows from ${TRIP_ONLY} (export { MyWorkflow }), or keep it in the project's src/ folder beside its *.workflow.ts files`;
const CLASH =
  /^stay-workflow: BookingDto is declared in \S*stay\/hotel\.workflow\.ts and \S*stay\/stay\.workflow\.ts — DTO names are unique in the application/;

const projects: string[] = [];
const project = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "agboss-check-types-no-flow-"));
  projects.push(directory);
  return directory;
};
const typesOf = (directory: string): string => join(directory, ".agboss/types.d.ts");

afterEach(() => {
  for (const directory of projects.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("#376 AC1: an application module outside src/ that does not export its workflows", () => {
  it("is [types.no-flow] naming the file and the fix: exit 3, no ok, nothing written", async () => {
    const cwd = project();

    const call = await agboss(["check", "--application", TRIP_ONLY], cwd);

    expect(call.code).toBe(3);
    expect(call.stdout).toContain(`${TRIP_ONLY} types.no-flow ${NO_FLOW}`);
    expect(call.stdout).not.toContain("ok: ");
    expect(existsSync(typesOf(cwd))).toBe(false);
  });

  it("--json lists the problem and reports no types file", async () => {
    const cwd = project();

    const call = await agboss(["check", "--json", "--application", TRIP_ONLY], cwd);

    expect(call.code).toBe(3);
    const json = envelope(call);
    expect(json).toMatchObject({
      ok: false,
      result: {
        checks: ["assembly", "environment", "application", "prompts"],
        problems: [{ file: TRIP_ONLY, code: "types.no-flow", message: NO_FLOW }],
      },
    });
    expect(json.result).not.toHaveProperty("types");
  });
});

describe("#376 AC2: two DTO classes of one name inside one workflow", () => {
  it("the [dto.duplicate-name] line names both files, once", async () => {
    const call = await agboss(["check", "--json", "--application", STAY], project());

    expect(call.code).toBe(3);
    expect(envelope(call)).toMatchObject({
      result: {
        problems: [
          { file: STAY, code: "dto.duplicate-name", message: expect.stringMatching(CLASH) },
        ],
      },
    });
  });

  it("an assembly diagnostic generation has no named twin of stays as it is", () => {
    const unnamed: CheckProblem = {
      file: "a.ts",
      code: "dto.duplicate-name",
      message: "x-workflow: ADto is declared in (unknown file) and (unknown file) — unique",
    };
    const other: CheckProblem = {
      ...unnamed,
      message: "x-workflow: BDto is declared in a.dto.ts and b.dto.ts — unique",
    };
    const outcome = { problems: [], unwritten: [other], warnings: [] };

    expect(checkProblemsOf(outcome, [unnamed])).toEqual([unnamed]);
  });
});

describe("#376 AC3: a project whose types are written", () => {
  it("still prints ok with the types check", async () => {
    const cwd = project();

    const call = await agboss(["check", "--application", PARTS], cwd);

    expect(call.code).toBe(0);
    expect(call.stdout).toContain(
      `ok: ${PARTS} — assembly, environment, application, prompts, types`,
    );
    expect(existsSync(typesOf(cwd))).toBe(true);
  });
});
