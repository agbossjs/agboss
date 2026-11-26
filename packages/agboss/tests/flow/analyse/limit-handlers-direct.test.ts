/**
 * #1366: no model call after a limit (#263, #272), on graphs built by hand: which handlers can catch a limit (its class,
 * a subclass, a parent), which nodes after one spend, the exact message and the nodes it names, and a join's handler.
 * The shard `assembly-rules` mutates `limit-handlers.ts` of the rules whole.
 */
import type { FlowNodeKind } from "../../../src/flow/ast.js";
import { ComponentKind } from "../../../src/flow/runtime/records.js";
import { LimitError } from "../../../src/core/error-families/limit-errors.js";
import { describe, expect, it } from "vitest";
import { EdgeKind } from "../../../src/flow/analyse/flow-graph.js";
import type { AnalysisContext } from "../../../src/flow/analyse/rules/context.js";
import { catchesLimit, limitHandlerRules } from "../../../src/flow/analyse/rules/limit-handlers.js";
import { AGBossError } from "../../../src/core/errors.js";
import { edge, graphOf, node } from "./graph-fixture.js";

const TAIL =
  " — after a limit a side path leads only to actions and finishes (no model call past a limit); catch a narrower class, or end the side path with toAction(…) / toFinish(…)";

const kinds = [
  ["agent", ComponentKind.Agent],
  ["router", ComponentKind.Router],
  ["child", ComponentKind.Workflow],
  ["task", ComponentKind.ExternalTask],
] as const;

/** A step `A` whose `.onError(error, …)` leads to `H`, an action; `H` goes on to the nodes given. */
const handled = (error: unknown, after: readonly (readonly [string, FlowNodeKind])[] = []) => {
  const nodes = [
    node("A", ComponentKind.Agent),
    node("H", ComponentKind.Action),
    node("F", ComponentKind.WorkflowFinish),
    ...after.map(([name, kind]) => node(name, kind)),
  ];
  const edges = [
    edge("A", "H", EdgeKind.Error, { error }),
    ...after.map(([name]) => edge("H", name)),
    edge("H", "F"),
  ];
  return {
    graph: graphOf(nodes, edges, []),
    walked: {
      errorHandlers: [{ node: "A", step: { error } }],
      joinErrorHandlers: [],
    },
  };
};

const rules = (context: object) =>
  limitHandlerRules(context as AnalysisContext).map(({ code, message, nodes }) => ({
    code,
    message,
    nodes,
  }));

describe("#1366: which handlers catch a limit", () => {
  it("is a limit's class, a subclass or a parent, and no other error", () => {
    expect(catchesLimit(LimitError)).toBe(true);
    expect(catchesLimit(LimitError.Steps)).toBe(true);
    expect(catchesLimit(AGBossError)).toBe(true);
    expect(catchesLimit(Error)).toBe(true);
    expect(catchesLimit(RangeError)).toBe(false);
    expect(
      catchesLimit(
        class Mine {
          readonly fixture = true;
        } as never,
      ),
    ).toBe(false);
  });
});

