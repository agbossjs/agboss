import { ComponentKind } from "../../../src/flow/runtime/records.js";
import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { childClassesOf } from "../../../src/flow/analyse/child-workflow.js";
import { StepKind, type ToStep } from "../../../src/flow/ast.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { fromComponent, subPathFrom } from "../../../src/flow/path-builder.js";
import {
  CountDoneWorkflowFinish,
  CountdownWorkflow,
  CountdownWorkflowStart,
  SplitWorkflow,
} from "../runtime/fixtures/recursion.workflow.js";
import { onStart, onWorkflow, toWorkflow } from "../../helpers/flow.js";
import { Ttl } from "../../../src/index.js";

/**
 * #1287: `.toWorkflow(() => W)`, `onWorkflow(() => W)`, `toWorkflow(() => W)` of a side path and
 * `.forEachItem(() => W, …)` take a thunk, read when the flow is analysed — never while the
 * path is built, where the class below the decorator does not exist yet.
 */

class Never {
  readonly fixture = true;
}
const neverReached = (): never => {
  throw new ReferenceError("the thunk ran while the path was built");
};

describe("#1287: a thunk is not read while the path is built", () => {
  it("every form that names a workflow keeps the thunk unread", () => {
    expect(() => onStart(CountdownWorkflowStart).toWorkflow(neverReached)).not.toThrow();
    expect(() => onWorkflow(neverReached)).not.toThrow();
    expect(() => toWorkflow(neverReached)).not.toThrow();
    expect(() =>
      onStart(CountdownWorkflowStart).forEachItem(toWorkflow(neverReached), { takeFirst: 2 }),
    ).not.toThrow();
    expect(() => fromComponent(ComponentKind.Workflow, neverReached)).not.toThrow();
  });

  it("the class is read once, on first use, and kept", () => {
    let reads = 0;
    const thunk = (): typeof Never => {
      reads += 1;
      return Never;
    };
    const { steps } = onStart(CountdownWorkflowStart).toWorkflow(thunk);
    const [step] = steps as readonly [ToStep];

    expect(reads).toBe(0);
    expect(step.kind).toBe(StepKind.To);
    expect(step.target).toBe(Never);
    expect(step.target).toBe(Never);
    expect(reads).toBe(1);
  });

  it("a class is stored as written and a thunk reads like plain data", () => {
    const { steps } = onStart(CountdownWorkflowStart).toWorkflow(CountdownWorkflow);
    const [step] = steps as readonly [ToStep];

    expect(step.target).toBe(CountdownWorkflow);
    expect(Object.keys(step)).toEqual(["kind", "targetKind", "target"]);
    const [lazy] = onStart(CountdownWorkflowStart).toWorkflow(() => CountdownWorkflow).steps as [
      ToStep,
    ];
    expect({ ...lazy }).toEqual({
      kind: StepKind.To,
      targetKind: ComponentKind.Workflow,
      target: CountdownWorkflow,
    });
  });
});

describe("#1287: a workflow that launches itself with a thunk", () => {
  it("is a node of its own name that is the workflow itself", () => {
    const { analysis, errors } = checkWorkflow(CountdownWorkflow);

    expect(errors).toEqual([]);
    const node = analysis?.graph.nodes.get("countdown-workflow" as never);
    expect(node).toMatchObject({ kind: ComponentKind.Workflow, component: CountdownWorkflow });
    expect(node?.recursionOf).toBe(CountdownWorkflow);
    expect(analysis?.graph.nodes.has("this-workflow" as never)).toBe(false);
  });

  it("a per-item launch of itself is the same node", () => {
    const { analysis, errors } = checkWorkflow(SplitWorkflow);

    expect(errors).toEqual([]);
    expect(analysis?.graph.nodes.get("split-workflow" as never)?.recursionOf).toBe(SplitWorkflow);
  });

  it("childClassesOf lists the workflow itself unless it is excluded", () => {
    const flow = [
      onStart(CountdownWorkflowStart)
        .toWorkflow(() => CountdownWorkflow)
        .toFinish(CountDoneWorkflowFinish),
    ];
    Workflow({
      name: "lazy-self-workflow",
      version: "1.0.0",
      historyTtl: Ttl.Forever,
      flow,
      executionLimits: { maxDepth: 2 },
    })(Never);

    expect(childClassesOf(flow)).toEqual([CountdownWorkflow]);
    expect(childClassesOf(flow, CountdownWorkflow)).toEqual([]);
  });
});
