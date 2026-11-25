/**
 * #1366: the step bounds of a flow's graph (`maxSteps`, #261 AC17; the default's worst case, #273), on graphs built by
 * hand so each weight, each kind of edge and each message is read exactly. The shard `assembly-rules` mutates
 * `steps.ts` whole.
 */
import { LimitError } from "../../../src/core/error-families/limit-errors.js";
import { describe, expect, it } from "vitest";
import { EdgeKind } from "../../../src/flow/analyse/flow-graph.js";
import {
  maxStepsOf,
  mostRunning,
  mostStepsFrom,
  stepsRangeOf,
  stepsRules,
} from "../../../src/flow/analyse/steps.js";
import { NodeKind } from "../../../src/flow/ast.js";
import { branch, named, contextOf, edge, graphOf, join, node } from "./graph-fixture.js";

const start = (name: string) => node(name, NodeKind.Start);
const agent = (name: string) => node(name, NodeKind.Agent);
const router = (name: string) => node(name, NodeKind.Router);
const action = (name: string) => node(name, NodeKind.Action);
const finish = (name: string) => node(name, NodeKind.Finish);

const FLOW = "flow-workflow";
const found = (graph: ReturnType<typeof graphOf>, maxSteps?: unknown) =>
  stepsRules(contextOf(graph, maxSteps)).map(({ code, message, nodes }) => ({
    code,
    message,
    nodes,
  }));

const tooLow = (graph: ReturnType<typeof graphOf>, maxSteps?: unknown) =>
  found(graph, maxSteps).filter((one) => one.code === "limits.max-steps-too-low");

/** S -> A -> B -> F: two agent visits. */
const chain = graphOf(
  [start("S"), agent("A"), router("B"), finish("F")],
  [edge("S", "A"), edge("A", "B"), edge("B", "F")],
  ["S"],
);

describe("#1366: a hand-set maxSteps against the shortest path", () => {
  it("names a start whose shortest path takes more steps than maxSteps, an agent and a router each one step", () => {
    expect(found(chain, 1)).toEqual([
      {
        code: "limits.max-steps-too-low",
        message: "the shortest path from S takes 2 steps, but maxSteps is 1",
        nodes: ["S"],
      },
    ]);
    expect(found(chain, 2)).toEqual([]);
    expect(found(chain, 0).map((one) => one.message)).toEqual([
      "the shortest path from S takes 2 steps, but maxSteps is 0",
    ]);
  });

  it("takes the shorter of two ways out", () => {
    const graph = graphOf(
      [start("S"), agent("A"), agent("B"), agent("C"), finish("F")],
      [edge("S", "A"), edge("A", "B"), edge("B", "F"), edge("S", "C"), edge("C", "F")],
      ["S"],
    );

    expect(tooLow(graph, 1)).toEqual([]);
  });

  it("counts a step limit's handler as a way out, a parent class of it too, and no other error", () => {
    const withHandler = (error: unknown) =>
      graphOf(
        [start("S"), agent("A"), agent("B"), action("H"), finish("F")],
        [edge("S", "A"), edge("A", "B"), edge("B", "F"), edge("A", "H", EdgeKind.Error, { error })],
        ["S"],
      );

    expect(tooLow(withHandler(LimitError.Steps), 1)).toEqual([]);
    expect(tooLow(withHandler(Object.getPrototypeOf(LimitError.Steps)), 1)).toEqual([]);
    expect(tooLow(withHandler(RangeError), 1)).toHaveLength(1);
    expect(tooLow(withHandler(undefined), 1)).toHaveLength(1);
  });

  it("does not take an error or a join-error edge for a way on", () => {
    const viaError = (kind: EdgeKind) =>
      graphOf(
        [start("S"), agent("A"), agent("B"), finish("F")],
        [
          edge("S", "A"),
          edge("A", "B"),
          edge("B", "F"),
          edge("A", "F", kind, { error: RangeError }),
        ],
        ["S"],
      );

    expect(tooLow(viaError(EdgeKind.Error), 1)).toHaveLength(1);
    expect(tooLow(viaError(EdgeKind.JoinError), 1)).toHaveLength(1);
    expect(tooLow(viaError(EdgeKind.Next), 1)).toEqual([]);
  });

  it("counts the branches a join always waits for, once per copy, and not a launch edge or an optional branch", () => {
    const launched = (perItem?: { maxItems?: number }) =>
      graphOf(
        [start("S"), agent("L"), agent("B1"), agent("B2"), finish("F")],
        [
          edge("S", "L"),
          edge("L", "B1", EdgeKind.Launch),
          edge("L", "B2", EdgeKind.Launch),
          join("L", "F", [branch("B1", 2, true), branch("B2", 1, false)], perItem),
        ],
        ["S"],
      );

    expect(found(launched(), 2)).toEqual([
      {
        code: "limits.max-steps-too-low",
        message: "the shortest path from S takes 3 steps, but maxSteps is 2",
        nodes: ["S"],
      },
    ]);
    expect(found(launched(), 3)).toEqual([]);
    expect(found(launched({ maxItems: 4 }), 1)).toEqual([]);
  });
});

