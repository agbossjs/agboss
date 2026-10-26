import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FlowTypesStatus, writeFlowTypes } from "../../../src/flow/types/write.js";

/** `agboss check` writes `<project>/.agboss/types.d.ts` (#270 AC13, #272 S2, S7). */

const fixture = (name: string): string => new URL(`../../${name}`, import.meta.url).pathname;
const projects: string[] = [];
const project = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "agboss-types-"));
  projects.push(directory);
  return directory;
};
const typesOf = (directory: string): string => join(directory, ".agboss/types.d.ts");

afterEach(() => {
  for (const directory of projects.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("#270 AC13: the generated file", () => {
  it("is written into the project's .agboss/ and replaces a stale one", async () => {
    const directory = project();
    mkdirSync(join(directory, ".agboss"));
    writeFileSync(typesOf(directory), "stale — from before the last change");

    const result = await writeFlowTypes({
      files: [fixture("flow/fixtures/wide.fixture.ts")],
      project: directory,
      typescript: false,
    });

    expect(result).toMatchObject({ status: FlowTypesStatus.Written, outFile: typesOf(directory) });
    expect(readFileSync(typesOf(directory), "utf8")).toContain('declare module "@agboss/core" {');
    expect(result.notes).toHaveLength(1);
  });

  it("a module with no workflow is left alone: nothing is written", async () => {
    const directory = project();

    const result = await writeFlowTypes({
      files: [fixture("fixtures/test-flow/test.flow.ts")],
      project: directory,
      typescript: false,
    });

    expect(result.status).toBe(FlowTypesStatus.NoFlow);
    expect(existsSync(typesOf(directory))).toBe(false);
  });

  it("standard DTOs are imported from the package entry a project imports them from", async () => {
    const directory = project();

    const result = await writeFlowTypes({
      files: [fixture("fixtures/test-workflow/test.workflow.ts")],
      project: directory,
      typescript: false,
    });

    expect(result.status).toBe(FlowTypesStatus.Written);
    expect(readFileSync(typesOf(directory), "utf8")).toContain(
      'import type { WorkflowFinishTextDto, WorkflowStartTextDto } from "@agboss/core/dto";',
    );
  });

  it("a failed generation writes nothing and says why", async () => {
    const directory = project();

    const result = await writeFlowTypes({
      files: [fixture("flow/fixtures/unexported.fixture.ts")],
      project: directory,
      typescript: false,
      strict: true,
    });

    expect(result.status).toBe(FlowTypesStatus.Failed);
    expect(result.errors.map((found) => found.code)).toEqual([
      "types.unexported-class",
      "types.unexported-class",
    ]);
    expect(existsSync(typesOf(directory))).toBe(false);
  });
});
