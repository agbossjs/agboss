/**
 * #1366: the components of a flow's graph and the worst case a hand-set `maxSteps` is held against (#643), on graphs
 * built by hand: Tarjan's components, what makes one a cycle, the most steps inside a loop its `maxVisits` bound, the
 * longest way on over the components and the warning's exact message. The shard `assembly-rules` mutates
 * `strongly-connected.ts` whole.
 */
import { describe, expect, it } from "vitest";
import { EdgeKind } from "../../../src/flow/analyse/flow-graph.js";
import {
  boundedStepsFrom,
  isCycle,
  stronglyConnected,
  worstCaseStepsWarnings,
} from "../../../src/flow/analyse/strongly-connected.js";
import { NodeKind } from "../../../src/flow/ast.js";
import { StepsLimitExceededError } from "../../../src/graph/limits.js";
import { branch, named, contextOf, edge, graphOf, join, node } from "./graph-fixture.js";

const start = (name: string) => node(name, NodeKind.Start);
const agent = (name: string, maxVisits?: unknown) => node(name, NodeKind.Agent, maxVisits);
const finish = (name: string) => node(name, NodeKind.Finish);

const successorsOf = (table: Record<string, string[]>) => (vertex: string) => table[vertex] ?? [];

describe("#1366: stronglyConnected and isCycle", () => {
  it("gives each component sorted, in Tarjan's order, singles included", () => {
    const table = { a: ["b"], b: ["c"], c: ["a", "d"], d: ["e"], e: ["d"], f: [] };

    expect(stronglyConnected(["a", "b", "c", "d", "e", "f"], successorsOf(table))).toEqual([
      ["d", "e"],
      ["a", "b", "c"],
      ["f"],
    ]);
    expect(stronglyConnected([], successorsOf({}))).toEqual([]);
  });

  it("visits a vertex once, and reads the low link of a vertex still on the stack", () => {
    const table = { a: ["b", "c"], b: ["c"], c: ["a"] };

    expect(stronglyConnected(["a", "b", "c"], successorsOf(table))).toEqual([["a", "b", "c"]]);
    const cross = { a: ["b"], b: [], c: ["b"] };

    expect(stronglyConnected(["a", "b", "c"], successorsOf(cross))).toEqual([["b"], ["a"], ["c"]]);
  });

  it("calls two vertices or a vertex with an edge to itself a cycle, and no lone vertex", () => {
    const table = { a: ["a"], b: [], c: ["d"], d: ["c"] };
    const successors = successorsOf(table);

    expect(isCycle(["a"], successors)).toBe(true);
    expect(isCycle(["b"], successors)).toBe(false);
    expect(isCycle(["c", "d"], successors)).toBe(true);
    expect(isCycle([], successors)).toBe(false);
  });
});

/** S -> A <-> B -> F, with `maxVisits` on A. */
const loop = (maxVisits: unknown, kind: NodeKind = NodeKind.Agent) =>
  graphOf(
    [start("S"), node("A", kind, maxVisits), agent("B"), finish("F")],
    [edge("S", "A"), edge("A", "B"), edge("B", "A"), edge("B", "F")],
    ["S"],
  );

const warned = (graph: ReturnType<typeof graphOf>, maxSteps?: unknown) =>
  worstCaseStepsWarnings(contextOf(graph, maxSteps)).map(({ code, message, nodes }) => ({
    code,
    message,
    nodes,
  }));

