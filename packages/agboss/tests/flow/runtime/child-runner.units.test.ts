/**
 * #1366 (shard once-child) — a child workflow as a step of its parent (`childRunner`), each decision on its
 * own: what the child is entered with (its parent's spend so far, its identity), when it announces its end
 * (once: only the pass that ran it to its finish, or a failure the claim gives it), what its parent's step
 * takes from it (its own spend, its value) and the child's config. The collaborators are scripts that
 * remember what they were asked.
 */
import { describe, expect, it, vi } from "vitest";
import { trivialExecutionGraph } from "./fixtures/execution-graph.js";
import type { ExecutionGraph } from "../../../src/flow/runtime/build.js";
import { NodeKind } from "../../../src/flow/ast.js";
import { childRunner, type ChildGraph } from "../../../src/flow/runtime/child.js";
import type { RuntimeNode } from "../../../src/flow/runtime/graph-model.js";
import { recordToolCost } from "../../../src/finops/usage.js";
import { unkeptExecutionIds } from "../../../src/infrastructure/clock.js";

interface Hoisted {
  frame: unknown;
  entry: unknown;
  entered: unknown;
  run: unknown;
  reentry: unknown;
  end: unknown;
  remoteEnd: unknown;
  remote: unknown;
  outputs: unknown[] | undefined;
  calls: [string, ...unknown[]][];
}

const h = vi.hoisted((): Hoisted => ({
  frame: undefined,
  entry: undefined,
  entered: undefined,
  run: undefined,
  reentry: undefined,
  end: undefined,
  remoteEnd: undefined,
  remote: undefined,
  outputs: [],
  calls: [],
}));
const said = (name: string, ...args: unknown[]) => h.calls.push([name, ...args]);
const callsOf = (name: string) =>
  h.calls.filter(([called]) => called === name).map(([, ...a]) => a);

vi.mock("../../../src/flow/context/frame.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/flow/context/frame.js")>()),
  currentFrame: () => h.frame,
}));
vi.mock("../../../src/flow/runtime/child-entry.js", () => ({
  childEntryOf: (site: unknown) => {
    said("childEntryOf", site);
    return h.entry;
  },
}));
vi.mock("../../../src/flow/runtime/start-input.js", () => ({
  validStartInput: (start: unknown, input: unknown) => {
    said("validStartInput", start, input);
    return { validated: input };
  },
}));
vi.mock("../../../src/flow/runtime/child-identity.js", () => ({
  childEnteredAt: (args: unknown) => {
    said("childEnteredAt", args);
    return Promise.resolve(h.entered);
  },
  childRunOf: (...args: unknown[]) => {
    said("childRunOf", ...args);
    return h.run;
  },
}));
vi.mock("../../../src/flow/runtime/child-reentry.js", () => ({
  reentryOf: (...args: unknown[]) => {
    said("reentryOf", ...args);
    return Promise.resolve(h.reentry);
  },
}));
vi.mock("../../../src/flow/runtime/child-own-thread.js", () => ({
  childEndOf: (...args: unknown[]) => {
    said("childEndOf", ...args);
    return Promise.resolve(h.end);
  },
}));
vi.mock("../../../src/flow/runtime/remote/remote-child.js", () => ({
  remoteChildEndOf: (...args: unknown[]) => {
    said("remoteChildEndOf", ...args);
    return Promise.resolve(h.remoteEnd);
  },
}));
vi.mock("../../../src/flow/runtime/remote/remote-child-site.js", () => ({
  remoteSiteOf: (...args: unknown[]) => {
    said("remoteSiteOf", ...args);
    return h.remote;
  },
}));
vi.mock("../../../src/flow/runtime/recursion-launch.js", () => ({
  refuseBeyondMaxDepth: (...args: unknown[]) => said("refuseBeyondMaxDepth", ...args),
}));
vi.mock("../../../src/flow/runtime/step-entries.js", () => ({
  inStepEntry: (_entries: unknown, _frame: unknown, work: () => Promise<unknown>) => work(),
}));
vi.mock("../../../src/flow/runtime/child-failure.js", () => ({
  assertAnnouncing: (frame: unknown) => said("assertAnnouncing", frame),
  eventOf: (frame: unknown, ended: unknown) => ({ event: "of", frame, ended }),
  failedChild: (...args: unknown[]) => {
    said("failedChild", ...args);
    return Promise.reject(new Error("the child failed"));
  },
}));
vi.mock("../../../src/flow/runtime/child-exit.js", () => ({
  ownUsageOf: (...args: unknown[]) => {
    said("ownUsageOf", ...args);
    return ["own-usage"];
  },
  childRecordOf: (...args: unknown[]) => {
    said("childRecordOf", ...args);
    return { spend: "the-spend" };
  },
}));
vi.mock("../../../src/flow/analyse/child-workflow.js", () => ({
  childWorkflowOf: () => (h.outputs === undefined ? undefined : { outputs: h.outputs }),
}));
vi.mock("../../../src/tracing/workflow-chain.js", () => ({
  workflowChainOf: (metadata: unknown, name: string) =>
    `chain(${JSON.stringify(metadata)},${name})`,
}));
vi.mock("../../../src/flow/runtime/workflow-keys.js", () => ({
  joinKeysOf: () => ({ components: "components" }),
  recordOfNode: (_records: unknown, name: string) => ({ node: name }),
}));

