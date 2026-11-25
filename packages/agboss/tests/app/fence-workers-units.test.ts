/**
 * #1366 (shard `fence-workers`) on its own, the part of `step-frame.ts` that is the fence: the frame of a visit
 * carries the lease its steps run under, and a step that works holds the slots of its tree and of its instance
 * — released at the end of its work, however it ends — and is a running step of its lease.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionCancelledError } from "../../src/core/errors.js";
import { newRunContext } from "../../src/core/run-context.js";
import { NodeKind } from "../../src/flow/ast.js";
import { inTreeSlot, stepFrameAt, type TreeSlotSite } from "../../src/flow/runtime/step-frame.js";
import { ComponentKind } from "../../src/flow/runtime/records.js";

vi.mock("../../src/flow/context/runtime-contexts.js", () => ({
  tenantOfExecution: (_contexts: unknown, values: { tenantId: string }) => ({
    tenantId: values.tenantId,
  }),
}));

const node = (kind: NodeKind, id = "clerk-agent") => ({ id, kind, component: `${id}-class` });

const WORKFLOW = { name: "desk-workflow", version: "1.0.0", configHash: "h" };
const stateOf = (overrides: Record<string, unknown> = {}) =>
  ({
    runId: "exec-1",
    start: "start",
    startedVersion: "",
    visits: {},
    path: [],
    piiKey: undefined,
    contexts: { tenant: { tenantId: "acme" }, execution: { k: 1 } },
    ...overrides,
  }) as never;
const contextsOf = { application: { name: "desk-app" } } as never;

describe("#1366: the frame of a visit", () => {
  const frameOf = (
    config: Parameters<typeof stepFrameAt>[2],
    site: Partial<Parameters<typeof stepFrameAt>[0]> = {},
    state: unknown = stateOf(),
  ) =>
    stepFrameAt(
      { node: node(NodeKind.Agent) as never, visitNumber: 2, ...site },
      state as never,
      config,
      { workflow: WORKFLOW as never, contexts: contextsOf, components: new Map() },
    );

  it("a run under a lease: its steps run under it, the very object", () => {
    const lease = { assertHeld: vi.fn(), scopeKey: "scope-1" };
    const run = newRunContext({
      runId: "exec-1",
      threadId: "thread-1",
      ownerId: "ada",
      lease: lease as never,
    });

    const { execution } = frameOf({ configurable: { run } });

    expect(execution.lease).toBe(lease);
    expect(execution).toMatchObject({
      executionId: "exec-1",
      threadId: "thread-1",
      ownerId: "ada",
      signal: run.signal,
    });
  });

  it("a run with no lease has no `lease` key at all", () => {
    const { execution } = frameOf({ configurable: { run: newRunContext({ runId: "exec-1" }) } });

    expect("lease" in execution).toBe(false);
  });

  it("the execution and the step are frozen, the workflow with the version it started on", () => {
    const frame = frameOf({ configurable: { run: newRunContext({ runId: "exec-1" }) } });

    expect(Object.isFrozen(frame.execution)).toBe(true);
    expect(Object.isFrozen(frame.step)).toBe(true);
    expect(Object.isFrozen(frame.step.component)).toBe(true);
    expect(Object.isFrozen(frame.execution.workflow)).toBe(true);
    expect(frame.execution.workflow.startedVersion).toBe("1.0.0");
    expect(frame.execution.tenant).toEqual({ tenantId: "acme" });
    expect(frame.execution.values).toEqual({ k: 1 });
  });

  it("the correlation key is the state's PII key, else the run's", () => {
    const run = { ...newRunContext({ runId: "exec-1" }), correlationKey: "run-key" };

    expect(
      frameOf({ configurable: { run } }, {}, stateOf({ piiKey: "state-key" })).execution
        .correlationKey,
    ).toBe("state-key");
    expect(frameOf({ configurable: { run } }).execution.correlationKey).toBe("run-key");
  });

  it("a root carries the call chain its mesh calls use, a child its parent and its item", () => {
    const root = frameOf({ configurable: { run: newRunContext({ runId: "exec-1" }) } });
    expect(root.execution.mesh?.chain).toEqual([
      { application: "desk-app", start: "start", executionId: "exec-1" },
    ]);
    expect("parent" in root.execution).toBe(false);

    const parent = { execution: { executionId: "root-1" } } as never;
    const run = { ...newRunContext({ runId: "child-1" }), tree: { parent, itemIndex: 3 } };
    const child = frameOf({ configurable: { run } });
    expect(child.execution.parent).toBe(parent);
    expect(child.execution.itemIndex).toBe(3);
    expect("mesh" in child.execution).toBe(false);
  });

  it("the step: its key is the execution, node, visit and item; a copy's id and number are its own", () => {
    const config = { configurable: { run: newRunContext({ runId: "exec-1" }) } };

    const plain = frameOf(config);
    expect(plain.step).toMatchObject({
      nodeId: "clerk-agent",
      visitNumber: 2,
      idempotencyKey: "exec-1:clerk-agent:2",
      callId: undefined,
      itemIndex: undefined,
      copyNumber: 1,
      toolLoopIteration: undefined,
      validationAttempts: 0,
      component: { type: "clerk-agent-class", name: "clerk-agent", kind: ComponentKind.Agent },
    });

    const copy = frameOf(config, { nodeId: "clerk-agent#2", copyNumber: 2, itemIndex: 4 });
    expect(copy.step).toMatchObject({
      nodeId: "clerk-agent#2",
      idempotencyKey: "exec-1:clerk-agent#2:2:4",
      copyNumber: 2,
      itemIndex: 4,
    });
  });
});

/** What a slot's `take` is asked with. */
interface TakenClaim {
  readonly closesBranch: boolean;
}

