/**
 * #1288b: a step that gives `listOf(A, B)` also gives `listOf(A)` and `listOf(B)` — typed slices in
 * the order of the items, `[]` for a class with no item — and the list and its slices are twins.
 */
import { describe, expect } from "vitest";
import { Integer, Text } from "../../../src/dto/index.js";
import {
  Action,
  Application,
  EmptyEnvironment,
  listOf,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
} from "../../../src/index.js";
import type { Class } from "../../../src/components/injection.js";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { testWith } from "../../../src/testing/index.js";
import { execute, onStart } from "../../helpers/flow.js";
import { TEST_BUDGETS } from "../fixtures/budgets.js";

class RunDto {
  @Text() kinds!: string;
}
class PassedDto {
  @Integer() score!: number;
}
class RejectedDto {
  @Text() reason!: string;
}
class SummaryDto {
  @Text() text!: string;
}

@WorkflowStart({ name: "slices-workflow-start", description: "A run", input: RunDto })
class SlicesStart {}

@Action({
  name: "check-slices-action",
  description: "Checks vendors",
  input: { run: RunDto },
  output: listOf(PassedDto, RejectedDto),
})
class CheckAction {
  execute(input: { readonly run: RunDto }): unknown[] {
    return Array.from(input.run.kinds).map((kind, index) =>
      kind === "p" ? { score: index } : { reason: `r${String(index)}` },
    );
  }
}

@Action({
  name: "count-slices-action",
  description: "Counts the slices",
  input: { passed: listOf(PassedDto), rejected: listOf(RejectedDto) },
  output: SummaryDto,
})
class CountAction {
  // values arrive as the DTOs themselves, tracked
  execute(input: {
    readonly passed: readonly PassedDto[];
    readonly rejected: readonly RejectedDto[];
  }): SummaryDto {
    const classes =
      input.passed.every((item) => item instanceof PassedDto) &&
      input.rejected.every((item) => item instanceof RejectedDto);
    const scores = input.passed.map((item) => item.score).join(",");
    return { text: `${scores}|${String(input.rejected.length)}|${String(classes)}` };
  }
}

@WorkflowFinish({ name: "slices-workflow-finish", description: "Done", output: SummaryDto })
class SlicesFinish {}

@Workflow({
  name: "slices-workflow",
  version: "1.0.0",
  flow: [onStart(SlicesStart).toAction(CheckAction).toAction(CountAction).toFinish(SlicesFinish)],
})
class SlicesWorkflow {}

@Application({
  name: "slices-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [SlicesWorkflow],
  budgets: TEST_BUDGETS,
})
class SlicesApplication {}

const test = testWith(SlicesApplication);

describe("#1288b: typed slices of a polymorphic list", () => {
  test("a node reads each class as its own list, in order, instances of their class", async ({
    app,
  }) => {
    const result = await execute(app, SlicesStart, { kinds: "pxpp" });

    expect(result).toFinishWith(SlicesFinish, { text: "0,2,3|1|true" });
  });

  test("a class with no item is an empty list", async ({ app }) => {
    const result = await execute(app, SlicesStart, { kinds: "pp" });

    expect(result).toFinishWith(SlicesFinish, { text: "0,1|0|true" });
  });
});

@Action({
  name: "passed-only-action",
  description: "Reads one slice",
  input: { passed: listOf(PassedDto) },
  output: SummaryDto,
})
class PassedOnlyAction {
  execute(): SummaryDto {
    return { text: "" };
  }
}

@Action({
  name: "whole-list-action",
  description: "Reads the whole list",
  input: { items: listOf(PassedDto, RejectedDto) },
  output: SummaryDto,
})
class WholeListAction {
  execute(): SummaryDto {
    return { text: "" };
  }
}

const flowOf = (name: string, reader: Class) => {
  @Workflow({
    name,
    version: "1.0.0",
    flow: [onStart(SlicesStart).toAction(CheckAction).toAction(reader).toFinish(SlicesFinish)],
  })
  class Checked {}
  return Checked;
};

describe("#1288b: the analysis", () => {
  test("reading the slices is a read of the list: no unused output, no missing input", () => {
    expect(checkWorkflow(SlicesWorkflow).errors).toEqual([]);
  });

  test("reading the whole list reads every class of it", () => {
    expect(checkWorkflow(flowOf("whole-list-workflow", WholeListAction)).errors).toEqual([]);
  });

  test("a class read through neither its slice nor the list is an unused output", () => {
    const { errors } = checkWorkflow(flowOf("passed-only-workflow", PassedOnlyAction));

    expect(errors.map((found) => [found.code, found.message])).toEqual([
      [
        "flow.unused-output",
        "passed-only-workflow: check-slices-action returns listOf(RejectedDto) that no node reads — read it in a node below, or remove it",
      ],
    ]);
  });
});
