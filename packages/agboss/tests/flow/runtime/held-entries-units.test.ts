import { beforeEach, describe, expect, it, vi } from "vitest";
import { NodeKind } from "../../../src/flow/ast.js";
import { CompensationEntryStatus, type CompensationEntry } from "../../../src/flow/compensation.js";
import type { FrameSpec } from "../../../src/flow/context/frame.js";
import type { UndoSite } from "../../../src/flow/runtime/compensation/undo.js";
import {
  assertTaking,
  canHoldEntries,
  canLeaveEntries,
  heldUndoSiteOf,
  holderOf,
  inBranch,
  isChildsEntry,
  isOwnEntry,
  movedToParent,
  takenFromChild,
  treeOfFrame,
  type ChildDepsSource,
} from "../../../src/flow/runtime/compensation/held-entries.js";
import { handedOverOf, recordedHandOver } from "../../../src/app/handed-over.js";
import { HandOverSite } from "../../../src/infrastructure/execution-audit-log.repository.js";

vi.mock("../../../src/app/handed-over.js", () => ({
  handedOverOf: vi.fn(),
  recordedHandOver: vi.fn((handedOver: unknown) => handedOver),
}));

vi.mock("../../../src/flow/runtime/workflow-keys.js", () => ({
  workflowIdentityOf: (deps: { readonly name: string }) => ({
    type: deps,
    name: deps.name,
    version: `${deps.name}-version`,
    configHash: `${deps.name}-hash`,
  }),
  joinKeysOf: (deps: { readonly name: string }) => ({
    configHash: `${deps.name}-hash`,
    components: new Map([[deps.name, { name: deps.name }]]),
  }),
}));

/**
 * #1281b — the pure parts of a child's undo moving up: who holds an entry, what a child's finish
 * writes and its parent's step takes (once, by key, under the parent's node and branch), whether
 * a launched node can leave an entry, and where a held entry undoes.
 */

const entry = (over: Partial<CompensationEntry> = {}): CompensationEntry =>
  ({
    key: "k-1",
    executionId: "child",
    sequence: 1,
    action: "reserve-action",
    compensator: "release-action",
    input: {},
    status: CompensationEntryStatus.Open,
    ...over,
  }) as CompensationEntry;

beforeEach(() => {
  vi.mocked(handedOverOf).mockReset();
  vi.mocked(recordedHandOver).mockClear();
});

describe("#1281b: who holds an entry", () => {
  it("its holder is the execution that moved it up, else its own", () => {
    expect(holderOf(entry())).toBe("child");
    expect(holderOf(entry({ heldBy: "parent" }))).toBe("parent");
  });

  it("an own entry has no child path", () => {
    expect(isOwnEntry(entry())).toBe(true);
    expect(isOwnEntry(entry({ childPath: ["trip"] }))).toBe(false);
  });

  it("a child's unwind covers what it opened, moved up or not, and what was moved up to it", () => {
    expect(isChildsEntry(entry(), "child")).toBe(true);
    expect(isChildsEntry(entry({ heldBy: "parent" }), "child")).toBe(true);
    expect(isChildsEntry(entry({ executionId: "grandchild", heldBy: "child" }), "child")).toBe(
      true,
    );
    expect(isChildsEntry(entry({ executionId: "grandchild", heldBy: "parent" }), "child")).toBe(
      false,
    );
  });
});

describe("#1281b: a child's finish moves its open entries up", () => {
  it("each to the parent, out of the child's own launches, still open, the rest kept", () => {
    const opened = entry({ launchId: "inner", branchIndex: 2, childPath: ["g"], sequence: 4 });

    expect(movedToParent([opened], "parent")).toEqual([
      {
        key: "k-1",
        executionId: "child",
        sequence: 4,
        action: "reserve-action",
        compensator: "release-action",
        input: {},
        status: CompensationEntryStatus.Open,
        childPath: ["g"],
        heldBy: "parent",
      },
    ]);
  });
});

