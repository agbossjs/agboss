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
 * #1287: `Inputs[workflow]` is the union of the workflow's starts' inputs, for a workflow that
 * launches itself and for one no workflow launches; the generated tables hold no `this-workflow`
 * entry and no `ThisWorkflowOutputs` table. The compile-time side is lazy-workflow.test-d.ts.
 */

const analysed = (workflow: abstract new () => unknown): AnalysedWorkflow => {
  const { analysis } = checkWorkflow(workflow);
  if (analysis === undefined) throw new Error("the fixture does not check");
  return { analysis, errors: [] };
};

const names = (): ImportTable =>
  new ImportTable(new ClassLocator([]), "/project/.agboss/types.d.ts");

describe("#1287: Inputs[workflow]", () => {
  it("a recursive workflow's entry is its start's input, under its own name", () => {
    const tables = tablesOf(
      [analysed(TopicResearchWorkflow), analysed(CountdownWorkflow), analysed(ShallowWorkflow)],
      names(),
    );

    expect(tables.inputs.get("countdown-workflow")).toBe("CountDto");
    expect(tables.inputs.get("topic-research-workflow")).toBe("TopicDto");
    expect(tables.inputs.get("shallow-workflow")).toBe("CountDto");
  });

  it("no entry stands for a this-workflow node", () => {
    const tables = tablesOf(
      [analysed(TopicResearchWorkflow), analysed(CountdownWorkflow)],
      names(),
    );

    expect(tables.producerOutputs.has("this-workflow")).toBe(false);
    expect(tables.inputs.has("this-workflow")).toBe(false);
    expect("thisWorkflowOutputs" in tables).toBe(false);
  });

  it("a recursive workflow gives what its finishes give, under its own name", () => {
    const tables = tablesOf([analysed(CountdownWorkflow)], names());

    expect(tables.producerOutputs.get("countdown-workflow")).toBe("CountDoneDto | CountStoppedDto");
  });
});
