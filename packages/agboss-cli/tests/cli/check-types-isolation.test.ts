import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agboss, fixture } from "./agboss.js";

/** #468: checking another application never rewrites the project's own `.agboss/types.d.ts`. */

const PARTS = fixture("cli/parts.workflow.ts");
const STAR = fixture("test-workflow/test.workflow.ts");

const projects: string[] = [];
const projectOf = (application: string | undefined): string => {
  const directory = mkdtempSync(join(tmpdir(), "agboss-types-isolation-"));
  projects.push(directory);
  const agbossField = application === undefined ? {} : { agboss: { application } };
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "p", ...agbossField }));
  return directory;
};
const typesOf = (directory: string): string => join(directory, ".agboss/types.d.ts");
const scopedTypesOf = (directory: string): string[] =>
  readdirSync(join(directory, ".agboss")).filter((name) => name !== "types.d.ts");

afterEach(() => {
  for (const directory of projects.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("#468: --application isolates the generated types", () => {
  it("another application is typed in a file of its own, the project's file is untouched", async () => {
    const cwd = projectOf(PARTS);
    await agboss(["check"], cwd);
    const before = readFileSync(typesOf(cwd), "utf8");

    const call = await agboss(["check", "--application", STAR, "--json"], cwd);

    expect(call.code).toBe(0);
    expect(readFileSync(typesOf(cwd), "utf8")).toBe(before);
    const [scoped, ...others] = scopedTypesOf(cwd);
    expect(others).toEqual([]);
    expect(scoped).toMatch(/^types\..+\.d\.ts$/);
    expect(readFileSync(join(cwd, ".agboss", scoped ?? ""), "utf8")).toContain("test-workflow");
  });

  it("the project's own application still writes .agboss/types.d.ts", async () => {
    const cwd = projectOf(PARTS);

    const call = await agboss(["check", "--application", PARTS], cwd);

    expect(call.code).toBe(0);
    expect(existsSync(typesOf(cwd))).toBe(true);
    expect(scopedTypesOf(cwd)).toEqual([]);
  });

  it("no application set in package.json: the one given writes .agboss/types.d.ts", async () => {
    const cwd = projectOf(undefined);

    const call = await agboss(["check", "--application", STAR], cwd);

    expect(call.code).toBe(0);
    expect(existsSync(typesOf(cwd))).toBe(true);
    expect(scopedTypesOf(cwd)).toEqual([]);
  });
});
