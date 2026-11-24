import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { Workflow, type WorkflowDefaults } from "../../../src/flow/decorators/workflow.js";
import type { PathBuilder } from "../../../src/flow/path-builder.js";
import { OfferDraftDto } from "../fixtures/dtos.js";
import {
  DraftKitWorkflowFinish,
  EditKitAgent,
  SecondKitWorkflowStart,
} from "../fixtures/kit.fixture.js";
import { onStart, toAction } from "../fixtures/paths.js";

/** `[flow.path-too-deep]` (#272 AC10): a warning past 4 levels, an error under strict. */

class DeliveryError extends Error {}

@Action({ name: "deep-1-action", description: "Level 1" })
class Deep1Action {
  async execute(): Promise<void> {
    await Promise.resolve();
  }
}

@Action({ name: "deep-2-action", description: "Level 2" })
class Deep2Action {
  async execute(): Promise<void> {
    await Promise.resolve();
  }
}

@Action({ name: "deep-3-action", description: "Level 3" })
class Deep3Action {
  async execute(): Promise<void> {
    await Promise.resolve();
  }
}

@Action({ name: "deep-4-action", description: "Level 4" })
class Deep4Action {
  async execute(): Promise<void> {
    await Promise.resolve();
  }
}

@Action({ name: "deep-5-action", description: "Level 5" })
class Deep5Action {
  async execute(): Promise<void> {
    await Promise.resolve();
  }
}

/** Side paths nested inside each other, one level per `.onError(…)`. */
function nested(actions: readonly (typeof Deep1Action)[]): PathBuilder {
  const [first, ...rest] = actions;
  if (first === undefined) throw new RangeError("at least one level");
  const side = toAction(first);
  const inner = rest.length === 0 ? side : side.onError(DeliveryError, nested(rest));
  return inner.toFinish(DraftKitWorkflowFinish);
}

const workflowNesting = (
  levels: readonly (typeof Deep1Action)[],
  defaults?: WorkflowDefaults,
): abstract new () => unknown => {
  @Workflow({
    name: "nesting-workflow",
    version: "1.0.0",
    flow: [
      onStart(SecondKitWorkflowStart)
        .returns(OfferDraftDto)
        .toAgent(EditKitAgent)
        .onError(DeliveryError, nested(levels))
        .returns(OfferDraftDto)
        .toFinish(DraftKitWorkflowFinish),
    ],
    ...(defaults === undefined ? {} : { defaults }),
  })
  class NestingWorkflow {}
  return NestingWorkflow;
};

const fourLevels = [Deep1Action, Deep2Action, Deep3Action, Deep4Action];
const fiveLevels = [...fourLevels, Deep5Action];

const tooDeep = {
  code: "flow.path-too-deep",
  message:
    "nesting-workflow: the path onStart(SecondKitWorkflowStart) nests 5 levels at deep-5-action (limit 4) — move the branch into a child workflow (agboss generate workflow …)",
  nodes: ["deep-5-action"],
};

describe("AC10: path too deep — warning, strict error", () => {
  it("a path exactly 4 levels deep passes", () => {
    expect(checkWorkflow(workflowNesting(fourLevels))).toMatchObject({ errors: [], warnings: [] });
  });

  it("5 levels warn, naming the workflow, the path, the node, the limit and the fix", () => {
    expect(checkWorkflow(workflowNesting(fiveLevels))).toMatchObject({
      errors: [],
      warnings: [tooDeep],
    });
  });

  it("under strict the warning is an error", () => {
    expect(checkWorkflow(workflowNesting(fiveLevels), { strict: true })).toMatchObject({
      errors: [tooDeep],
      warnings: [],
    });
  });

  it("the limit is set in defaults.flow.maxPathDepth", () => {
    const workflow = workflowNesting(fiveLevels, { flow: { maxPathDepth: 5 } });

    expect(checkWorkflow(workflow)).toMatchObject({ errors: [], warnings: [] });
  });
});
