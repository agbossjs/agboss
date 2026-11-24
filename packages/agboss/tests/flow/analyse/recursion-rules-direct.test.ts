/**
 * #1366: the recursion rules (#264 PR 1) and the tree's concurrency cap (#264 PR 2), called directly: each violation's
 * code, exact message and nodes, the boundary of a child's cap against its parent's, and what a chain of children
 * reports. The shard `assembly-rules` mutates `recursion.ts` of the rules whole.
 */
import { describe, expect, it } from "vitest";
import { RecursionDecider, type RecursiveBranch } from "../../../src/flow/analyse/recursion.js";
import type { AnalysisContext } from "../../../src/flow/analyse/rules/context.js";
import {
  concurrencyErrors,
  concurrencyWarnings,
  recursionRules,
} from "../../../src/flow/analyse/rules/recursion.js";
import { declarationOf } from "../../../src/flow/decorators/declaration.js";
import { Workflow, type WorkflowOptions } from "../../../src/flow/decorators/workflow.js";
import { onStart } from "../../helpers/flow.js";
import { named } from "./graph-fixture.js";
import {
  CountDoneWorkflowFinish,
  CountdownWorkflowStart,
} from "../runtime/fixtures/recursion.workflow.js";

type Flow = WorkflowOptions["flow"];

const shown = (found: readonly { code: string; message: string; nodes: readonly string[] }[]) =>
  found.map(({ code, message, nodes }) => ({ code, message, nodes }));

const contextOf = (workflow: object): AnalysisContext => ({ workflow, options: {} }) as never;

const launching = (other: abstract new () => unknown): Flow => [
  onStart(CountdownWorkflowStart).toWorkflow(other).toFinish(CountDoneWorkflowFinish),
];

const optionsOf = (target: abstract new () => unknown): WorkflowOptions => {
  const declaration = declarationOf(target);
  if (declaration === undefined || !("flow" in declaration.options)) throw new Error("no workflow");
  return declaration.options;
};

class Plain {
  readonly fixture = true;
}

describe("#1366: the depth of a recursive workflow", () => {
  const rules = (maxDepth: number | undefined) =>
    shown(
      recursionRules(contextOf({ name: "deep-workflow", flow: [] }), Plain, {
        maxDepth,
        branches: [],
      }),
    );

  it("names a missing maxDepth and one that is no whole number of levels from 1", () => {
    const tail =
      " — a recursive workflow bounds its levels: @Workflow({ executionLimits: { maxDepth: 4 } }) allows executions at depth 1 (the root) to 4";

    expect(rules(undefined)).toEqual([
      {
        code: "graph.recursion-without-depth",
        message: `it launches itself but sets no executionLimits.maxDepth${tail}`,
        nodes: ["deep-workflow"],
      },
    ]);
    for (const value of [0, -2, 1.5]) {
      expect(rules(value)).toEqual([
        {
          code: "graph.recursion-without-depth",
          message: `its executionLimits.maxDepth is ${String(value)}, not a whole number of levels from 1${tail}`,
          nodes: ["deep-workflow"],
        },
      ]);
    }
    expect(rules(1)).toEqual([]);
  });

  it("reads no depth rule for a workflow that never recurses", () => {
    expect(
      recursionRules(contextOf({ name: "flat-workflow", flow: [] }), Plain, undefined),
    ).toEqual([]);
  });
});

describe("#1366: the exit of a recursive branch", () => {
  const branch = (
    decider: RecursionDecider,
    options: string[],
    recursive: string[],
  ): RecursiveBranch => ({
    node: named("chooser"),
    decider,
    options,
    recursive,
  });
  const rules = (one: RecursiveBranch) =>
    shown(
      recursionRules(contextOf({ name: "exit-workflow", flow: [] }), Plain, {
        maxDepth: 2,
        branches: [one],
      }),
    );
  const tail =
    " — on the last level (depth === maxDepth) none is left; add a branch or a route that does not recurse";

  it("names a switch whose every case recurses, by its cases", () => {
    expect(rules(branch(RecursionDecider.Agent, ["AaDto", "BbDto"], ["AaDto", "BbDto"]))).toEqual([
      {
        code: "graph.recursion-without-exit",
        message: `chooser: every way on (.toOneOf([…]) branch AaDto, .toOneOf([…]) branch BbDto) launches the workflow itself${tail.replace(" — ", " — ")}`,
        nodes: ["chooser"],
      },
    ]);
  });

  it("names a router whose every route recurses, by its routes, either kind of router", () => {
    for (const decider of [RecursionDecider.ModelRouter, RecursionDecider.CodeRouter]) {
      expect(rules(branch(decider, ["r1", "r2"], ["r1", "r2"])).map((one) => one.message)).toEqual([
        `chooser: every way on (.onRoute(r1), .onRoute(r2)) launches the workflow itself${tail}`,
      ]);
    }
  });

  it("finds nothing in a branch that keeps a way to end", () => {
    expect(rules(branch(RecursionDecider.Data, ["a", "b"], ["a"]))).toEqual([]);
  });
});