describe("#1366: a hand-set maxSteps against every path through a node", () => {
  const graph = graphOf(
    [start("S"), agent("x"), agent("zz"), agent("aa"), finish("F")],
    [edge("S", "x"), edge("x", "F"), edge("S", "zz"), edge("zz", "aa"), edge("aa", "F")],
    ["S"],
  );

  it("names the nodes every path through takes too many steps for, in name order", () => {
    expect(found(graph, 1)).toEqual([
      {
        code: "limits.branch-exceeds-max-steps",
        message: "every path through aa takes at least 2 steps, but maxSteps is 1",
        nodes: ["aa"],
      },
      {
        code: "limits.branch-exceeds-max-steps",
        message: "every path through zz takes at least 2 steps, but maxSteps is 1",
        nodes: ["zz"],
      },
    ]);
    expect(found(graph, 2)).toEqual([]);
  });

  it("reads only the starts whose own shortest path fits, and a node with no way to a finish is none", () => {
    const stuck = graphOf(
      [start("S"), agent("A"), agent("Dead")],
      [edge("S", "A"), edge("A", "Dead")],
      ["S"],
    );

    expect(found(stuck, 0)).toEqual([]);
  });

  it("counts an action as a step (#1278), a start as none", () => {
    const quiet = graphOf(
      [start("S"), action("X"), agent("A"), finish("F")],
      [edge("S", "X"), edge("X", "A"), edge("A", "F")],
      ["S"],
    );

    expect(found(quiet, 2)).toEqual([]);
    expect(found(quiet, 1).map((one) => one.message)).toEqual([
      "the shortest path from S takes 2 steps, but maxSteps is 1",
    ]);
  });
});

describe("#1366: maxSteps that is not a count, or unused", () => {
  it("names a value that is no whole number from 0, by its kind and never its text", () => {
    for (const [value, shown] of [
      [-1, "-1"],
      [1.5, "1.5"],
      [null, "null"],
      ["ten", "a string"],
    ] as const) {
      expect(found(chain, value)).toEqual([
        {
          code: "limits.count-invalid",
          message: `${FLOW} has executionLimits.maxSteps: ${shown}, not a whole number of steps from 0 — @Workflow({ executionLimits: { maxSteps: 12 } }) sets it; leave it out for the default`,
          nodes: [FLOW],
        },
      ]);
    }
  });

  it("names a maxSteps on a flow with no agent, router, action or external task", () => {
    const none = graphOf([start("S"), finish("F")], [edge("S", "F")], ["S"]);

    expect(found(none, 5)).toEqual([
      {
        code: "limits.max-steps-unused",
        message: `${FLOW} has executionLimits.maxSteps: 5, but it has no agent, router, action or external task — steps are always 0; remove maxSteps`,
        nodes: [],
      },
    ]);
  });
});

describe("#1366: the default maxSteps against the worst case", () => {
  const wide = (maxItems: number | undefined) =>
    graphOf(
      [start("S"), agent("L"), agent("B"), finish("F")],
      [
        edge("S", "L"),
        edge("L", "B", EdgeKind.Launch),
        join("L", "F", [branch("B", 1, true)], { maxItems }),
      ],
      ["S"],
    );

  it("names a start whose worst case is above (agents + routers) x 3", () => {
    expect(found(wide(10))).toEqual([
      {
        code: "limits.max-steps-too-low",
        message:
          "the worst case from S takes 11 steps, but the default maxSteps (agents + routers + actions + external tasks) × 3 is 6 — set @Workflow({ executionLimits: { maxSteps } })",
        nodes: ["S"],
      },
    ]);
  });

  it("accepts a worst case at the limit, and one no number bounds", () => {
    expect(found(wide(5))).toEqual([]);
    expect(found(wide(undefined))).toEqual([]);
  });

  it("counts only agents and routers toward the limit", () => {
    expect(found(wide(5), undefined)).toEqual([]);
    const withAction = graphOf(
      [start("S"), action("X"), agent("L"), agent("B"), finish("F")],
      [
        edge("S", "X"),
        edge("X", "L"),
        edge("L", "B", EdgeKind.Launch),
        join("L", "F", [branch("B", 1, true)], { maxItems: 5 }),
      ],
      ["S"],
    );

    expect(found(withAction)).toEqual([]);
  });

  it("leaves a cycle to maxSteps itself", () => {
    const cycle = graphOf(
      [start("S"), agent("A"), finish("F")],
      [edge("S", "A"), edge("A", "A"), edge("A", "F")],
      ["S"],
    );

    expect(found(cycle)).toEqual([]);
  });
});