describe("#1281b: the parent's step takes what was moved up to it", () => {
  it("only the open ones moved to this parent, under its node of the child", () => {
    const child = [
      entry({ key: "a", heldBy: "parent" }),
      entry({ key: "b", heldBy: "parent", childPath: ["g"] }),
      entry({ key: "c", heldBy: "parent", status: CompensationEntryStatus.Committed }),
      entry({ key: "d", heldBy: "parent", status: CompensationEntryStatus.Closed }),
      entry({ key: "e", heldBy: "other" }),
      entry({ key: "f" }),
    ];

    expect(takenFromChild(child, "parent", "trip")).toEqual([
      entry({ key: "a", heldBy: "parent", childPath: ["trip"] }),
      entry({ key: "b", heldBy: "parent", childPath: ["trip", "g"] }),
    ]);
  });

  it("taken again from the same child state (a step run again), the same entries", () => {
    const child = [entry({ heldBy: "parent", childPath: ["g"] })];

    expect(takenFromChild(child, "parent", "trip")).toEqual(
      takenFromChild(child, "parent", "trip"),
    );
    expect(child[0]?.childPath).toEqual(["g"]);
  });

  it("a branch stamps its launch and index on each", () => {
    expect(inBranch([entry()], { launchId: "l-1", branchIndex: 0 })).toEqual([
      entry({ launchId: "l-1", branchIndex: 0 }),
    ]);
  });

  it("the tree of a frame: its tenant and its root's id", () => {
    const root = { executionId: "root", tenant: { tenantId: "t" } };
    const frame: FrameSpec = {
      execution: { executionId: "c", tenant: { tenantId: "t" }, parent: { execution: root } },
    } as never;

    expect(treeOfFrame(frame)).toEqual({ tenantId: "t", rootExecutionId: "root" });
  });
});

describe("#1281b: the parent takes nothing past its lease", () => {
  const frameWith = (assertHeld: () => void): FrameSpec =>
    ({ execution: { signal: new AbortController().signal, lease: { assertHeld } } }) as never;

  it("a held lease, or none, lets it take", () => {
    expect(() => {
      assertTaking(frameWith(() => undefined));
    }).not.toThrow();
    expect(() => {
      assertTaking({ execution: { signal: new AbortController().signal } } as never);
    }).not.toThrow();
  });

  it("a lost lease is a hand-over at the child, recorded", () => {
    const handedOver = new Error("lease lost");
    vi.mocked(handedOverOf).mockReturnValue(handedOver as never);
    const frame = frameWith(() => {
      throw new Error("fenced");
    });

    expect(() => {
      assertTaking(frame);
    }).toThrow(handedOver);
    expect(recordedHandOver).toHaveBeenCalledWith(handedOver, HandOverSite.Child, frame);
  });

  it("any other error is thrown as it is", () => {
    const thrown = new Error("the store is down");
    vi.mocked(handedOverOf).mockReturnValue(undefined);

    expect(() => {
      assertTaking(
        frameWith(() => {
          throw thrown;
        }),
      );
    }).toThrow(thrown);
    expect(recordedHandOver).not.toHaveBeenCalled();
  });
});

/** A workflow's deps as the helpers read them: its graph's nodes and its children's deps. */
interface FakeDeps extends ChildDepsSource {
  readonly name: string;
  readonly container: { readonly get: () => never };
}

const action = (id: string, undoable: boolean) => ({
  id,
  kind: NodeKind.Action,
  component: {},
  declaration: {
    kind: NodeKind.Action,
    options: undoable ? { compensateWith: {} } : {},
  },
});

const workflowNode = (id: string, component: unknown) => ({
  id,
  kind: NodeKind.Workflow,
  component,
  declaration: { kind: NodeKind.Workflow, options: {} },
});

function depsOf(
  name: string,
  type: object,
  nodes: readonly { readonly id: string }[],
  children: ReadonlyMap<unknown, FakeDeps> = new Map(),
): FakeDeps {
  return {
    name,
    graph: { type, nodes: new Map(nodes.map((node) => [node.id, node])) } as never,
    childDepsOf: (workflow) => children.get(workflow) as never,
    container: { get: () => undefined as never },
  };
}

