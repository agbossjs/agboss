import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { ImportTable } from "../../../src/flow/types/imports.js";
import { ClassLocator } from "../../../src/flow/types/locate.js";
import type { AnalysedWorkflow } from "../../../src/flow/types/tables.js";
import { thisWorkflowClashes } from "../../../src/flow/types/this-workflow.js";
import {
  CountdownWorkflow,
  ShallowWorkflow,
  TopicResearchWorkflow,
} from "../runtime/fixtures/recursion.workflow.js";

/**
 * #264 — `ThisWorkflow` is one class, so one entry of a project's generated tables: recursive
 * workflows whose finishes give different classes fail generation, naming both.
 */

const analysed = (workflow: abstract new () => unknown): AnalysedWorkflow => {
  const { analysis } = checkWorkflow(workflow);
  if (analysis === undefined) throw new Error("the fixture does not check");
  return { analysis, errors: [] };
};

const names = (): ImportTable =>
  new ImportTable(new ClassLocator([]), "/project/.agboss/types.d.ts");

describe("[types.this-workflow-outputs]", () => {
  it("two recursive workflows giving different classes", () => {
    const found = thisWorkflowClashes(
      [analysed(TopicResearchWorkflow), analysed(CountdownWorkflow)],
      names(),
    );

    expect(found.map((violation) => violation.code)).toEqual(["types.this-workflow-outputs"]);
    expect(found[0]?.message).toContain(
      "topic-research-workflow give TopicFailedDto | TopicReportDto",
    );
    expect(found[0]?.message).toContain("countdown-workflow give CountDoneDto | CountStoppedDto");
  });

  it("recursive workflows giving the same classes share the entry", () => {
    expect(
      thisWorkflowClashes([analysed(CountdownWorkflow), analysed(ShallowWorkflow)], names()),
    ).toEqual([]);
  });
});