const IDENTITY = {
  executionId: "child-1",
  parentExecutionId: "parent-1",
  rootExecutionId: "root-1",
};
const node = { id: "launch-node" } as RuntimeNode;
const CHILD_GRAPH = trivialExecutionGraph();
const ApprovedDto = Object.defineProperty(() => undefined, "name", { value: "ApprovedDto" });
const FINISH = { kind: NodeKind.Finish, options: { output: ApprovedDto } };

interface Setup {
  readonly isRecursive?: boolean;
  readonly branch?: boolean;
  readonly pii?: boolean;
  readonly noObserver?: boolean;
  readonly compensation?: boolean;
  readonly itemIndex?: number;
  readonly noStart?: boolean;
  readonly executionIds?: unknown;
  readonly noRecordChild?: boolean;
}

/** The parts of a child's graph the runner reads: what the test fakes is left as `object` or `unknown`. */
interface ChildRead {
  readonly deps: {
    readonly graph: { readonly nodes: ReadonlyMap<string, unknown> };
    readonly pii?: object;
    readonly observer?: object;
  };
  readonly workflow: { readonly type: unknown; readonly name: string; readonly version: string };
  readonly graph: ExecutionGraph;
  readonly isRecursive: boolean;
}

/** A parent step with a child; every call a collaborator hears is in `h.calls`, from this set-up on. */
function setUp(setup: Setup = {}) {
  h.calls.length = 0;
  const observer = {
    onExecutionStart: vi.fn((_event: unknown) => Promise.resolve()),
    onExecutionEnd: vi.fn((_event: unknown) => Promise.resolve()),
  };
  const recordChild = vi.fn();
  h.frame = {
    isClosed: () => false,
    execution: { executionId: "parent-1", tenant: { tenantId: "acme" }, parent: undefined },
    step: { nodeId: "launch-node", visitNumber: 3, itemIndex: setup.itemIndex },
    services: setup.noRecordChild === true ? {} : { recordChild },
  };
  h.entry = { start: { name: "child-start" }, input: { raw: 1 }, read: ["read-1"] };
  h.entered = { identity: { ...IDENTITY, itemIndex: setup.itemIndex }, isNew: true };
  h.run = { signal: "run-signal" };
  h.reentry = { interrupted: undefined, claimed: undefined };
  h.remote = undefined;
  h.outputs = [];
  h.end = {
    failed: false,
    announces: false,
    state: { finish: "child-finish", output: "out", usage: [], piiTokens: { t: "v" } },
  };
  const nodes = new Map<string, unknown>([["child-finish", { declaration: FINISH }]]);
  if (setup.noStart !== true) nodes.set("child-start", {});
  const deps = {
    graph: { branchNodes: new Set(setup.branch === true ? ["launch-node"] : []) },
    executionIds: setup.executionIds,
    stepEntries: "entries",
    ...(setup.compensation === true ? { compensation: { trees: "trees" } } : {}),
  };
  const read: ChildRead = {
    deps: {
      graph: { nodes },
      ...(setup.pii === true ? { pii: { observability: "mask" } } : {}),
      ...(setup.noObserver === true ? {} : { observer }),
    },
    workflow: { type: Object, name: "child-workflow", version: "v2" },
    graph: CHILD_GRAPH,
    isRecursive: setup.isRecursive === true,
  };
  const child = read as ChildGraph;
  const budgets = { meter: "meter" };
  const run = (state: Record<string, unknown> = {}, config?: Record<string, unknown>) =>
    childRunner(node, deps as never, child, {
      checkpointer: "saver" as never,
      budgets: budgets as never,
    })(
      {
        scope: "scope",
        path: [],
        usage: [recordToolCost("p", 1)],
        contexts: "contexts",
        budgets: "budgets",
        budgetUsd: 9,
        piiTokens: {},
        piiKey: "key",
        launch: undefined,
        ...state,
      } as never,
      config as never,
    );
  return { run, observer, recordChild, deps, budgets };
}

