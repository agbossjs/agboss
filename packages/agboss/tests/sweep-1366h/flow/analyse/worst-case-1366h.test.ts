import { ComponentKind } from "../../../../src/flow/runtime/records.js";
import { declaredExecutionLimitsOf } from "../../../../src/flow/decorators/workflow.js";
/**
 * #1366: the worst case of one call of a start, computed from a graph built by hand whose child workflows are real:
 * the executions, the ones at once, the steps, the depth and the parts of the case with a per-item child launch (its
 * maxItems and maxConcurrency, either one alone), one child behind a join, a child that is no workflow, an edge into a
 * node the graph lacks, a child with several starts (the one with the most executions is the child's worst, the first
 * of equals), a start with no way to a finish, and the start log's line.
 */
import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../../../../src/flow/analyse/analyse.js";
import { EdgeKind, type FlowEdge, type FlowNode } from "../../../../src/flow/analyse/flow-graph.js";
import {
  worstCaseLine,
  worstCasesOf,
  type Limits,
  type WorstCase,
} from "../../../../src/flow/analyse/worst-case.js";
import { Workflow } from "../../../../src/flow/decorators/workflow.js";
import { WorkflowStart } from "../../../../src/flow/decorators/workflow-start.js";
import { declarationOf } from "../../../../src/flow/decorators/declaration.js";
import { toWorkflow } from "../../../helpers/flow.js";
import {
  CountdownAction,
  CountdownWorkflowStart,
} from "../../../flow/runtime/fixtures/recursion.workflow.js";
import { CompanyDto } from "../../../flow/fixtures/data-dtos.js";
import { CompanyReviewWorkflow } from "../../../flow/fixtures/children.fixture.js";
import { onStart as pathStart } from "../../../helpers/flow.js";
import { graphOf, edge, node } from "../../../flow/analyse/graph-fixture.js";
import { Ttl } from "../../../../src/index.js";

const Desk = Object;

/** Four starts of one child: the executions they make are 1, 2, 2 and 1 (the review is a child of two of them). */
@WorkflowStart({ name: "one-first-start", description: "A company", input: CompanyDto })
class OneFirstStart {}
@WorkflowStart({ name: "two-first-start", description: "A company", input: CompanyDto })
class TwoFirstStart {}
@WorkflowStart({ name: "two-second-start", description: "A company", input: CompanyDto })
class TwoSecondStart {}
@WorkflowStart({ name: "one-last-start", description: "A company", input: CompanyDto })
class OneLastStart {}

@Workflow({
  name: "mixed-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    pathStart(OneFirstStart),
    pathStart(TwoFirstStart).toWorkflow(CompanyReviewWorkflow),
    pathStart(TwoSecondStart).toWorkflow(CompanyReviewWorkflow),
    pathStart(OneLastStart),
  ],
})
class MixedWorkflow {}

const workflowNode = (name: string, component: abstract new () => unknown): FlowNode =>
  ({
    name,
    kind: ComponentKind.Workflow,
    component,
    declaration: declarationOf(component),
  }) as never;

const launchOf = (more: Record<string, unknown>) => ({
  launcher: "A",
  call: "forEachItem",
  listed: ["W"],
  branches: [],
  isRouterLaunch: false,
  ...more,
});

const launchEdge = (kind: EdgeKind, more: Record<string, unknown>): FlowEdge =>
  edge("A", "W", kind, { launch: launchOf(more) });

/** S -> A -> W, the last edge being `last`; the child is `component`. */
const parentOf = (last: FlowEdge, component: abstract new () => unknown = MixedWorkflow) =>
  graphOf(
    [
      node("S", ComponentKind.WorkflowStart),
      node("A", ComponentKind.Agent),
      workflowNode("W", component),
    ],
    [edge("S", "A"), last],
    ["S"],
  );

const caseOf = (
  graph: ReturnType<typeof parentOf>,
  limits: Limits = { maxSteps: 50 },
): WorstCase => {
  const [worst] = worstCasesOf(graph, limits, Desk, declaredExecutionLimitsOf);
  if (worst === undefined) throw new Error("the graph has a start");
  return worst;
};

