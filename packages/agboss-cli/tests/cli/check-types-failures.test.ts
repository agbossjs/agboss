import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CheckProblem } from "../../src/cli/check-problems.js";
import { typesProblemsBeside } from "../../src/cli/flow-types.js";
import { envelope, fixture, agboss } from "./agboss.js";

/** #371: `agboss check` never prints `ok` when it did not write `.agboss/types.d.ts`. */

const FLIGHTS = fixture("cli/flights/flights.workflow.ts");
const PARTS = fixture("cli/parts.workflow.ts");
const CLASH =
  /^FlightBookingDto is declared in \S*flights\/approvals\.workflow\.ts and \S*flights\/trip\.workflow\.ts — DTO names are unique in the application/;

const projects: string[] = [];
const project = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "agboss-check-types-failures-"));
  projects.push(directory);
  return directory;
};
const typesOf = (directory: string): string => join(directory, ".agboss/types.d.ts");

afterEach(() => {
  for (const directory of projects.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("#371 AC1: two DTO classes of one name in two workflows of one application", () => {
  it("[dto.duplicate-name] naming both files: exit 3, no ok, nothing written", async () => {
    const cwd = project();

    const call = await agboss(["check", "--application", FLIGHTS], cwd);

    expect(call.code).toBe(3);
    const line = call.stdout.split("\n").find((text) => text.includes(" dto.duplicate-name "));
    expect(line?.replace(`${FLIGHTS} dto.duplicate-name `, "")).toMatch(CLASH);
    expect(call.stdout).not.toContain("ok: ");
    expect(call.stdout).not.toContain("types: ");
    expect(existsSync(typesOf(cwd))).toBe(false);
  });

  it("--json lists the problem and reports no types file", async () => {
    const cwd = project();

    const call = await agboss(["check", "--json", "--application", FLIGHTS], cwd);

    expect(call.code).toBe(3);
    const json = envelope(call);
    expect(json).toMatchObject({
      ok: false,
      result: {
        checks: ["assembly", "environment", "application", "prompts"],
        problems: [
          { file: FLIGHTS, code: "dto.duplicate-name", message: expect.stringMatching(CLASH) },
        ],
      },
    });
    expect(json.result).not.toHaveProperty("types");
    expect(existsSync(typesOf(cwd))).toBe(false);
  });
});

describe("#371 AC2: any other failure to write the types file is reported", () => {
  it("an unwritable .agboss folder is [types.not-written]: exit 3, no ok", async () => {
    const cwd = project();
    writeFileSync(join(cwd, ".agboss"), "a file where the folder goes\n");

    const call = await agboss(["check", "--application", PARTS], cwd);

    expect(call.code).toBe(3);
    expect(call.stdout).toContain(
      `${PARTS} types.not-written .agboss/types.d.ts was not written: `,
    );
    expect(call.stdout).not.toContain("ok: ");
    expect(statSync(join(cwd, ".agboss")).isFile()).toBe(true);
  });

  it("an error the assembly reports itself is not reported twice", () => {
    const own: CheckProblem = { file: "a.ts", code: "types.unexported-class", message: "X" };
    const clash: CheckProblem = { file: "a.ts", code: "dto.duplicate-name", message: "Y" };
    const node: CheckProblem = { file: "a.ts", code: "graph.duplicate-node-name", message: "Z" };
    const outcome = { problems: [own], unwritten: [clash, node], warnings: [] };

    const problems = typesProblemsBeside(outcome, [{ ...node, message: "Z, by the assembly" }]);

    expect(problems).toEqual([own, clash]);
  });
});
