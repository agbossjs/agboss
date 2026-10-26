import { describe, expect, it } from "vitest";
import type { Class } from "../../../src/components/injection.js";
import type { DtoClass } from "../../../src/dto/types.js";
import { Text } from "../../../src/dto/index.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { generateFlowTypes } from "../../../src/flow/types/generate.js";
import { ImportTable, moduleSpecifier } from "../../../src/flow/types/imports.js";
import { ClassLocator } from "../../../src/flow/types/locate.js";
import { start } from "../fixtures/paths.js";

/**
 * How the generated file names classes (#272 S2, S3): import paths from the modules that export
 * each class, distinct identifiers for two classes of one name, and the name clashes that fail
 * generation — `name` and DTO class names key the tables.
 */

const outFile = "/project/.agboss/types.d.ts";

class FirstSameDto {
  @Text({ prompt: "one" })
  text!: string;
}
class SecondSameDto {
  @Text({ prompt: "another" })
  text!: string;
}
Object.defineProperty(FirstSameDto, "name", { value: "SameDto" });
Object.defineProperty(SecondSameDto, "name", { value: "SameDto" });

class TextDto {
  @Text({ prompt: "anything" })
  text!: string;
}

const startOf = (name: string, input: DtoClass = TextDto): Class => {
  @WorkflowStart({ name, description: "Anything", input })
  class SameWorkflowStart {}
  return SameWorkflowStart;
};

const workflowOf = (name: string, startClass: Class, input: DtoClass = TextDto): Class => {
  @Workflow({
    name,
    version: "1.0.0",
    flow: [start(startClass).returns(input).toFinish(TextWorkflowFinish)],
  })
  class SomeWorkflow {}
  return SomeWorkflow;
};

@WorkflowFinish({ name: "text-workflow-finish", description: "Anything", output: TextDto })
class TextWorkflowFinish {}

@Agent({
  name: "unused-agent",
  description: "Unused",
  prompt: "Do it.",
  model: "moonshotai/kimi-k2.6",
})
class UnusedAgent {}

describe("S2: import paths come from the modules that export a class", () => {
  it("relative .js paths from the generated file, package names as they are", () => {
    expect(moduleSpecifier("/project/.agboss", "/project/src/agents/draft.agent.ts")).toBe(
      "../src/agents/draft.agent.js",
    );
    expect(moduleSpecifier("/project/.agboss", "/project/.agboss/local.mts")).toBe("./local.mjs");
    expect(moduleSpecifier("/project/.agboss", "@agboss/core")).toBe("@agboss/core");
  });

  it("the declaring file first, else the first module that is not an index barrel", () => {
    const locator = new ClassLocator([
      { file: "/project/src/index.ts", exports: { TextDto, UnusedAgent } },
      { file: "/project/src/text.dto.ts", exports: { TextDto } },
      { file: "/project/src/other.ts", exports: { Renamed: TextDto } },
    ]);

    expect(locator.fileOf(TextDto)).toBe("/project/src/text.dto.ts");
    expect(locator.fileOf(TextDto, "/project/src/index.ts")).toBe("/project/src/index.ts");
    expect(locator.fileOf(UnusedAgent)).toBe("/project/src/index.ts");
    expect(locator.fileOf(TextWorkflowFinish)).toBeUndefined();
  });

  it("two classes of one name get distinct identifiers", () => {
    const names = new ImportTable(
      new ClassLocator([
        { file: "/project/a.dto.ts", exports: { SameDto: FirstSameDto } },
        { file: "/project/b.dto.ts", exports: { SameDto: SecondSameDto } },
      ]),
      outFile,
    );

    expect([names.ref(FirstSameDto), names.ref(SecondSameDto), names.ref(FirstSameDto)]).toEqual([
      "SameDto",
      "SameDto2",
      "SameDto",
    ]);
    expect(names.importLines("@agboss/core")).toEqual([
      'import type { SameDto } from "../a.dto.js";',
      'import type { SameDto as SameDto2 } from "../b.dto.js";',
    ]);
  });
});

describe("S3 / S5: names that key the tables are unique in the application", () => {
  it("two classes under one component name in two workflows fail generation", () => {
    const first = startOf("same-workflow-start");
    const second = startOf("same-workflow-start");
    const generated = generateFlowTypes({
      workflows: [workflowOf("first-workflow", first), workflowOf("second-workflow", second)],
      modules: [
        {
          file: "/project/first.ts",
          exports: { SameWorkflowStart: first, TextDto, TextWorkflowFinish },
        },
        { file: "/project/second.ts", exports: { SameWorkflowStart: second } },
      ],
      outFile,
    });

    expect(generated.text).toBeUndefined();
    expect(generated.errors.map(({ code, message }) => `[${code}] ${message}`)).toEqual([
      '[graph.duplicate-node-name] SameWorkflowStart and SameWorkflowStart are both named "same-workflow-start" — a name is unique in the application (it keys records and the generated types); rename one',
    ]);
  });

  it("two DTO classes of one name fail generation with [dto.duplicate-name]", () => {
    const first = startOf("first-same-workflow-start", FirstSameDto);
    const second = startOf("second-same-workflow-start", SecondSameDto);
    const generated = generateFlowTypes({
      workflows: [
        workflowOf("first-same-workflow", first, FirstSameDto),
        workflowOf("second-same-workflow", second, SecondSameDto),
      ],
      modules: [
        { file: "/project/src/a.dto.ts", exports: { SameDto: FirstSameDto } },
        { file: "/project/src/b.dto.ts", exports: { SameDto: SecondSameDto } },
        {
          file: "/project/src/flow.ts",
          exports: { SameWorkflowStart: first, TextDto, TextWorkflowFinish },
        },
        { file: "/project/src/second.ts", exports: { SameWorkflowStart: second } },
      ],
      outFile,
    });

    expect(generated.text).toBeUndefined();
    expect(generated.errors.filter(({ code }) => code === "dto.duplicate-name")).toEqual([
      {
        code: "dto.duplicate-name",
        message:
          "SameDto is declared in src/a.dto.ts and src/b.dto.ts — DTO names are unique in the application (they key checkpoints)",
        nodes: [],
      },
    ]);
  });

  it("the tables are augmented in @agboss/core by default", () => {
    const only = startOf("only-workflow-start");
    const { text } = generateFlowTypes({
      workflows: [workflowOf("only-workflow", only)],
      modules: [
        {
          file: "/project/only.ts",
          exports: { SameWorkflowStart: only, TextDto, TextWorkflowFinish },
        },
      ],
      outFile,
      strict: true,
    });

    expect(text).toContain('declare module "@agboss/core" {');
    expect(text).toContain(
      'import type { NoInput, agbossComponent, agbossDto } from "@agboss/core";',
    );
  });
});
