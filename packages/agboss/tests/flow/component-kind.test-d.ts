/**
 * #1324 (Q-G): `FlowNodeKind` (the kinds a flow path can name, internal to `src/flow`) is exactly seven
 * `ComponentKind`s, so a `switch (node.kind)` over it is exhaustive for TypeScript — a new flow kind
 * breaks every such switch at compile time — and a kind that is no flow node is refused.
 */
import { describe, expectTypeOf, it } from "vitest";
import type { FlowNodeKind } from "../../src/flow/ast.js";
import { ComponentKind } from "../../src/flow/runtime/records.js";

const exhaustive = (kind: FlowNodeKind): string => {
  switch (kind) {
    case ComponentKind.WorkflowStart:
    case ComponentKind.WorkflowFinish:
    case ComponentKind.Agent:
    case ComponentKind.Action:
    case ComponentKind.Router:
    case ComponentKind.Workflow:
    case ComponentKind.ExternalTask:
      return kind;
    default:
      return kind satisfies never;
  }
};

describe("#1324: FlowNodeKind", () => {
  it("is the seven flow kinds of ComponentKind and a switch over it is exhaustive", () => {
    expectTypeOf<FlowNodeKind>().toEqualTypeOf<
      | ComponentKind.WorkflowStart
      | ComponentKind.WorkflowFinish
      | ComponentKind.Agent
      | ComponentKind.Action
      | ComponentKind.Router
      | ComponentKind.Workflow
      | ComponentKind.ExternalTask
    >();
    expectTypeOf(exhaustive).parameter(0).toEqualTypeOf<FlowNodeKind>();
  });

  it("refuses a ComponentKind that is no flow node", () => {
    expectTypeOf<ComponentKind.Tool>().not.toExtend<FlowNodeKind>();
    expectTypeOf<ComponentKind.Budget>().not.toExtend<FlowNodeKind>();
    expectTypeOf<ComponentKind>().not.toExtend<FlowNodeKind>();
    // @ts-expect-error a tool is not a flow node
    exhaustive(ComponentKind.Tool);
  });
});