describe("#1366: what a side path after a limit reaches", () => {
  it("finds nothing in a side path of actions and finishes", () => {
    expect(rules(handled(LimitError))).toEqual([]);
  });

  it("names a side path that reaches a model call, a router, a child workflow or a question, by the handler's class", () => {
    for (const [name, kind] of kinds) {
      expect(rules(handled(LimitError, [[name, kind]]))).toEqual([
        {
          code: "graph.limit-handler-uses-model",
          message: `A: .onError(LimitError, …) can catch a limit and reaches ${name}${TAIL}`,
          nodes: ["A", name],
        },
      ]);
    }
  });

  it("names a subclass handler and a parent handler, and skips one of an unrelated class", () => {
    const after = [["M", ComponentKind.Agent]] as const;

    expect(rules(handled(LimitError.Steps, after))[0]?.message).toContain(
      ".onError(LimitError.Steps, …)",
    );
    expect(rules(handled(Error, after))[0]?.message).toContain(".onError(Error, …)");
    expect(rules(handled(RangeError, after))).toEqual([]);
  });

  it("lists every node reached, sorted, and each once", () => {
    const found = rules(
      handled(LimitError, [
        ["zeta", ComponentKind.Agent],
        ["alpha", ComponentKind.Router],
      ]),
    );

    expect(found.map((one) => one.message)).toEqual([
      `A: .onError(LimitError, …) can catch a limit and reaches alpha, zeta${TAIL}`,
    ]);
    expect(found[0]?.nodes).toEqual(["A", "alpha", "zeta"]);
  });

  it("reads only the side path the handler enters, not the rest of the flow", () => {
    const context = handled(LimitError);
    const other = graphOf(
      [...context.graph.nodes.values(), node("Z", ComponentKind.Agent)],
      [...context.graph.edges, edge("A", "Z")],
      [],
    );

    expect(rules({ ...context, graph: other })).toEqual([]);
  });

  it("takes the edge of this handler's error from this node, not another's", () => {
    const base = handled(LimitError, [["M", ComponentKind.Agent]]);
    const wrongError = graphOf(
      [...base.graph.nodes.values()],
      [edge("A", "H", EdgeKind.Error, { error: RangeError }), edge("H", "M")],
      [],
    );
    const wrongNode = graphOf(
      [...base.graph.nodes.values(), node("B", ComponentKind.Agent)],
      [edge("B", "H", EdgeKind.Error, { error: LimitError }), edge("H", "M")],
      [],
    );
    const wrongKind = graphOf(
      [...base.graph.nodes.values()],
      [edge("A", "H", EdgeKind.Next, { error: LimitError }), edge("H", "M")],
      [],
    );

    expect(rules({ ...base, graph: wrongError })).toEqual([]);
    expect(rules({ ...base, graph: wrongNode })).toEqual([]);
    expect(rules({ ...base, graph: wrongKind })).toEqual([]);
  });

  it("leaves out a node the graph does not hold", () => {
    const base = handled(LimitError);
    const ghost = graphOf(
      [...base.graph.nodes.values()],
      [...base.graph.edges, edge("H", "Ghost")],
      [],
    );

    expect(rules({ ...base, graph: ghost })).toEqual([]);
  });

  it("reports one problem once when two handlers say the same", () => {
    const one = handled(LimitError, [["M", ComponentKind.Agent]]);
    const twice = {
      ...one,
      walked: {
        ...one.walked,
        errorHandlers: [...one.walked.errorHandlers, ...one.walked.errorHandlers],
      },
    };

    expect(rules(twice)).toHaveLength(1);
  });
});

describe("#1366: a join's handler", () => {
  const launch = { launcher: "L", call: "inParallel", listed: ["B1", "B2"], branches: [] };
  const joined = (error: unknown, after: readonly (readonly [string, FlowNodeKind])[]) => ({
    graph: graphOf(
      [
        node("L", ComponentKind.Agent),
        node("H", ComponentKind.Action),
        ...after.map(([name, kind]) => node(name, kind)),
      ],
      [
        edge("L", "H", EdgeKind.JoinError, { error, launch }),
        ...after.map(([name]) => edge("H", name)),
      ],
      [],
    ),
    walked: { errorHandlers: [], joinErrorHandlers: [{ node: "L", launch, handler: { error } }] },
  });

  it("names a join's side path that reaches a model call, by the launch", () => {
    expect(rules(joined(LimitError, [["M", ComponentKind.Agent]]))).toEqual([
      {
        code: "graph.limit-handler-uses-model",
        message: `the join of L → inParallel(B1, B2): .onError(LimitError, …) can catch a limit and reaches M${TAIL}`,
        nodes: ["L", "M"],
      },
    ]);
  });

  it("takes the join error edge of this launch, this error and this kind only", () => {
    const base = joined(LimitError, [["M", ComponentKind.Agent]]);
    const nodes = [...base.graph.nodes.values()];
    const otherError = graphOf(
      nodes,
      [edge("L", "H", EdgeKind.JoinError, { error: RangeError, launch }), edge("H", "M")],
      [],
    );
    const otherKind = graphOf(
      nodes,
      [edge("L", "H", EdgeKind.Error, { error: LimitError, launch }), edge("H", "M")],
      [],
    );

    expect(rules({ ...base, graph: otherError })).toEqual([]);
    expect(rules({ ...base, graph: otherKind })).toEqual([]);
  });

  it("finds nothing past a handler that is no limit's, or a join error edge of another launch", () => {
    expect(rules(joined(RangeError, [["M", ComponentKind.Agent]]))).toEqual([]);
    const other = joined(LimitError, [["M", ComponentKind.Agent]]);
    const elsewhere = graphOf(
      [...other.graph.nodes.values()],
      [edge("L", "H", EdgeKind.JoinError, { error: LimitError, launch: {} }), edge("H", "M")],
      [],
    );

    expect(rules({ ...other, graph: elsewhere })).toEqual([]);
  });
});
