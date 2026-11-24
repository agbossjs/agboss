/**
 * #1366: a workflow's cap on executions at once is its own `maxConcurrentExecutions`, else 10 — for a class that
 * is no workflow (undeclared or another kind) too, never a crash; the flow is recorded as plain paths.
 */
import { describe, expect, it } from "vitest";
import { NodeKind } from "../../../src/flow/ast.js";
import { declarationOf } from "../../../src/flow/decorators/declaration.js";
import {
  declaredMaxConcurrentExecutionsOf,
  maxConcurrentExecutionsOf,
  Workflow,
} from "../../../src/flow/decorators/workflow.js";
import { onStart } from "../../flow/fixtures/paths.js";
import { OrderWorkflowStart } from "../../flow/fixtures/order.fixture.js";
import { NotifyRecruiterAction } from "../../flow/fixtures/offer.fixture.js";

class Undeclared {
  readonly undeclared = true;
}

@Workflow({
  name: "capped-1366h-workflow",
  version: "1.0.0",
  flow: [onStart(OrderWorkflowStart)],
  maxConcurrentExecutions: 4,
})
class Capped {}

@Workflow({
  name: "uncapped-1366h-workflow",
  version: "1.0.0",
  flow: [onStart(OrderWorkflowStart)],
})
class Uncapped {}

describe("#1366: the cap of executions at once", () => {
  it("a workflow's own cap, else 10", () => {
    expect(maxConcurrentExecutionsOf(Capped)).toBe(4);
    expect(declaredMaxConcurrentExecutionsOf(Capped)).toBe(4);
    expect(maxConcurrentExecutionsOf(Uncapped)).toBe(10);
    expect(declaredMaxConcurrentExecutionsOf(Uncapped)).toBeUndefined();
  });

  it("a class that is no workflow has none declared and the default 10", () => {
    for (const other of [Undeclared, NotifyRecruiterAction]) {
      expect(declaredMaxConcurrentExecutionsOf(other)).toBeUndefined();
      expect(maxConcurrentExecutionsOf(other)).toBe(10);
    }
    expect(declarationOf(NotifyRecruiterAction)?.kind).toBe(NodeKind.Action);
  });

  it("the flow is recorded as plain data: source and steps only", () => {
    const declaration = declarationOf(Capped);
    const flow = declaration?.kind === NodeKind.Workflow ? declaration.options.flow : [];

    expect(flow).toHaveLength(1);
    expect(Object.keys(flow[0] ?? {})).toEqual(["source", "steps"]);
  });
});