/** A tree slot and an instance slot that record who took them and how they were released. */
function slotsOf(options: { tree?: boolean; instance?: "none" | "refuse" | "grant" } = {}) {
  const log: string[] = [];
  const treeTake = vi.fn((_claim: TakenClaim, _signal?: AbortSignal, _watch?: unknown) =>
    Promise.resolve(options.tree === false ? undefined : { release: () => log.push("tree") }),
  );
  const slotsOfTree = vi.fn(() => ({ take: treeTake }));
  const instanceTake = vi.fn(
    (_claim: TakenClaim, _signal?: AbortSignal, _watch?: unknown, _scope?: string) =>
      Promise.resolve(
        options.instance === "refuse" ? undefined : { release: () => log.push("instance") },
      ),
  );
  const registry = {
    slotsOf: slotsOfTree,
    // the limits of each workflow as the application leaves them: here the fake type's own `cap`
    limitsOf: (type: { cap?: number }) => ({ maxConcurrency: type.cap }),
    steps: undefined,
    ...(options.instance === undefined || options.instance === "none"
      ? {}
      : { instance: { take: instanceTake } }),
  };
  return { registry, log, treeTake, slotsOfTree, instanceTake };
}

function siteOf(
  given: Record<string, unknown> = {},
  kind: NodeKind = NodeKind.Agent,
): TreeSlotSite {
  const { execution: own, ...overrides } = given;
  const root = { executionId: "root-1", workflow: { type: { cap: 5 } } };
  const execution = {
    executionId: "child-1",
    workflow: { type: { cap: undefined } },
    parent: { execution: root },
    lease: { scopeKey: "scope-1", enterStep: vi.fn(() => Promise.resolve(vi.fn())) },
    signal: new AbortController().signal,
    ...(own as object | undefined),
  };
  return {
    execution,
    step: {},
    slots: undefined,
    graph: { nodes: new Map() },
    node: node(kind),
    state: stateOf(),
    config: undefined,
    ...overrides,
  } as never;
}

/** The lease's entry spy of a site (a fake whose entry is `vi.fn`). */
const entered = (site: TreeSlotSite): unknown =>
  Reflect.get(site.execution.lease ?? {}, "enterStep");