describe("#1366: a child runs only inside a step of its parent", () => {
  it("outside any frame, or in a closed one, its step fails with the node's id", async () => {
    const { run } = setUp();
    h.frame = undefined;
    await expect(run()).rejects.toThrow(
      "launch-node: a child workflow ran outside a step of its parent",
    );
    h.frame = { isClosed: () => true };
    await expect(run()).rejects.toThrow("a child workflow ran outside a step of its parent");
  });
});

describe("#1366: what the child is entered with", () => {
  it("a single step's entry knows the node before it, none when the path is empty", async () => {
    const { run } = setUp();
    await run({ path: ["a", "b", "c"] });
    await run({ path: [] });

    const [first, second] = callsOf("childEntryOf");
    expect(first?.[0]).toEqual({ graph: expect.anything(), node, scope: "scope", previous: "c" });
    expect(second?.[0]).toMatchObject({ previous: "" });
  });

  it("a per-item branch's entry knows its launcher, none without a launch", async () => {
    const { run } = setUp({ branch: true });
    await run({ launch: { launcher: "fan-out" } });
    await run({ launch: undefined });

    const [first, second] = callsOf("childEntryOf");
    expect(first?.[0]).toEqual({
      graph: expect.anything(),
      node,
      scope: "scope",
      launcher: "fan-out",
    });
    expect(second?.[0]).toMatchObject({ launcher: "" });
    expect(second?.[0]).not.toHaveProperty("previous");
  });

  it("fails the step when the child has no start the entry names", async () => {
    const { run } = setUp({ noStart: true });

    await expect(run()).rejects.toThrow("launch-node: no start child-start");
    expect(callsOf("childEnteredAt")).toEqual([]);
  });

  it("validates the start's input, and enters the child counting the parent's spend so far", async () => {
    const { run } = setUp({ itemIndex: 4, executionIds: "ids" });
    const config = { configurable: { a: 1 } };

    await run({}, config);

    expect(callsOf("validStartInput")[0]).toEqual([{}, { raw: 1 }]);
    expect(callsOf("childEnteredAt")[0]?.[0]).toEqual({
      checkpointer: "saver",
      config,
      parent: h.frame,
      itemIndex: 4,
      inheritedUsage: 1,
      executionIds: "ids",
    });
  });

  it("without the application's execution ids, the child's are not kept", async () => {
    const { run } = setUp();

    await run();

    const { executionIds } = callsOf("childEnteredAt")[0]?.[0] as { executionIds: unknown };
    expect(executionIds).toBe(unkeptExecutionIds);
  });

  it("makes the child's run with the child's own PII observability, none without a policy", async () => {
    await setUp({ pii: true }).run({}, { configurable: {} });
    const [masked] = callsOf("childRunOf");
    const frame = h.frame;
    const identity = (h.entered as { identity: unknown }).identity;
    await setUp({ pii: false }).run();
    const [bare] = callsOf("childRunOf");

    expect(masked?.[1]).toBe(frame);
    expect(masked?.[2]).toBe(identity);
    expect(masked?.[3]).toEqual({ validated: { raw: 1 } });
    expect(masked?.[4]).toBe("mask");
    expect(bare?.[4]).toBeUndefined();
  });

  it("the child's first state: the parent's contexts, budgets and PII tokens, a copy of its spend, the child's identity", async () => {
    const usage = [recordToolCost("p", 1)];
    const { run } = setUp();
    await run({ usage });

    const input = callsOf("childEndOf")[0]?.[1] as { initial: Record<string, unknown> };
    expect(input.initial).toEqual({
      runId: "child-1",
      start: "child-start",
      startInput: { validated: { raw: 1 } },
      contexts: "contexts",
      usage,
      budgets: "budgets",
      budgetUsd: 9,
      piiTokens: {},
      piiKey: "key",
      child: (h.entered as { identity: unknown }).identity,
    });
    expect(input.initial.usage).not.toBe(usage);
  });

  it("the child's config: the parent's with the child's run, its ids, its depth and its chain", async () => {
    const { run } = setUp({ itemIndex: 2 });
    const config = {
      configurable: { keep: 1 },
      metadata: { workflowChain: "parent" },
      extra: true,
    };

    await run({}, config);

    const call = callsOf("childEndOf")[0]?.[1] as { config: Record<string, unknown> };
    expect(call.config).toEqual({
      ...config,
      signal: "run-signal",
      runName: "child-workflow",
      configurable: { keep: 1, run: h.run },
      metadata: {
        workflowChain: 'chain({"workflowChain":"parent"},child-workflow)',
        executionId: "child-1",
        parentExecutionId: "parent-1",
        rootExecutionId: "root-1",
        workflowName: "child-workflow",
        workflowVersion: "v2",
        depth: 2,
        itemIndex: 2,
      },
    });
  });

  it("a child of no item has no itemIndex in its metadata, and a step with no config has the child's own", async () => {
    const { run } = setUp();

    await run();

    const { config } = callsOf("childEndOf")[0]?.[1] as { config: Record<string, unknown> };
    expect(config.metadata).not.toHaveProperty("itemIndex");
    expect(config.metadata).toMatchObject({ workflowChain: "chain(undefined,child-workflow)" });
    expect(config.configurable).toEqual({ run: h.run });
  });

  it("calls the child with its first state, its config, its re-entry, its identity and its node", async () => {
    const { run } = setUp();
    h.reentry = { interrupted: undefined, claimed: "claimed-by" };

    await run();

    const [[ended, call]] = callsOf("childEndOf") as [[ChildGraph, Record<string, unknown>]];
    expect(ended.graph).toBe(CHILD_GRAPH);
    expect(call).toMatchObject({ claimed: "claimed-by", node: "launch-node", entered: h.entered });
    expect(call.remote).toBeUndefined();
    expect(call.initial).toBeDefined();
    expect(call.config).toBeDefined();
  });
});

