/** #1281b, #1356 (WP6, unwind shard): which entries a holder holds open, what a step takes of its child, and the walks over child workflows. */
import { describe, expect, it, vi } from "vitest";
import { CompensationEntryStatus } from "../../../src/flow/compensation.js";
import {
  canHoldEntries,
  canLeaveEntries,
  hasHeldEntries,
  isHeldOpen,
  takenBy,
  withTaken,
  type ChildDepsSource,
} from "../../../src/flow/runtime/compensation/held-entries.js";
import { ComponentKind } from "../../../src/flow/runtime/records.js";
import { entryOf } from "./fixtures/compensation-entries.js";

const held = (key: string, over = {}) =>
  entryOf(key, { executionId: "child-1", heldBy: "root-1", childPath: ["trip"], ...over });

describe("which entries a holder holds open", () => {
  it("an open entry a child moved up to it; not its own, not a closed one, not another holder's", () => {
    const holds = isHeldOpen("root-1");

    expect(holds(held("a"))).toBe(true);
    expect(holds(entryOf("own", { heldBy: "root-1" }))).toBe(false);
    expect(holds(held("closed", { status: CompensationEntryStatus.Closed }))).toBe(false);
    expect(holds(held("other", { heldBy: "other-1" }))).toBe(false);
    expect(holds(held("by-owner", { heldBy: undefined, executionId: "root-1" }))).toBe(true);
  });

  it("a list holds some when any one entry is one", () => {
    expect(hasHeldEntries([entryOf("own"), held("a"), entryOf("own-2")], "root-1")).toBe(true);
    expect(hasHeldEntries([entryOf("own"), held("a", { heldBy: "other-1" })], "root-1")).toBe(
      false,
    );
    expect(hasHeldEntries([], "root-1")).toBe(false);
  });
});

describe("what a step takes of its child's finish", () => {
  const frameOf = (assertHeld: () => void) =>
    ({
      execution: {
        executionId: "root-1",
        tenant: { tenantId: "acme" },
        lease: { assertHeld },
      },
    }) as never;

  it("with no registry: the taken entries first, the step's own after", () => {
    const own = entryOf("own");
    const found = held("a");

    const written = withTaken(
      { taken: [found], parts: undefined, frame: frameOf(() => undefined) },
      { compensations: [own] },
    );

    expect(written).toStrictEqual({ compensations: [found, own] });
  });

  it("a step with no entries of its own gives the taken ones alone", () => {
    const found = held("a");

    expect(
      withTaken({ taken: [found], parts: undefined, frame: frameOf(() => undefined) }, {}),
    ).toStrictEqual({ compensations: [found] });
  });

  it("mirrors the taken entries in the registry under the tree, as they are", () => {
    const write = vi.fn();
    const found = held("a");

    withTaken(
      { taken: [found], parts: { registry: { write } } as never, frame: frameOf(() => undefined) },
      {},
    );

    expect(write).toHaveBeenCalledExactlyOnceWith({ tenantId: "acme", rootExecutionId: "root-1" }, [
      found,
    ]);
  });

  it("takes nothing, mirrors nothing, when the child left nothing", () => {
    const write = vi.fn();
    const own = { compensations: [entryOf("own")] };

    expect(
      withTaken(
        { taken: [], parts: { registry: { write } } as never, frame: frameOf(() => undefined) },
        own,
      ),
    ).toBe(own);
    expect(
      withTaken({ taken: undefined, parts: undefined, frame: frameOf(() => undefined) }, own),
    ).toBe(own);
    expect(write).not.toHaveBeenCalled();
  });

  it("takenBy: what its child's finish moved to this execution, under its node, once the lease is held", () => {
    const assertHeld = vi.fn();
    const moved = held("a", { childPath: undefined, executionId: "child-1" });

    const taken = takenBy(frameOf(assertHeld), "trip-node", {
      compensations: [moved, entryOf("elsewhere", { heldBy: "other-1" })],
    });

    expect(assertHeld).toHaveBeenCalledOnce();
    expect(taken).toStrictEqual({ compensations: [{ ...moved, childPath: ["trip-node"] }] });
  });

  it("takenBy: a child that left nothing to this execution takes nothing and asks no lease", () => {
    const assertHeld = vi.fn(() => {
      throw new Error("the lease is lost");
    });

    expect(
      takenBy(frameOf(assertHeld), "trip-node", {
        compensations: [entryOf("own", { heldBy: "other-1" })],
      }),
    ).toStrictEqual({});
    expect(assertHeld).not.toHaveBeenCalled();
  });

  it("takenBy: a lease that is not held stops the take", () => {
    const lost = new Error("the lease is lost");

    expect(() =>
      takenBy(
        frameOf(() => {
          throw lost;
        }),
        "trip-node",
        { compensations: [held("a", { childPath: undefined })] },
      ),
    ).toThrow(lost);
  });
});

describe("the walks over child workflows", () => {
  const action = (id: string) => ({
    id,
    kind: ComponentKind.Action,
    component: {},
    declaration: { kind: ComponentKind.Action, options: {} },
  });
  const workflowNode = (id: string, component: unknown) => ({
    id,
    kind: ComponentKind.Workflow,
    component,
    declaration: { kind: ComponentKind.Workflow, options: {} },
  });
  const depsOf = (
    type: object,
    nodes: readonly { readonly id: string }[],
    children: () => ReadonlyMap<unknown, ChildDepsSource> = () => new Map(),
  ): ChildDepsSource => ({
    graph: { type, nodes: new Map(nodes.map((node) => [node.id, node])) } as never,
    childDepsOf: (workflow) => children().get(workflow) as never,
  });

  it("a workflow that has no way to find its children's deps holds nothing and leaves nothing", () => {
    const Child = {};
    const root: ChildDepsSource = {
      graph: {
        type: {},
        nodes: new Map([["trip", workflowNode("trip", Child)]]),
      } as never,
    };

    expect(canHoldEntries(root)).toBe(false);
    expect(canLeaveEntries(root, "trip")).toBe(false);
  });

  it("a workflow that launches itself, and nothing undoable, holds nothing", () => {
    const Lone = {};

    expect(canHoldEntries(depsOf(Lone, [workflowNode("self", Lone), action("note")]))).toBe(false);
  });

  it("two workflows that launch each other, and nothing undoable, are read once each and hold nothing", () => {
    const A = {};
    const B = {};
    const children = new Map<unknown, ChildDepsSource>();
    const a = depsOf(A, [workflowNode("b", B)], () => children);
    const b = depsOf(B, [workflowNode("a", A)], () => children);
    children.set(A, a).set(B, b);

    expect(canHoldEntries(a)).toBe(false);
    expect(canHoldEntries(b)).toBe(false);
  });
});
