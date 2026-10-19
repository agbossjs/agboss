import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { ImportTable } from "../../../src/flow/types/imports.js";
import { ClassLocator } from "../../../src/flow/types/locate.js";
import { tablesOf, type AnalysedWorkflow } from "../../../src/flow/types/tables.js";
import {
  CountdownWorkflow,
  ShallowWorkflow,
  TopicResearchWorkflow,
} from "../runtime/fixtures/recursion.workflow.js";

/**
 * #264 S112 — `ThisWorkflow` typed per path: each recursive workflow gets its own
 * `ThisWorkflowOutputs` entry, keyed by its name, so recursive workflows whose finishes give
 * different classes are typed side by side (`[types.this-workflow-outputs]` is gone); the
 * project-wide tables keep no `this-workflow` entry. The compile-time side is
 * this-workflow.test-d.ts.
 */

const analysed = (workflow: abstract new () => unknown): AnalysedWorkflow => {
  const { analysis } = checkWorkflow(workflow);
  if (analysis === undefined) throw new Error("the fixture does not check");
  return { analysis, errors: [] };
};

const names = (): ImportTable =>
  new ImportTable(new ClassLocator([]), "/project/.agboss/types.d.ts");

describe("#264 S112: ThisWorkflowOutputs", () => {
  it("two recursive workflows giving different classes each get their own entry", () => {
    const tables = tablesOf(
      [analysed(TopicResearchWorkflow), analysed(CountdownWorkflow)],
      names(),
    );

    expect(Object.fromEntries(tables.thisWorkflowOutputs)).toEqual({
      "countdown-workflow":
        "{ readonly input: NoInput; readonly output: CountDoneDto | CountStoppedDto }",
      "topic-research-workflow":
        "{ readonly input: NoInput; readonly output: TopicFailedDto | TopicReportDto; " +
        "readonly join: readonly (TopicFailedDto | TopicReportDto)[] }",
    });
  });

  it("the project-wide tables have no this-workflow entry", () => {
    const tables = tablesOf(
      [analysed(TopicResearchWorkflow), analysed(CountdownWorkflow), analysed(ShallowWorkflow)],
      names(),
    );

    expect(tables.producerOutputs.has("this-workflow")).toBe(false);
    expect(tables.inputs.has("this-workflow")).toBe(false);
    expect([...tables.joinOutputs.keys()].filter((key) => key.includes("this-workflow"))).toEqual(
      [],
    );
    expect([...tables.thisWorkflowOutputs.keys()]).toEqual([
      "topic-research-workflow",
      "countdown-workflow",
      "shallow-workflow",
    ]);
  });
});