describe("#1366: a child that is entered again", () => {
  it("is refused beyond the recursion's depth only when its workflow is recursive", async () => {
    const plain = setUp({ isRecursive: false });
    await plain.run({ path: ["x"] });
    expect(callsOf("refuseBeyondMaxDepth")).toEqual([]);

    const recursive = setUp({ isRecursive: true });
    await recursive.run({ path: ["x"] });
    const [graph, frame, ended, path] = callsOf("refuseBeyondMaxDepth")[0] ?? [];
    expect(graph).toBe(recursive.deps.graph);
    expect(frame).toBe(h.frame);
    expect(path).toEqual(["x"]);
    expect(ended).toMatchObject({
      identity: (h.entered as { identity: unknown }).identity,
      depth: 2,
      workflow: { name: "child-workflow", version: "v2", startedVersion: "v2" },
      launchedBy: { nodeId: "launch-node", visitNumber: 3 },
      start: "child-start",
      input: { validated: { raw: 1 } },
      records: { components: "components", graph: expect.anything() },
    });
  });

  it("announces its start only on its first entry, and to no one without an observer", async () => {
    const first = setUp();
    await first.run();
    expect(first.observer.onExecutionStart).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ event: "of" }),
    );

    const again = setUp();
    h.entered = { identity: IDENTITY, isNew: false };
    await again.run();
    expect(again.observer.onExecutionStart).not.toHaveBeenCalled();

    const bare = setUp({ noObserver: true });
    await expect(bare.run()).resolves.toBeDefined();
  });
});

describe("#1366: how a child ran", () => {
  it("on this instance, by its own thread", async () => {
    await setUp().run();

    expect(callsOf("childEndOf")).toHaveLength(1);
    expect(callsOf("remoteChildEndOf")).toEqual([]);
  });

  it("on any instance, queued, with the child's config and the parent's budgets", async () => {
    const { run, budgets } = setUp();
    h.remote = { site: "remote" };
    h.remoteEnd = h.end;

    await run();

    const [graph, config, site, meter] = callsOf("remoteChildEndOf")[0] ?? [];
    expect(graph).toBe(CHILD_GRAPH);
    expect(config).toMatchObject({ runName: "child-workflow", signal: "run-signal" });
    expect(site).toBe(h.remote);
    expect(meter).toBe(budgets);
    expect(callsOf("childEndOf")).toEqual([]);
  });
});