describe("#1366: a per-item child launch", () => {
  const perItem = (more: Record<string, unknown>) =>
    caseOf(parentOf(launchEdge(EdgeKind.Launch, { items: {}, ...more }), CompanyReviewWorkflow));

  it("starts maxItems children, maxConcurrency of them at once, and names both limits", () => {
    const worst = perItem({ maxItems: 5, maxConcurrency: 2 });

    expect(worst).toMatchObject({
      executions: 6,
      concurrentExecutions: 3,
      depth: 1,
      parts: [
        "maxItems 5 on A → forEachItem(W)",
        "maxConcurrency 2 on A → forEachItem(W)",
        "5 × W",
      ],
    });
    expect(worst.children).toHaveLength(1);
    expect(worst.children[0]).toMatchObject({
      from: "A",
      count: 5,
      atOnce: 2,
      maxItems: 5,
      maxConcurrency: 2,
      isRecursive: false,
    });
  });

  it("without maxConcurrency all of them are at once, and no maxConcurrency is named", () => {
    const worst = perItem({ maxItems: 5 });

    expect(worst).toMatchObject({
      executions: 6,
      concurrentExecutions: 6,
      parts: ["maxItems 5 on A → forEachItem(W)", "5 × W"],
    });
    expect(worst.children[0]).toMatchObject({ count: 5, atOnce: 5, maxItems: 5 });
    expect(worst.children[0]).not.toHaveProperty("maxConcurrency");
  });

  it("without maxItems it is one child: maxConcurrency cannot widen it, no maxItems is named", () => {
    const worst = perItem({ maxConcurrency: 4 });

    expect(worst).toMatchObject({
      executions: 2,
      concurrentExecutions: 2,
      parts: ["maxConcurrency 4 on A → forEachItem(W)", "1 × W"],
    });
    expect(worst.children[0]).toMatchObject({ count: 1, atOnce: 1, maxConcurrency: 4 });
    expect(worst.children[0]).not.toHaveProperty("maxItems");
  });

  it("a maxConcurrency above maxItems is held to it", () => {
    expect(perItem({ maxItems: 3, maxConcurrency: 9 }).children[0]).toMatchObject({
      count: 3,
      atOnce: 3,
    });
  });
});

describe("#1366: a launch that is not per item", () => {
  it("names its limits without maxItems when only maxConcurrency is set, and counts no child", () => {
    const graph = graphOf(
      [
        node("S", ComponentKind.WorkflowStart),
        node("A", ComponentKind.Agent),
        node("B", ComponentKind.Agent),
      ],
      [
        edge("S", "A"),
        edge("A", "B", EdgeKind.Join, {
          launch: launchOf({ call: "inParallel", listed: ["B"], maxConcurrency: 3 }),
        }),
      ],
      ["S"],
    );

    expect(caseOf(graph)).toMatchObject({
      executions: 1,
      concurrentExecutions: 1,
      depth: 0,
      parts: ["maxConcurrency 3 on A → inParallel(B)"],
      children: [],
    });
  });

  it("names maxItems without maxConcurrency when only maxItems is set", () => {
    const graph = graphOf(
      [
        node("S", ComponentKind.WorkflowStart),
        node("A", ComponentKind.Agent),
        node("B", ComponentKind.Agent),
      ],
      [
        edge("S", "A"),
        edge("A", "B", EdgeKind.Join, {
          launch: launchOf({ call: "inParallel", listed: ["B"], items: {}, maxItems: 7 }),
        }),
      ],
      ["S"],
    );

    expect(caseOf(graph).parts).toEqual(["maxItems 7 on A → inParallel(B)"]);
  });

  it("a call that launches nothing has no children, no parts and depth 0", () => {
    const graph = graphOf(
      [
        node("S", ComponentKind.WorkflowStart),
        node("A", ComponentKind.Agent),
        node("F", ComponentKind.WorkflowFinish),
      ],
      [edge("S", "A"), edge("A", "F")],
      ["S"],
    );

    expect(caseOf(graph)).toStrictEqual({
      start: "S",
      workflow: "Object",
      executions: 1,
      concurrentExecutions: 1,
      steps: 1,
      isStepsCapped: false,
      treeSteps: 1,
      depth: 0,
      parts: [],
      children: [],
    });
  });
});

describe("#1366: a child behind a join or beside the launch", () => {
  it("a join edge into a child workflow starts one child, whatever the launch beside it says", () => {
    const worst = caseOf(
      parentOf(
        launchEdge(EdgeKind.Join, { items: {}, maxItems: 5, maxConcurrency: 2 }),
        CompanyReviewWorkflow,
      ),
    );

    expect(worst).toMatchObject({ executions: 2, concurrentExecutions: 2, depth: 1 });
    expect(worst.children[0]).toMatchObject({ count: 1, atOnce: 1 });
    expect(worst.children[0]).not.toHaveProperty("maxItems");
    expect(worst.children[0]).not.toHaveProperty("maxConcurrency");
  });

  it("a plain edge into a child workflow starts one child", () => {
    const worst = caseOf(parentOf(edge("A", "W"), CompanyReviewWorkflow));

    expect(worst).toMatchObject({ executions: 2, concurrentExecutions: 2, depth: 1 });
  });

  it("an edge into a component that is no workflow counts no child", () => {
    const worst = caseOf(parentOf(edge("A", "W"), Desk));

    expect(worst).toMatchObject({ executions: 1, depth: 0, children: [], parts: [] });
  });

  it("an edge into a node the graph does not have counts no child", () => {
    const graph = graphOf(
      [node("S", ComponentKind.WorkflowStart), node("A", ComponentKind.Agent)],
      [edge("S", "A"), edge("A", "Missing")],
      ["S"],
    );

    expect(caseOf(graph)).toMatchObject({ executions: 1, depth: 0, children: [], parts: [] });
  });

  it("a child launched from a step no start reaches counts nowhere", () => {
    const graph = graphOf(
      [
        node("S", ComponentKind.WorkflowStart),
        node("A", ComponentKind.Agent),
        workflowNode("W", CompanyReviewWorkflow),
      ],
      [edge("S", "A"), edge("Z", "W")],
      ["S"],
    );

    expect(caseOf(graph)).toMatchObject({ executions: 1, children: [] });
  });
});