describe("#1366: a step's slots and its lease", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([NodeKind.Start, NodeKind.Finish, NodeKind.Workflow, NodeKind.Question])(
    "a %s takes no slot and is no running step of its lease: its work runs as it is",
    async (kind) => {
      const { registry, treeTake } = slotsOf();
      const site = siteOf({ slots: registry }, kind);

      expect(await inTreeSlot(site, () => Promise.resolve("done"))).toBe("done");

      expect(treeTake).not.toHaveBeenCalled();
      expect(entered(site)).not.toHaveBeenCalled();
    },
  );

  it.each([NodeKind.Agent, NodeKind.Router, NodeKind.Action])(
    "a %s works in a slot of its tree and is a running step of its lease",
    async (kind) => {
      const { registry, treeTake } = slotsOf();
      const site = siteOf({ slots: registry }, kind);

      expect(await inTreeSlot(site, () => Promise.resolve("done"))).toBe("done");

      expect(treeTake).toHaveBeenCalledOnce();
      expect(entered(site)).toHaveBeenCalledOnce();
    },
  );

  it("no slots (outside an application): the lease's entry is still taken and left when the work ends", async () => {
    const leave = vi.fn();
    const site = siteOf({
      execution: { lease: { scopeKey: "s", enterStep: vi.fn(() => Promise.resolve(leave)) } },
    });

    expect(await inTreeSlot(site, () => Promise.resolve(7))).toBe(7);
    expect(leave).toHaveBeenCalledOnce();
  });

  it("a lease that yields no entry (no lease at all): the work runs, nothing to leave", async () => {
    const site = siteOf({ execution: { lease: undefined } });

    expect(await inTreeSlot(site, () => Promise.resolve(1))).toBe(1);
  });

  it("the entry is left although the work throws, and the error is the work's", async () => {
    const leave = vi.fn();
    const site = siteOf({
      execution: { lease: { scopeKey: "s", enterStep: vi.fn(() => Promise.resolve(leave)) } },
    });

    await expect(
      inTreeSlot(site, () => Promise.reject(new Error("the step failed"))),
    ).rejects.toThrow("the step failed");
    expect(leave).toHaveBeenCalledOnce();
  });

  it("the step's body is an entry of the instance's running steps", async () => {
    const track = vi.fn((_frame: unknown, work: () => Promise<unknown>) => work());
    const { registry } = slotsOf();
    const site = siteOf({ slots: { ...registry, steps: { track } } });

    await inTreeSlot(site, () => Promise.resolve(1));

    expect(track).toHaveBeenCalledOnce();
    expect(track.mock.calls[0]?.[0]).toBe(site);
  });

  it("the tree's slot is the root's cap on the application's clock, claimed for this execution, its depth and the signal", async () => {
    const { registry, slotsOfTree, treeTake } = slotsOf();
    const watch = { enter: vi.fn(), leave: vi.fn() };
    const site = siteOf({ slots: registry, watch });

    await inTreeSlot(site, () => Promise.resolve(1));

    expect(slotsOfTree).toHaveBeenCalledWith(
      { executionId: "root-1", workflow: { type: { cap: 5 } } },
      5,
      expect.anything(),
    );
    expect(treeTake).toHaveBeenCalledWith(
      { executionId: "child-1", depth: 2, closesBranch: false, subtrees: [] },
      site.execution.signal,
      watch,
    );
  });

  it("a root with no parent is its own tree: depth 1", async () => {
    const { registry, slotsOfTree, treeTake } = slotsOf();
    const site = siteOf({
      slots: registry,
      execution: { parent: undefined, workflow: { type: { cap: undefined } } },
    });

    await inTreeSlot(site, () => Promise.resolve(1));

    expect(slotsOfTree).toHaveBeenCalledWith(site.execution, 10, expect.anything());
    expect(treeTake).toHaveBeenCalledWith(
      expect.objectContaining({ depth: 1 }),
      expect.anything(),
      undefined,
    );
  });

  it("a step right after a child workflow closes a branch; after anything else, or after nothing known, it does not", async () => {
    const taken = async (path: string[], nodes: Map<string, unknown>) => {
      const { registry, treeTake } = slotsOf();
      await inTreeSlot(
        siteOf({ slots: registry, state: stateOf({ path }), graph: { nodes } }),
        () => Promise.resolve(1),
      );
      return treeTake.mock.calls[0]?.[0].closesBranch;
    };
    const nodes = new Map<string, unknown>([
      ["child-workflow", { kind: NodeKind.Workflow }],
      ["other-agent", { kind: NodeKind.Agent }],
    ]);

    const looked = vi.spyOn(nodes, "get");
    expect(await taken([], nodes)).toBe(false);
    expect(looked).not.toHaveBeenCalled();
    expect(await taken(["child-workflow"], nodes)).toBe(true);
    expect(await taken(["other-agent"], nodes)).toBe(false);
    expect(await taken(["unknown"], nodes)).toBe(false);
    expect(await taken([], nodes)).toBe(false);
  });

  it("the subtrees below the root whose own cap is smaller than every cap around them", async () => {
    const { registry, treeTake } = slotsOf();
    const member = (executionId: string, cap?: number) => ({
      executionId,
      workflow: { type: { cap } },
    });
    // root cap 10 (its default): a 3, a 5 (not below 3), none, a 3 again (not below 3), a 2
    const line = [
      member("root", undefined),
      member("a", 3),
      member("b", 5),
      member("c"),
      member("d", 3),
      member("e", 2),
    ];
    let execution: unknown;
    for (const one of line)
      execution = { ...one, ...(execution === undefined ? {} : { parent: { execution } }) };
    const site = siteOf({ slots: registry, execution });

    await inTreeSlot(site, () => Promise.resolve(1));

    expect(treeTake).toHaveBeenCalledWith(
      expect.objectContaining({
        depth: 6,
        subtrees: [
          { executionId: "a", maxConcurrentExecutions: 3 },
          { executionId: "e", maxConcurrentExecutions: 2 },
        ],
      }),
      expect.anything(),
      undefined,
    );
  });

  it("a tree slot a cancel ended: the cancel is thrown naming the tree slot, the work never run, no entry taken", async () => {
    const { registry, instanceTake } = slotsOf({ tree: false, instance: "grant" });
    const site = siteOf({ slots: registry });
    const work = vi.fn(() => Promise.resolve(1));

    const thrown = await inTreeSlot(site, work).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(ExecutionCancelledError);
    expect((thrown as Error).message).toBe("the execution was cancelled waiting for a tree slot");
    expect(work).not.toHaveBeenCalled();
    expect(instanceTake).not.toHaveBeenCalled();
    expect(entered(site)).not.toHaveBeenCalled();
  });

  it("an application with no cap on its steps: only the tree's slot, released after the work", async () => {
    const { registry, log } = slotsOf();
    const site = siteOf({ slots: registry });

    await inTreeSlot(site, () => {
      log.push("work");
      return Promise.resolve(1);
    });

    expect(log).toEqual(["work", "tree"]);
  });

  it("an instance's step slot is claimed with the same claim, the signal, the watch and the lease's scope; both are released after the work, the instance's first", async () => {
    const { registry, log, instanceTake, treeTake } = slotsOf({ instance: "grant" });
    const watch = { enter: vi.fn(), leave: vi.fn() };
    const site = siteOf({ slots: registry, watch });

    await inTreeSlot(site, () => {
      log.push("work");
      return Promise.resolve(1);
    });

    expect(instanceTake).toHaveBeenCalledWith(
      treeTake.mock.calls[0]?.[0],
      site.execution.signal,
      watch,
      "scope-1",
    );
    expect(log).toEqual(["work", "instance", "tree"]);
  });

  it("an instance's step slot with no lease: no scope", async () => {
    const { registry, instanceTake } = slotsOf({ instance: "grant" });
    const site = siteOf({ slots: registry, execution: { lease: undefined } });

    await inTreeSlot(site, () => Promise.resolve(1));

    expect(instanceTake.mock.calls[0]?.[3]).toBeUndefined();
  });

  it("an instance's step slot a cancel ended: the tree's slot is given back, the cancel names the instance's slot, the work never run", async () => {
    const { registry, log } = slotsOf({ instance: "refuse" });
    const site = siteOf({ slots: registry });
    const work = vi.fn(() => Promise.resolve(1));

    const thrown = await inTreeSlot(site, work).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(ExecutionCancelledError);
    expect((thrown as Error).message).toBe(
      "the execution was cancelled waiting for a step slot of the instance",
    );
    expect(log).toEqual(["tree"]);
    expect(work).not.toHaveBeenCalled();
  });

  it("both slots are released although the work throws", async () => {
    const { registry, log } = slotsOf({ instance: "grant" });
    const site = siteOf({ slots: registry });

    await expect(inTreeSlot(site, () => Promise.reject(new Error("failed")))).rejects.toThrow(
      "failed",
    );

    expect(log).toEqual(["instance", "tree"]);
  });
});