describe("#1281b: what a launched node can leave to its join", () => {
  const Trip = {};
  const Plain = {};
  const Root = {};
  const trip = depsOf("trip", Trip, [action("reserve", true)]);
  const plain = depsOf("plain", Plain, [action("note", false)]);
  const root = depsOf(
    "root",
    Root,
    [
      action("charge", true),
      action("log", false),
      workflowNode("trip", Trip),
      workflowNode("plain", Plain),
      workflowNode("self", Root),
      workflowNode("missing", {}),
      { id: "agent", kind: NodeKind.Agent, declaration: { kind: NodeKind.Agent } } as never,
    ],
    new Map<unknown, FakeDeps>([
      [Trip, trip],
      [Plain, plain],
    ]),
  );

  it("an undoable action, a child that can hold one; nothing else", () => {
    expect(canLeaveEntries(root, "charge")).toBe(true);
    expect(canLeaveEntries(root, "log")).toBe(false);
    expect(canLeaveEntries(root, "trip")).toBe(true);
    expect(canLeaveEntries(root, "plain")).toBe(false);
    expect(canLeaveEntries(root, "missing")).toBe(false);
    expect(canLeaveEntries(root, "agent")).toBe(false);
    expect(canLeaveEntries(root, "nowhere")).toBe(false);
  });

  it("a recursion leaves what its own workflow opens", () => {
    expect(canLeaveEntries(root, "self")).toBe(true);
    const lone = depsOf("lone", Plain, [workflowNode("self", Plain), action("note", false)]);
    expect(canLeaveEntries(lone, "self")).toBe(false);
  });

  it("a workflow holds entries when a child at any depth opens one, its cycles read once", () => {
    const Middle = {};
    const middle = depsOf(
      "middle",
      Middle,
      [workflowNode("trip", Trip), workflowNode("self", Middle)],
      new Map<unknown, FakeDeps>([[Trip, trip]]),
    );
    expect(canHoldEntries(middle)).toBe(true);
    expect(canHoldEntries(plain)).toBe(false);
    expect(canHoldEntries(trip, new Set([trip.graph]))).toBe(false);
  });
});

describe("#1281b: where a held entry undoes", () => {
  const Trip = {};
  const Middle = {};
  const Root = {};
  const trip = depsOf("trip", Trip, [action("reserve", true)]);
  const middle = depsOf(
    "middle",
    Middle,
    [workflowNode("trip", Trip)],
    new Map<unknown, FakeDeps>([[Trip, trip]]),
  );
  const root = depsOf(
    "root",
    Root,
    [workflowNode("middle", Middle), workflowNode("self", Root), action("charge", true)],
    new Map<unknown, FakeDeps>([[Middle, middle]]),
  );
  const holder: UndoSite = {
    graph: root.graph,
    container: root.container,
    components: new Map(),
    execution: { executionId: "root", workflow: { name: "root" }, tenant: { tenantId: "t" } },
    reason: "quorum-excluded",
  } as never;

  it("one of the holder's own: the holder's site itself", () => {
    expect(heldUndoSiteOf(holder, root, entry())).toBe(holder);
  });

  it("down the path to the workflow that opened it: its graph, container, records and identity", () => {
    const site = heldUndoSiteOf(
      holder,
      root,
      entry({ executionId: "grandchild", childPath: ["middle", "trip"] }),
    );

    expect(site.graph).toBe(trip.graph);
    expect(site.container).toBe(trip.container);
    expect(site.components).toEqual(new Map([["trip", { name: "trip" }]]));
    expect(site.execution).toEqual({
      executionId: "grandchild",
      workflow: {
        type: trip,
        name: "trip",
        version: "trip-version",
        configHash: "trip-hash",
        startedVersion: "trip-version",
      },
      tenant: { tenantId: "t" },
    });
    expect(Object.isFrozen(site.execution)).toBe(true);
    expect(Object.isFrozen(site.execution.workflow)).toBe(true);
    expect(site.reason).toBe("quorum-excluded");
  });

  it("a recursion level: the holder's workflow, the level's own execution", () => {
    const site = heldUndoSiteOf(holder, root, entry({ executionId: "level", childPath: ["self"] }));

    expect(site.graph).toBe(root.graph);
    expect(site.execution.executionId).toBe("level");
    expect(site.execution.workflow).toEqual({ name: "root" });
  });

  it("a path that names no child workflow fails closed", () => {
    expect(() => heldUndoSiteOf(holder, root, entry({ childPath: ["middle", "nowhere"] }))).toThrow(
      new TypeError("nowhere is no child workflow to undo reserve-action in"),
    );
    expect(() => heldUndoSiteOf(holder, root, entry({ childPath: ["charge"] }))).toThrow(TypeError);
  });
});