describe("#1366: a child with several starts", () => {
  it("is held to its start with the most executions, the first of those that tie", () => {
    const worst = caseOf(parentOf(edge("A", "W")));
    const [child] = worst.children;

    expect(child?.worst).toMatchObject({ start: "two-first-start", executions: 2 });
    expect(worst).toMatchObject({ executions: 3, concurrentExecutions: 3, depth: 2 });
  });
});

describe("#1366: the steps of a start", () => {
  it("a start whose loop nothing bounds takes maxSteps, capped, and says so", () => {
    const graph = graphOf(
      [
        node("S", ComponentKind.WorkflowStart),
        node("A", ComponentKind.Agent),
        node("B", ComponentKind.Agent),
        node("F", ComponentKind.WorkflowFinish),
      ],
      [edge("S", "A"), edge("A", "B"), edge("B", "A"), edge("B", "F")],
      ["S"],
    );

    expect(caseOf(graph, { maxSteps: 8 })).toMatchObject({
      steps: 8,
      isStepsCapped: true,
      treeSteps: 8,
      parts: ["maxSteps 8"],
    });
  });

  it("a start that reaches a finish within maxSteps names no maxSteps among its parts", () => {
    const graph = graphOf(
      [
        node("S", ComponentKind.WorkflowStart),
        node("A", ComponentKind.Agent),
        node("F", ComponentKind.WorkflowFinish),
      ],
      [edge("S", "A"), edge("A", "F")],
      ["S"],
    );

    expect(caseOf(graph, { maxSteps: 8 })).toMatchObject({
      steps: 1,
      isStepsCapped: false,
      parts: [],
    });
  });
});

describe("#1366: the start log's line", () => {
  const withExecutions = (executions: number) =>
    worstCaseLine({ ...caseOf(parentOf(edge("A", "W"), Desk)), executions });

  it("says '1 workflow execution' for one, and the number for any other count", () => {
    expect(withExecutions(1)).toBe(
      "Worst case of one S call: 1 workflow execution, 1 at the same time, 1 steps",
    );
    expect(withExecutions(51)).toBe(
      "Worst case of one S call: 51 workflow executions, 1 at the same time, 1 steps",
    );
    expect(withExecutions(2)).toMatch(/: 2 workflow executions, /);
  });

  it("states the executions, those at once and the steps of a computed case", () => {
    const worst = caseOf(
      parentOf(
        launchEdge(EdgeKind.Launch, { items: {}, maxItems: 5, maxConcurrency: 2 }),
        CompanyReviewWorkflow,
      ),
    );

    expect(worstCaseLine(worst)).toBe(
      "Worst case of one S call: 6 workflow executions, 3 at the same time, 1 steps",
    );
  });
});

/** A workflow that launches itself, or the other one: mutual recursion, which the analyser refuses but still sizes. */
const throughBoth = (self: () => abstract new () => unknown, other: abstract new () => unknown) => [
  pathStart(CountdownWorkflowStart)
    .toAction(CountdownAction)
    .toOneOf([toWorkflow(self), toWorkflow(other)]),
];

describe("#1366: a workflow that launches itself inside a loop of workflows", () => {
  it("counts each workflow once along a chain of launches, the other one not again below the recursion", () => {
    @Workflow({
      name: "pong-case-workflow",
      version: "1.0.0",
      historyTtl: Ttl.Forever,
      flow: [],
      executionLimits: { maxDepth: 4 },
    })
    class PongCase {}
    @Workflow({
      name: "ping-case-workflow",
      version: "1.0.0",
      historyTtl: Ttl.Forever,
      flow: throughBoth(() => PingCase, PongCase),
      executionLimits: { maxDepth: 4 },
    })
    class PingCase {}
    Workflow({
      name: "pong-case-workflow",
      version: "1.0.0",
      historyTtl: Ttl.Forever,
      flow: throughBoth(() => PongCase, PingCase),
      executionLimits: { maxDepth: 4 },
    })(PongCase);

    const worst = checkWorkflow(PingCase).analysis?.worstCases ?? [];

    expect(worst.map((each) => [each.executions, each.depth])).toEqual([[15, 4]]);
  });
});
