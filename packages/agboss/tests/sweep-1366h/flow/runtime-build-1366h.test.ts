/**
 * #1366: how the execution graph is compiled: a node the deps do not back (a model router with no router, an
 * agent with no loop) is refused as UnknownAgentError, a child workflow the application cannot reach, one that
 * contains an ancestor, is refused as ChildWorkflowUnavailableError — not run; the graph is held to its own
 * recursion limit of (maxSteps + nodes) x 10; a run's graph is built once per pass.
 */
import { describe, expect, vi } from "vitest";
import type { GraphDeps } from "../../../src/graph/deps.js";
import type { ComponentName } from "../../../src/flow/registry.js";
import { NodeKind } from "../../../src/flow/ast.js";
import { ChildWorkflowUnavailableError } from "../../../src/flow/runtime/child-errors.js";
import type { RuntimeNode } from "../../../src/flow/runtime/graph-model.js";
import type { ExecutionGraph, RunLimits } from "../../../src/flow/runtime/build.js";
import type { WorkflowFixtures } from "../../../src/testing/test-with.js";
import { replyWith, testWith } from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import { ChildWriter, FlowJudge } from "../../stream/agents.fixture.js";
import { OnceStart, StreamChildrenApplication } from "../../stream/children.fixture.js";

const seen = vi.hoisted(() => ({ calls: [] as { deps: unknown; run: unknown }[] }));

vi.mock("../../../src/flow/runtime/build.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/flow/runtime/build.js")>();
  return {
    ...original,
    executionGraphOf: (deps: unknown, run: unknown) => {
      seen.calls.push({ deps, run });
      return original.executionGraphOf(deps as never, run as never);
    },
  };
});

const test = testWith(StreamChildrenApplication);

type Deps = GraphDeps<string>;

/** The deps and limits the app's own run compiled its graph from. */
async function captured({ app, mockLlm }: Pick<WorkflowFixtures, "app" | "mockLlm">) {
  mockLlm(ChildWriter).thenReturn(replyWith("From the child."));
  mockLlm(FlowJudge).thenReturnAlways(replyWith("PASS: INTERNAL"));
  seen.calls.length = 0;
  await execute(app, OnceStart, { text: "Q" });
  const first = seen.calls[0];
  if (first === undefined) throw new Error("no graph was built");
  const original = await vi.importActual<typeof import("../../../src/flow/runtime/build.js")>(
    "../../../src/flow/runtime/build.js",
  );
  const build = (deps: Deps): ExecutionGraph =>
    original.executionGraphOf(deps, first.run as RunLimits);
  return { deps: first.deps as Deps, build };
}

/** The deps with one more node the compiler has to make a runner of. */
function withNode(deps: Deps, node: Partial<RuntimeNode> & Pick<RuntimeNode, "id" | "kind">): Deps {
  const nodes = new Map(deps.graph.nodes);
  nodes.set(node.id, node as RuntimeNode);
  return { ...deps, graph: { ...deps.graph, nodes } };
}

class GhostChild {
  readonly ghost = true;
}

describe("#1366: the compiled graph", () => {
  test("the app's own deps compile; the graph's recursion limit is (maxSteps + nodes) x 10", async ({
    app,
    mockLlm,
  }) => {
    const { deps, build } = await captured({ app, mockLlm });

    const graph = build(deps);

    const launches = deps.graph.launches.length;
    expect(graph.config?.recursionLimit).toBe(
      (deps.maxSteps + deps.graph.nodes.size + launches) * 10,
    );
    expect(graph.checkpointer).toBeTruthy();
    expect(build({ ...deps, pause: undefined }).checkpointer).toBeFalsy();
  });

  test("a model router the deps have no texts for is UnknownAgentError", async ({
    app,
    mockLlm,
  }) => {
    const { deps, build } = await captured({ app, mockLlm });
    const ghost = withNode(deps, {
      id: "ghost-router" as ComponentName,
      kind: NodeKind.Router,
      declaration: { kind: NodeKind.Router, options: { decidedBy: "model" } } as never,
    });

    expect(() => build(ghost)).toThrow(expect.objectContaining({ name: "UnknownAgentError" }));
  });

  test("an agent without a loop is UnknownAgentError", async ({ app, mockLlm }) => {
    const { deps, build } = await captured({ app, mockLlm });
    const ghost = withNode(deps, {
      id: "ghost-agent" as ComponentName,
      kind: NodeKind.Agent,
      declaration: { kind: NodeKind.Agent, options: {} } as never,
    });

    expect(() => build(ghost)).toThrow(expect.objectContaining({ name: "UnknownAgentError" }));
  });

  test("a child workflow the application cannot reach is ChildWorkflowUnavailableError", async ({
    app,
    mockLlm,
  }) => {
    const { deps, build } = await captured({ app, mockLlm });

    const without = { ...deps, childDepsOf: undefined } as Deps;
    const none = { ...deps, childDepsOf: () => undefined } as Deps;

    expect(() => build(without)).toThrow(ChildWorkflowUnavailableError);
    expect(() => build(none)).toThrow(ChildWorkflowUnavailableError);
  });

  test("a workflow that contains an ancestor is ChildWorkflowUnavailableError, not an endless compile", async ({
    app,
    mockLlm,
  }) => {
    const { deps, build } = await captured({ app, mockLlm });
    const ghost = withNode(deps, {
      id: "ghost-workflow" as ComponentName,
      kind: NodeKind.Workflow,
      component: GhostChild,
    });
    const reach = (component: unknown): Deps | undefined =>
      component === GhostChild ? sub : deps.childDepsOf?.(component as never);
    const sub: Deps = {
      ...ghost,
      graph: { ...ghost.graph, type: GhostChild },
      childDepsOf: reach,
    };
    const root: Deps = { ...ghost, childDepsOf: reach };

    expect(() => build(root)).toThrow(ChildWorkflowUnavailableError);
  });
});