describe("#1366: a workflow that launches itself through another", () => {
  it("finds nothing in a workflow whose flow names its own class: that is a recursion", () => {
    @Workflow({ name: "own-workflow", version: "1.0.0", flow: [] })
    class OwnWorkflow {
      readonly fixture = true;
    }
    Workflow({ name: "own-workflow", version: "1.0.0", flow: launching(OwnWorkflow) })(OwnWorkflow);

    expect(
      shown(recursionRules(contextOf(optionsOf(OwnWorkflow)), OwnWorkflow, undefined)),
    ).toEqual([]);
  });

  it("names the chain of two, three, and a child that is no workflow", () => {
    @Workflow({ name: "c-workflow", version: "1.0.0", flow: [] })
    class CWorkflow {
      readonly fixture = true;
    }
    @Workflow({ name: "b-workflow", version: "1.0.0", flow: launching(CWorkflow) })
    class BWorkflow {
      readonly fixture = true;
    }
    @Workflow({ name: "a-workflow", version: "1.0.0", flow: launching(BWorkflow) })
    class AWorkflow {
      readonly fixture = true;
    }
    Workflow({ name: "c-workflow", version: "1.0.0", flow: launching(AWorkflow) })(CWorkflow);

    expect(shown(recursionRules(contextOf(optionsOf(AWorkflow)), AWorkflow, undefined))).toEqual([
      {
        code: "graph.mutual-recursion",
        message:
          "a-workflow → b-workflow → c-workflow → a-workflow: mutual recursion is not supported — a workflow launches only itself (toWorkflow(() => ItsOwnClass)); merge the two into one recursive workflow",
        nodes: ["a-workflow", "b-workflow"],
      },
    ]);
  });

  it("finds nothing in a child that never comes back, even when two children share a grandchild", () => {
    @Workflow({ name: "leaf-workflow", version: "1.0.0", flow: [] })
    class LeafWorkflow {
      readonly fixture = true;
    }
    @Workflow({ name: "mid-workflow", version: "1.0.0", flow: launching(LeafWorkflow) })
    class MidWorkflow {
      readonly fixture = true;
    }
    @Workflow({ name: "top-workflow", version: "1.0.0", flow: launching(MidWorkflow) })
    class TopWorkflow {
      readonly fixture = true;
    }

    expect(recursionRules(contextOf(optionsOf(TopWorkflow)), TopWorkflow, undefined)).toEqual([]);
    expect(recursionRules(contextOf(optionsOf(MidWorkflow)), TopWorkflow, undefined)).toEqual([]);
  });

  it("ends on a cycle among the descendants that never comes back to the workflow", () => {
    @Workflow({ name: "ping-workflow", version: "1.0.0", flow: [] })
    class PingWorkflow {
      readonly fixture = true;
    }
    @Workflow({ name: "pong-workflow", version: "1.0.0", flow: launching(PingWorkflow) })
    class PongWorkflow {
      readonly fixture = true;
    }
    Workflow({ name: "ping-workflow", version: "1.0.0", flow: launching(PongWorkflow) })(
      PingWorkflow,
    );
    @Workflow({ name: "root-workflow", version: "1.0.0", flow: launching(PingWorkflow) })
    class RootWorkflow {
      readonly fixture = true;
    }

    expect(recursionRules(contextOf(optionsOf(RootWorkflow)), RootWorkflow, undefined)).toEqual([]);
  });
});

describe("#1366: the tree's concurrency cap", () => {
  it("names a cap that is no whole number of executions from 1", () => {
    for (const value of [0, 2.5, -1]) {
      expect(
        shown(
          concurrencyErrors(
            contextOf({ name: "cap-workflow", executionLimits: { maxConcurrency: value } }),
          ),
        ),
      ).toEqual([
        {
          code: "limits.max-concurrent-executions-invalid",
          message: `its executionLimits.maxConcurrency is ${String(value)}, not a whole number of executions from 1 — @Workflow({ executionLimits: { maxConcurrency: 6 } }) lets six executions of the tree work at once`,
          nodes: ["cap-workflow"],
        },
      ]);
    }
    expect(
      concurrencyErrors(
        contextOf({ name: "cap-workflow", executionLimits: { maxConcurrency: 1 } }),
      ),
    ).toEqual([]);
    expect(concurrencyErrors(contextOf({ name: "cap-workflow" }))).toEqual([]);
  });

  const parentOf = (cap: number | undefined, childCap: number | undefined): WorkflowOptions => {
    @Workflow({
      name: "capped-child-workflow",
      version: "1.0.0",
      flow: [],
      ...(childCap === undefined ? {} : { executionLimits: { maxConcurrency: childCap } }),
    })
    class ChildWorkflow {
      readonly fixture = true;
    }
    @Workflow({
      name: "capped-parent-workflow",
      version: "1.0.0",
      flow: launching(ChildWorkflow),
      ...(cap === undefined ? {} : { executionLimits: { maxConcurrency: cap } }),
    })
    class ParentWorkflow {
      readonly fixture = true;
    }
    return optionsOf(ParentWorkflow);
  };

  it("names a child whose cap is above its parent's, the default being 10", () => {
    expect(shown(concurrencyWarnings(contextOf(parentOf(4, 8))))).toEqual([
      {
        code: "limits.child-concurrency-above-parent",
        message:
          "capped-child-workflow sets executionLimits.maxConcurrency 8, above its parent's 4 — a child's cap limits its subtree inside its parent's tree, so it never goes above 4; lower it, or raise the parent's",
        nodes: ["capped-parent-workflow"],
      },
    ]);
    expect(
      concurrencyWarnings(contextOf(parentOf(undefined, 11))).map((one) => one.message),
    ).toEqual([expect.stringContaining("above its parent's 10")]);
  });

  it("finds nothing in a child at its parent's cap, below it, or with none of its own", () => {
    expect(concurrencyWarnings(contextOf(parentOf(4, 4)))).toEqual([]);
    expect(concurrencyWarnings(contextOf(parentOf(4, 3)))).toEqual([]);
    expect(concurrencyWarnings(contextOf(parentOf(4, undefined)))).toEqual([]);
    expect(concurrencyWarnings(contextOf(parentOf(undefined, 10)))).toEqual([]);
  });
});
