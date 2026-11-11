/**
 * #904 item 1: the type generator knows every built-in DTO's entry. A project imports
 * `WorkflowFinishFileDto` / `A2AFileDto` from `@agboss/core/a2a`, not `@agboss/core/dto`: an app whose
 * finish returns one is typed (no `[types.unexported-class]`), and every DTO class any public entry
 * exports is found in the generator's package entries — a new one cannot drift.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WorkflowFinishFileDto } from "../../../src/a2a/files/a2a-file.dto.js";
import type { Class } from "../../../src/components/injection.js";
import { fieldsOf } from "../../../src/dto/metadata.js";
import { WorkflowStartTextDto } from "../../../src/dto/index.js";
import type { DtoClass } from "../../../src/dto/types.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { generateFlowTypes } from "../../../src/flow/types/generate.js";
import { ClassLocator } from "../../../src/flow/types/locate.js";
import { packageModules } from "../../../src/flow/types/write.js";
import { start } from "../../helpers/flow.js";

@WorkflowStart({ name: "file-out-workflow-start", description: "A text", input: WorkflowStartTextDto })
export class FileOutWorkflowStart {}

@Action({
  name: "file-out-action",
  description: "Answers with a file",
  input: { text: WorkflowStartTextDto },
  output: WorkflowFinishFileDto,
})
export class FileOutAction {
  execute(): WorkflowFinishFileDto {
    throw new Error("never run: only typed");
  }
}

@WorkflowFinish({
  name: "file-out-workflow-finish",
  description: "The file",
  output: WorkflowFinishFileDto,
})
export class FileOutWorkflowFinish {}

@Workflow({
  name: "file-out-workflow",
  version: "1.0.0",
  flow: [
    start(FileOutWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAction(FileOutAction)
      .returns(WorkflowFinishFileDto)
      .toFinish(FileOutWorkflowFinish),
  ],
})
export class FileOutWorkflow {}

/** The project's module as tsx records it: its own classes only, the package's never. */
const PROJECT_MODULE = {
  file: "/project/src/file-out.workflow.ts",
  exports: { FileOutWorkflowStart, FileOutAction, FileOutWorkflowFinish, FileOutWorkflow },
};

const PACKAGE = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
) as { readonly exports: Readonly<Record<string, { readonly import: string }>> };

/** The public entries a project imports from (not the CLI's, the test runners' or lint's). */
const projectEntries = Object.entries(PACKAGE.exports).filter(
  ([subpath]) => !/testing|eslint|internal/.test(subpath),
);

const isDto = (value: unknown, name: string): value is DtoClass =>
  typeof value === "function" && value.name === name && fieldsOf(value as DtoClass).length > 0;

describe("#904 item 1: the generator knows every built-in DTO's entry", () => {
  it("AC1.1 an app whose finish returns WorkflowFinishFileDto is typed: imported from @agboss/core/a2a", async () => {
    const generated = generateFlowTypes({
      workflows: [FileOutWorkflow],
      modules: [PROJECT_MODULE, ...(await packageModules())],
      outFile: "/project/.agboss/types.d.ts",
    });

    expect(generated.errors).toEqual([]);
    expect(generated.text).toContain(
      'import type { WorkflowFinishFileDto } from "@agboss/core/a2a";',
    );
  });

  it("AC1.2 every DTO class a public entry exports is found in the package entries", async () => {
    const locator = new ClassLocator(await packageModules());
    const exported: [string, Class][] = [];
    for (const [subpath, target] of projectEntries) {
      const source = target.import.replace(/^\.\/dist\//, "../../../src/").replace(/\.js$/, ".ts");
      const module = (await import(source)) as Readonly<Record<string, unknown>>;
      for (const [name, value] of Object.entries(module))
        if (isDto(value, name)) exported.push([`${subpath} ${name}`, value]);
    }

    expect(exported.length).toBeGreaterThan(0);
    expect(exported.filter(([, dto]) => locator.fileOf(dto) === undefined).map(([at]) => at)).toEqual(
      [],
    );
  });
});