describe("#1366: the most steps from a start", () => {
  it("counts a loop's bounded nodes maxVisits times and the free ones between their visits", () => {
    expect(boundedStepsFrom(loop(3), named("S"))).toEqual({ most: 7, loops: ["A (maxVisits 3)"] });
    expect(boundedStepsFrom(loop(0), named("S"))).toEqual({ most: 1, loops: ["A (maxVisits 0)"] });
  });

  it("reads a router's and a question's maxVisits, and a value that is no count as 0", () => {
    expect(boundedStepsFrom(loop(2, NodeKind.Router), named("S"))).toEqual({
      most: 5,
      loops: ["A (maxVisits 2)"],
    });
    expect(boundedStepsFrom(loop(2, NodeKind.Question), named("S"))).toEqual({
      most: 3,
      loops: ["A (maxVisits 2)"],
    });
    expect(boundedStepsFrom(loop("x"), named("S"))).toEqual({
      most: 1,
      loops: ["A (maxVisits 0)"],
    });
  });

  it("gives no bound to a loop no maxVisits stops, an action's maxVisits being none", () => {
    expect(boundedStepsFrom(loop(undefined), named("S"))).toBeUndefined();
    expect(boundedStepsFrom(loop(3, NodeKind.Action), named("S"))).toBeUndefined();
  });

  it("gives no bound to a loop with a free cycle beside its bounded node", () => {
    const graph = graphOf(
      [start("S"), agent("A", 2), agent("B"), agent("C"), finish("F")],
      [
        edge("S", "A"),
        edge("A", "B"),
        edge("B", "C"),
        edge("C", "B"),
        edge("B", "A"),
        edge("B", "F"),
      ],
      ["S"],
    );

    expect(boundedStepsFrom(graph, named("S"))).toBeUndefined();
  });

  it("gives no bound to a loop with a launch inside, and none to a start that is no node", () => {
    const graph = graphOf(
      [start("S"), agent("A", 2), agent("B"), finish("F")],
      [edge("S", "A"), join("A", "B", [branch("B", 1, true)]), edge("B", "A"), edge("B", "F")],
      ["S"],
    );

    expect(boundedStepsFrom(graph, named("S"))).toBeUndefined();
    expect(boundedStepsFrom(loop(3), named("nowhere"))).toBeUndefined();
  });

  it("counts a launch edge on its join, and gives no bound to a per-item launch without maxItems", () => {
    const launched = (perItem?: { maxItems?: number }) =>
      graphOf(
        [start("S"), agent("L"), agent("B"), finish("F")],
        [
          edge("S", "L"),
          edge("L", "B", EdgeKind.Launch),
          join("L", "F", [branch("B", 2, true)], perItem),
        ],
        ["S"],
      );

    expect(boundedStepsFrom(launched(), named("S"))).toEqual({ most: 3, loops: [] });
    expect(boundedStepsFrom(launched({ maxItems: 3 }), named("S"))).toEqual({ most: 7, loops: [] });
    expect(boundedStepsFrom(launched({}), named("S"))).toBeUndefined();
  });

  it("takes the longest way on, with the loops of that way, and each loop once", () => {
    const graph = graphOf(
      [start("S"), agent("A", 1), agent("B"), agent("C", 2), agent("D"), agent("E"), finish("F")],
      [
        edge("S", "A"),
        edge("A", "B"),
        edge("B", "A"),
        edge("B", "F"),
        edge("S", "C"),
        edge("C", "D"),
        edge("D", "C"),
        edge("D", "E"),
        edge("E", "F"),
      ],
      ["S"],
    );

    expect(boundedStepsFrom(graph, named("S"))).toEqual({ most: 6, loops: ["C (maxVisits 2)"] });
  });

  it("joins the loops it passes in order", () => {
    const graph = graphOf(
      [start("S"), agent("A", 1), agent("B"), agent("C", 1), agent("D"), finish("F")],
      [
        edge("S", "A"),
        edge("A", "B"),
        edge("B", "A"),
        edge("B", "C"),
        edge("C", "D"),
        edge("D", "C"),
        edge("D", "F"),
      ],
      ["S"],
    );

    expect(boundedStepsFrom(graph, named("S"))).toEqual({
      most: 6,
      loops: ["A (maxVisits 1)", "C (maxVisits 1)"],
    });
  });

  it("reads each component once however many ways reach it", () => {
    const stages = 12;
    const nodes = [start("S"), finish("F")];
    const edges = [edge("S", "j0")];
    nodes.push(agent("j0"));
    for (let at = 0; at < stages; at += 1) {
      const [left, right, next] = [`l${String(at)}`, `r${String(at)}`, `j${String(at + 1)}`];
      nodes.push(agent(left), agent(right), agent(next));
      edges.push(edge(`j${String(at)}`, left), edge(`j${String(at)}`, right));
      edges.push(edge(left, next), edge(right, next));
    }
    edges.push(edge(`j${String(stages)}`, "F"));
    let reads = 0;
    const graph = graphOf(nodes, [], ["S"]);
    Object.defineProperty(graph, "nodes", { value: new Map(nodes.map((one) => [one.name, one])) });
    const counted = new Proxy(edges, {
      get(target, key, receiver) {
        if (key === "filter") reads += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    Object.defineProperty(graph, "edges", { value: counted });

    expect(boundedStepsFrom(graph, named("S"))).toEqual({ most: 1 + stages * 2, loops: [] });
    expect(reads).toBeLessThan(nodes.length * 4);
  });
});

describe("#1366: [limits.max-steps-below-worst-case]", () => {
  it("names the worst case, the loops it passes and the maxSteps that holds it", () => {
    expect(warned(loop(3), 5)).toEqual([
      {
        code: "limits.max-steps-below-worst-case",
        message:
          "the worst case from S takes 7 steps — through A (maxVisits 3), but maxSteps is 5: a run that long fails with StepsLimitExceededError before its maxVisits ends it — set maxSteps: 7",
        nodes: ["S"],
      },
    ]);
  });

  it("leaves out the loops when the way has none", () => {
    const chain = graphOf(
      [start("S"), agent("A"), agent("B"), finish("F")],
      [edge("S", "A"), edge("A", "B"), edge("B", "F")],
      ["S"],
    );

    expect(warned(chain, 1).map((one) => one.message)).toEqual([
      "the worst case from S takes 2 steps, but maxSteps is 1: a run that long fails with StepsLimitExceededError before its maxVisits ends it — set maxSteps: 2",
    ]);
  });

  it("says nothing at the worst case, above it, or without a count, or when the flow takes the limit itself", () => {
    expect(warned(loop(3), 7)).toEqual([]);
    expect(warned(loop(3), 9)).toEqual([]);
    expect(warned(loop(3), undefined)).toEqual([]);
    expect(warned(loop(3), -1)).toEqual([]);
    expect(warned(loop(3), "5")).toEqual([]);
    expect(warned(loop(undefined), 1)).toEqual([]);
    const handled = (error: unknown) =>
      graphOf(
        [start("S"), agent("A", 3), agent("B"), agent("H"), finish("F")],
        [
          edge("S", "A"),
          edge("A", "B"),
          edge("B", "A"),
          edge("B", "F"),
          edge("A", "H", EdgeKind.Error, { error }),
        ],
        ["S"],
      );

    expect(warned(handled(StepsLimitExceededError), 5)).toEqual([]);
    expect(warned(handled(Object.getPrototypeOf(StepsLimitExceededError)), 5)).toEqual([]);
    expect(warned(handled(RangeError), 5)).toHaveLength(1);
    expect(warned(handled(undefined), 5)).toHaveLength(1);
  });
});

describe("#1366: the components a bound is built from", () => {
  it("counts a loop's free nodes at the longest way through them, between the visits", () => {
    const graph = graphOf(
      [start("S"), agent("A", 2), agent("B"), agent("C"), agent("D"), finish("F")],
      [
        edge("S", "A"),
        edge("A", "B"),
        edge("B", "C"),
        edge("C", "D"),
        edge("D", "A"),
        edge("D", "F"),
      ],
      ["S"],
    );

    expect(boundedStepsFrom(graph, named("S"))).toEqual({ most: 11, loops: ["A (maxVisits 2)"] });
  });

  it("takes the longest of several ways through the free nodes of a loop", () => {
    const graph = graphOf(
      [start("S"), agent("A", 1), agent("B"), agent("C"), agent("D"), finish("F")],
      [
        edge("S", "A"),
        edge("A", "B"),
        edge("A", "C"),
        edge("C", "D"),
        edge("B", "A"),
        edge("D", "A"),
        edge("A", "F"),
      ],
      ["S"],
    );

    expect(boundedStepsFrom(graph, named("S"))).toEqual({ most: 5, loops: ["A (maxVisits 1)"] });
  });

  it("gives a node with a maxVisits and no cycle its one visit, and no loop", () => {
    const graph = graphOf(
      [start("S"), agent("A", 3), finish("F")],
      [edge("S", "A"), edge("A", "F")],
      ["S"],
    );

    expect(boundedStepsFrom(graph, named("S"))).toEqual({ most: 1, loops: [] });
  });

  it("reads a node that calls itself as a loop", () => {
    const graph = graphOf(
      [start("S"), agent("A", 3), finish("F")],
      [edge("S", "A"), edge("A", "A"), edge("A", "F")],
      ["S"],
    );

    expect(boundedStepsFrom(graph, named("S"))).toEqual({ most: 3, loops: ["A (maxVisits 3)"] });
  });

  it("reads a node the graph does not hold as a free node that weighs nothing", () => {
    const graph = graphOf(
      [start("S"), agent("A", 2), finish("F")],
      [edge("S", "A"), edge("A", "Ghost"), edge("Ghost", "A"), edge("A", "F")],
      ["S"],
    );

    expect(boundedStepsFrom(graph, named("S"))).toEqual({ most: 2, loops: ["A (maxVisits 2)"] });
    const bare = graphOf([start("S")], [edge("S", "Ghost")], ["S"]);

    expect(boundedStepsFrom(bare, named("S"))).toEqual({ most: 0, loops: [] });
  });

  it("does not take a launch edge for a way back into a loop", () => {
    const graph = graphOf(
      [start("S"), agent("A", 2), agent("B"), finish("F")],
      [
        edge("S", "A"),
        edge("A", "B", EdgeKind.Launch),
        join("A", "F", [branch("B", 1, true)]),
        edge("B", "A"),
      ],
      ["S"],
    );

    expect(boundedStepsFrom(graph, named("S"))).toEqual({ most: 2, loops: [] });
  });

  it("counts a join that leaves a loop on the way on, not as a launch inside it", () => {
    const graph = graphOf(
      [start("S"), agent("A", 2), agent("B"), agent("C"), finish("F")],
      [edge("S", "A"), edge("A", "B"), edge("B", "A"), join("B", "F", [branch("C", 2, true)])],
      ["S"],
    );

    expect(boundedStepsFrom(graph, named("S"))).toEqual({ most: 7, loops: ["A (maxVisits 2)"] });
  });

  it("takes the longest way out of a component, the first of two that are as long, and no edge of another", () => {
    const longer = graphOf(
      [start("S"), agent("A", 1), agent("B"), agent("P"), agent("Q"), finish("F")],
      [
        edge("S", "A"),
        edge("A", "B"),
        edge("B", "A"),
        edge("B", "F"),
        edge("A", "P"),
        edge("P", "Q"),
        edge("Q", "F"),
      ],
      ["S"],
    );

    expect(boundedStepsFrom(longer, named("S"))?.most).toBe(5);
    const shorter = graphOf(
      [start("S"), agent("L1"), agent("L2"), agent("M"), finish("F")],
      [edge("S", "L1"), edge("S", "M"), edge("L1", "L2"), edge("L2", "F"), edge("M", "F")],
      ["S"],
    );

    expect(boundedStepsFrom(shorter, named("S"))).toEqual({ most: 2, loops: [] });
  });

  it("keeps the loops of the first way when two ways are equally long", () => {
    const loopOf = (name: string, from: string) => [edge(from, name), edge(name, name)];
    const graph = graphOf(
      [start("S"), agent("X", 1), agent("Y", 1), finish("F")],
      [...loopOf("X", "S"), ...loopOf("Y", "S"), edge("X", "F"), edge("Y", "F")],
      ["S"],
    );

    expect(boundedStepsFrom(graph, named("S"))?.loops).toEqual(["X (maxVisits 1)"]);
  });

  it("ignores edges of components the start does not reach", () => {
    const graph = graphOf(
      [start("S"), finish("F"), agent("X"), agent("Y"), agent("Z")],
      [edge("S", "F"), edge("X", "Y"), edge("Y", "Z")],
      ["S"],
    );

    expect(boundedStepsFrom(graph, named("S"))).toEqual({ most: 0, loops: [] });
  });

  it("reads each node of a loop's free part and each component once", () => {
    const stages = 12;
    const nodes = [start("S"), agent("A", 1), finish("F")];
    const edges = [edge("S", "A"), edge("A", "j0")];
    nodes.push(agent("j0"));
    for (let at = 0; at < stages; at += 1) {
      const [left, right, next] = [`l${String(at)}`, `r${String(at)}`, `j${String(at + 1)}`];
      nodes.push(agent(left), agent(right), agent(next));
      edges.push(edge(`j${String(at)}`, left), edge(`j${String(at)}`, right));
      edges.push(edge(left, next), edge(right, next));
    }
    edges.push(edge(`j${String(stages)}`, "A"), edge("A", "F"));
    let reads = 0;
    const counted = new Map(nodes.map((one) => [one.name, one]));
    const originalGet = counted.get.bind(counted);
    counted.get = (name) => {
      reads += 1;
      return originalGet(name);
    };
    const graph = { nodes: counted, edges, starts: [named("S")] };

    expect(boundedStepsFrom(graph, named("S"))?.most).toBe(51);
    expect(reads).toBeLessThan(nodes.length * 8);
  });
});

describe("#1366: the components of a flow of several ways on, counted once", () => {
  it("reads a component reached by many ways once", () => {
    const stages = 12;
    const nodes = [start("S"), finish("F")];
    const edges = [edge("S", "j0")];
    nodes.push(agent("j0"));
    for (let at = 0; at < stages; at += 1) {
      const next = `j${String(at + 1)}`;
      nodes.push(agent(next));
      edges.push(
        join(`j${String(at)}`, next, [branch("j0", 1, true)]),
        join(`j${String(at)}`, next, [branch("j0", 2, true)]),
      );
    }
    edges.push(edge(`j${String(stages)}`, "F"));
    let reads = 0;
    const graph = graphOf(nodes, [], ["S"]);
    Object.defineProperty(graph, "edges", { value: edges });
    const first = edges[0];
    if (first === undefined) throw new Error("no edge");
    for (const one of edges) {
      const launch = Reflect.get(one, "launch") as unknown;
      Object.defineProperty(one, "launch", {
        get() {
          reads += 1;
          return launch;
        },
      });
    }

    expect(boundedStepsFrom(graph, named("S"))?.most).toBeGreaterThan(0);
    expect(reads).toBeLessThan(edges.length * 4);
  });
});

describe("#1366: a free node of a loop that calls itself", () => {
  it("gives no bound: no maxVisits stops it", () => {
    const graph = graphOf(
      [start("S"), agent("A", 2), agent("B"), finish("F")],
      [edge("S", "A"), edge("A", "B"), edge("B", "A"), edge("B", "B"), edge("B", "F")],
      ["S"],
    );

    expect(boundedStepsFrom(graph, named("S"))).toBeUndefined();
  });
});