describe("#1366: mostRunning, mostStepsFrom and stepsRangeOf", () => {
  const wideJoin = graphOf(
    [start("S"), agent("L"), agent("B"), router("R"), finish("F")],
    [
      edge("S", "L"),
      join("L", "F", [branch("B", 2, true), branch("R", 3, false)], { maxItems: 4 }),
    ],
    ["S"],
  );
  const joinEdge = wideJoin.edges[1];

  it("counts every copy of every branch, a per-item launch maxItems times", () => {
    expect(joinEdge && mostRunning(wideJoin, joinEdge)).toBe(20);
    const single = graphOf([agent("B"), finish("F")], [join("B", "F", [branch("B", 2, true)])], []);
    const only = single.edges[0];

    expect(only && mostRunning(single, only)).toBe(2);
  });

  it("counts none for an edge that is no join, and none known for a per-item launch without maxItems", () => {
    const plain = wideJoin.edges[0];
    const open = graphOf([agent("B")], [join("B", "B", [branch("B", 1, true)], {})], []);
    const openEdge = open.edges[0];

    expect(plain && mostRunning(wideJoin, plain)).toBe(0);
    expect(openEdge && mostRunning(open, openEdge)).toBeUndefined();
  });

  it("reads the longest way, and none for a cycle", () => {
    expect(mostStepsFrom(chain, named("S"))).toBe(2);
    expect(mostStepsFrom(wideJoin, named("S"))).toBe(21);
    const cycle = graphOf([agent("A")], [edge("A", "A")], ["A"]);

    expect(mostStepsFrom(cycle, named("A"))).toBeUndefined();
  });

  it("takes the longest of several ways, and reads each node once", () => {
    const stages = 14;
    const names = Array.from({ length: stages }, (_, at) => [`l${String(at)}`, `r${String(at)}`]);
    const nodes = [start("S"), finish("F"), ...names.flat().map(agent), agent("m")];
    const edges = [edge("S", "m")];
    let before = "m";
    for (const [left, right] of names) {
      edges.push(edge(before, left ?? ""), edge(before, right ?? ""));
      before = `j${String(edges.length)}`;
      nodes.push(agent(before));
      edges.push(edge(left ?? "", before), edge(right ?? "", before));
    }
    edges.push(edge(before, "F"));
    let reads = 0;
    const graph = graphOf(nodes, [], ["S"]);
    Object.defineProperty(graph, "edges", {
      get() {
        reads += 1;
        return edges;
      },
    });

    expect(mostStepsFrom(graph, named("S"))).toBe(1 + stages * 2);
    expect(reads).toBeLessThanOrEqual(nodes.length);
  });

  it("gives the fewest and the most steps of a flow, from every start", () => {
    expect(stepsRangeOf(chain)).toStrictEqual({ least: 2, most: 2 });
    const two = graphOf(
      [start("S1"), start("S2"), agent("A"), agent("B"), finish("F")],
      [edge("S1", "A"), edge("A", "F"), edge("S2", "B"), edge("B", "A")],
      ["S1", "S2"],
    );

    expect(stepsRangeOf(two)).toStrictEqual({ least: 1, most: 2 });
    const mixed = graphOf(
      [start("S1"), start("S2"), agent("A"), agent("B"), finish("F")],
      [edge("S1", "B"), edge("B", "F"), edge("S2", "A"), edge("A", "A")],
      ["S1", "S2"],
    );

    expect(stepsRangeOf(mixed)).toStrictEqual({ least: 1 });
  });

  it("gives no most for a cycle, and a least of 0 for a flow with no way out", () => {
    const cycle = graphOf([start("S"), agent("A")], [edge("S", "A"), edge("A", "A")], ["S"]);
    const none = graphOf([start("S")], [], ["S"]);

    expect(stepsRangeOf(cycle)).toStrictEqual({ least: 0 });
    expect(stepsRangeOf(none)).toStrictEqual({ least: 0, most: 0 });
  });
});

describe("#1366: the steps limit a run takes", () => {
  it("is the maxSteps that is set, 0 included, else (agents + routers) x 3", () => {
    expect(maxStepsOf(chain, 7)).toBe(7);
    expect(maxStepsOf(chain, 0)).toBe(0);
    expect(maxStepsOf(chain, undefined)).toBe(6);
    const quiet = graphOf([start("S"), finish("F")], [], ["S"]);

    expect(maxStepsOf(quiet, undefined)).toBe(0);
    expect(maxStepsOf(graphOf([start("S"), action("X"), finish("F")], [], ["S"]), undefined)).toBe(
      3,
    );
  });
});