describe("#1366: what the parent's step takes from the child", () => {
  it("its value and variant, its own spend and its PII tokens, and what the step read", async () => {
    h.outputs = [];
    const { run, recordChild, observer } = setUp();
    (h.end as { state: Record<string, unknown> }).state.finish = "child-finish";

    const done = await run();

    expect(done).toEqual({
      value: { value: "out" },
      read: ["read-1"],
      usage: ["own-usage"],
      piiTokens: { t: "v" },
    });
    expect(callsOf("ownUsageOf")[0]?.[1]).toBe((h.entered as { identity: unknown }).identity);
    expect(callsOf("childRecordOf")[0]?.[2]).toEqual({ status: "finished", usage: ["own-usage"] });
    expect(recordChild).toHaveBeenCalledExactlyOnceWith({ spend: "the-spend" });
    expect(observer.onExecutionEnd).not.toHaveBeenCalled();
  });

  it("names the finish class of a child that has several outputs", async () => {
    const { run } = setUp();
    h.outputs = ["a", "b"];

    expect(await run()).toMatchObject({ value: { value: "out", variant: "ApprovedDto" } });
  });

  it("names none for a child with one output, nor for a finish that is not one", async () => {
    const one = setUp();
    h.outputs = ["a"];
    expect(await one.run()).toMatchObject({ value: { value: "out" } });
    expect((await one.run()).value).not.toHaveProperty("variant");

    const odd = setUp();
    h.outputs = ["a", "b"];
    (h.end as { state: Record<string, unknown> }).state.finish = "nowhere";
    expect((await odd.run()).value).toEqual({ value: "out" });
    (h.end as { state: Record<string, unknown> }).state.finish = "child-start";
    expect((await odd.run()).value).toEqual({ value: "out" });
  });

  it("names no variant for a workflow the analysis knows no outputs of", async () => {
    const { run } = setUp();
    h.outputs = undefined;

    expect((await run()).value).toEqual({ value: "out" });
  });

  it("a child whose parent's frame has no recordChild is run all the same", async () => {
    const { run } = setUp({ noRecordChild: true });

    await expect(run()).resolves.toBeDefined();
  });

  it("a child that ended without a state fails its step with its workflow's name", async () => {
    const { run } = setUp();
    h.end = { failed: false, announces: false, state: undefined };

    await expect(run()).rejects.toThrow("child-workflow ended without a state");
  });
});

describe("#1366: the end of a child is announced once", () => {
  it("by the pass that ran it to its finish: the event of its parent's step, its finish and its spend", async () => {
    const { run, observer } = setUp();
    (h.end as { announces: boolean }).announces = true;

    await run();

    expect(callsOf("assertAnnouncing")).toEqual([[h.frame]]);
    expect(observer.onExecutionEnd).toHaveBeenCalledExactlyOnceWith({
      event: "of",
      frame: h.frame,
      ended: expect.anything(),
      finish: { node: "child-finish" },
      output: "out",
      spend: "the-spend",
    });
  });

  it("not by a pass that did not, which asserts nothing either", async () => {
    const { run, observer } = setUp();

    await run();

    expect(callsOf("assertAnnouncing")).toEqual([]);
    expect(observer.onExecutionEnd).not.toHaveBeenCalled();
  });

  it("to no one when the child's workflow has no observer", async () => {
    const { run } = setUp({ noObserver: true });
    (h.end as { announces: boolean }).announces = true;

    await expect(run()).resolves.toBeDefined();
    expect(callsOf("assertAnnouncing")).toHaveLength(1);
  });
});

describe("#1366: a child that failed", () => {
  const failedWith = (announces: boolean) => {
    h.end = { failed: true, announces, error: "the-error", state: "last-state" };
  };

  it("is announced by the pass that saw it, whatever else is true", async () => {
    const { run } = setUp();
    failedWith(true);

    await expect(run()).rejects.toThrow("the child failed");

    const [parent, ended, failure, config] = callsOf("failedChild")[0] ?? [];
    expect(failure).toEqual({ error: "the-error", last: "last-state", announces: true });
    expect(parent).toMatchObject({ frame: h.frame, undo: { child: expect.anything() } });
    expect(ended).toMatchObject({ start: "child-start" });
    expect(config).toBeDefined();
  });

  it("is announced by the tree's claim, without it by the pass that saw it only", async () => {
    const claimed = setUp({ compensation: true });
    failedWith(false);
    await expect(claimed.run()).rejects.toThrow();
    expect(callsOf("failedChild")[0]?.[2]).toMatchObject({ announces: true });

    const unclaimed = setUp();
    failedWith(false);
    await expect(unclaimed.run()).rejects.toThrow();
    expect(callsOf("failedChild")[0]?.[2]).toMatchObject({ announces: false });
  });

  it("an undo that was interrupted ends the child with that error and no step of its own, announced", async () => {
    const { run } = setUp();
    h.reentry = { interrupted: "the-interrupted-undo", claimed: undefined };

    await expect(run()).rejects.toThrow("the child failed");

    expect(callsOf("childEndOf")).toEqual([]);
    expect(callsOf("remoteChildEndOf")).toEqual([]);
    expect(callsOf("failedChild")[0]?.[2]).toEqual({
      error: "the-interrupted-undo",
      last: undefined,
      announces: true,
    });
  });
});