describe("#1366: a weight that is no number fails closed", () => {
  /** S -> L, whose join waits for an agent launched NaN times, -> F. */
  const unbounded = graphOf(
    [start("S"), agent("L"), agent("X"), finish("F")],
    [
      edge("S", "L"),
      edge("L", "X", EdgeKind.Launch),
      join("L", "F", [branch("X", Number.NaN, true)]),
    ],
    ["S"],
  );

  it("is an unbounded path: the way out takes NaN steps, so no hand-set maxSteps holds it", () => {
    expect(tooLow(unbounded, 1000).map((one) => one.message)).toEqual([
      "the shortest path from S takes NaN steps, but maxSteps is 1000",
    ]);
  });

  it("a longer way found first does not keep a shorter one found later out", () => {
    // listed so that the way out through B is walked back before the direct one
    const graph = graphOf(
      [start("S"), agent("A"), agent("B"), finish("F")],
      [edge("B", "F"), edge("A", "B"), edge("S", "A"), edge("S", "F")],
      ["S"],
    );

    expect(tooLow(graph, 0)).toEqual([]);
  });

  it("ends the walk on a cycle through it, and takes the finite way out when there is one", () => {
    const cycle = graphOf(
      [start("S"), agent("L"), agent("X"), finish("F")],
      [
        edge("S", "L"),
        edge("L", "X", EdgeKind.Launch),
        join("L", "L", [branch("X", Number.NaN, true)]),
        edge("L", "F"),
      ],
      ["S"],
    );

    expect(tooLow(cycle, 1)).toEqual([]);
    expect(tooLow(cycle, 0)).toHaveLength(1);
  });
});

describe("#1366: what the bounds read of a graph's edges", () => {
  it("counts an action branch as a step, once per copy (#1278)", () => {
    const graph = graphOf(
      [start("S"), agent("L"), action("X"), finish("F")],
      [edge("S", "L"), edge("L", "X", EdgeKind.Launch), join("L", "F", [branch("X", 3, true)])],
      ["S"],
    );

    expect(found(graph, 4)).toEqual([]);
    expect(found(graph, 3).map((one) => one.message)).toEqual([
      "the shortest path from S takes 4 steps, but maxSteps is 3",
    ]);
  });

  it("reads a node the graph does not hold as no step", () => {
    const graph = graphOf(
      [start("S"), agent("A"), finish("F")],
      [edge("S", "A"), edge("A", "F"), edge("S", "Ghost"), edge("Ghost", "F")],
      ["S"],
    );

    expect(found(graph, 1)).toEqual([]);
    expect(mostStepsFrom(graph, named("S"))).toBe(1);
  });

  it("counts a launch edge on its join, not as a way on", () => {
    const graph = graphOf(
      [start("S"), agent("L"), agent("B"), finish("F")],
      [edge("S", "L"), edge("L", "F"), edge("L", "B", EdgeKind.Launch), edge("B", "F")],
      ["S"],
    );

    expect(found(graph, 1)).toEqual([]);
  });

  it("counts the branches of a join only on a join edge, not on a join-error edge", () => {
    const launch = { branches: [branch("B", 3, true)] };
    const graph = graphOf(
      [start("S"), agent("L"), action("H"), agent("M"), agent("B"), finish("F")],
      [
        edge("S", "L"),
        edge("L", "F"),
        edge("L", "H", EdgeKind.JoinError, { launch, error: RangeError }),
        edge("H", "M"),
        edge("M", "F"),
      ],
      ["S"],
    );
    const errorEdge = graph.edges[2];

    expect(found(graph, 3)).toEqual([]);
    expect(errorEdge && mostRunning(graph, errorEdge)).toBe(0);
  });

  it("leaves a node with no way to a finish out of the bounds", () => {
    const graph = graphOf(
      [start("S"), agent("A"), agent("Dead"), finish("F")],
      [edge("S", "A"), edge("A", "F"), edge("S", "Dead")],
      ["S"],
    );

    expect(found(graph, 1)).toEqual([]);
  });

  it("reads the longest way from the start's own edges, not from every edge of the flow", () => {
    const graph = graphOf(
      [start("S"), finish("F"), agent("X"), agent("Y"), agent("Z")],
      [edge("S", "F"), edge("X", "Y"), edge("Y", "Z")],
      ["S"],
    );

    expect(mostStepsFrom(graph, named("S"))).toBe(0);
  });
});

describe("#1366: a launch edge is no way on", () => {
  it("does not follow a launch edge to a branch that goes on, but counts the branch on its join", () => {
    const graph = graphOf(
      [start("S"), agent("L"), agent("B"), agent("C"), agent("D"), finish("F")],
      [
        edge("S", "L"),
        edge("L", "B", EdgeKind.Launch),
        edge("B", "C"),
        edge("C", "D"),
        edge("D", "F"),
        join("L", "F", [branch("B", 1, true)]),
      ],
      ["S"],
    );

    expect(mostStepsFrom(graph, named("S"))).toBe(2);
  });
});
