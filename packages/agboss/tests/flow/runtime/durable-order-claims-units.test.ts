/**
 * #1356 (WP6, undo shard): what opens an entry in the tree's durable order, and how a place in it
 * is claimed — after the newest the visit's state holds, probing upward past a place another
 * execution claimed, the in-process place kept (and said) when the tree's store fails.
 */
import { describe, expect, it, vi } from "vitest";
import { Action } from "../../../src/index.js";
import type { VisitCompensationSite } from "../../../src/flow/compensation.js";
import { declarationOf } from "../../../src/flow/decorators/declaration.js";
import {
  claimedSequence,
  opensEntry,
  orderKeyOf,
} from "../../../src/flow/runtime/compensation/durable-order.js";
import { CompensationRegistry } from "../../../src/flow/runtime/compensation/registry.js";
import { ComponentKind } from "../../../src/flow/runtime/records.js";
import { entryOf } from "./fixtures/compensation-entries.js";

@Action({ name: "release-action", description: "Releases", input: {} })
class ReleaseAction {
  execute(): Promise<void> {
    return Promise.resolve();
  }
}

@Action({
  name: "reserve-action",
  description: "Reserves",
  input: {},
  compensateWith: ReleaseAction,
})
class ReserveAction {
  execute(): Promise<void> {
    return Promise.resolve();
  }
}

@Action({ name: "plain-action", description: "Nothing to undo", input: {} })
class PlainAction {
  execute(): Promise<void> {
    return Promise.resolve();
  }
}

const siteOf = (
  over: Partial<VisitCompensationSite> = {},
  component: unknown = ReserveAction,
): VisitCompensationSite =>
  ({
    node: {
      id: "reserve-action",
      kind: ComponentKind.Action,
      component,
      declaration: declarationOf(component as never),
    },
    entries: [],
    frame: { execution: { executionId: "exec-1", tenant: { tenantId: "acme" } } },
    ...over,
  }) as never;

describe("what opens an entry", () => {
  it("an undoable action that succeeded, and nothing else", () => {
    expect(opensEntry(siteOf())).toBe(true);
    expect(opensEntry(siteOf({ failure: new Error("x") }))).toBe(false);
    expect(opensEntry(siteOf({}, PlainAction))).toBe(false);
    expect(opensEntry(siteOf({ failure: new Error("x") }, PlainAction))).toBe(false);
  });
});

describe("the place a visit claims in the tree's order", () => {
  const trees = (claimed: Set<string>) => ({
    saveIfAbsentInTree: vi.fn((_tree: unknown, key: string) => {
      if (claimed.has(key)) return Promise.resolve(false);
      claimed.add(key);
      return Promise.resolve(true);
    }),
  });

  it("names a place's key", () => {
    expect(orderKeyOf(7)).toBe("@agboss/compensation-order/7");
  });

  it("is none without the instance's parts", async () => {
    expect(await claimedSequence(siteOf())).toBeUndefined();
  });

  it("is the in-process place after the newest of the state, when the tree has no store", async () => {
    const registry = new CompensationRegistry();
    const parts = { registry } as never;
    const entries = [entryOf("a", { sequence: 5 }), entryOf("b", { sequence: 9 })];

    expect(await claimedSequence(siteOf({ parts, entries }))).toBe(10);
    expect(await claimedSequence(siteOf({ parts, entries: [] }))).toBe(11);
  });

  it("starts from 1 in a state that holds nothing, and claims that place in the tree's own store", async () => {
    const claimed = new Set<string>();
    const store = trees(claimed);
    const parts = { registry: new CompensationRegistry(), trees: store } as never;

    expect(await claimedSequence(siteOf({ parts }))).toBe(1);
    expect(store.saveIfAbsentInTree).toHaveBeenCalledExactlyOnceWith(
      { tenantId: "acme", rootExecutionId: "exec-1" },
      orderKeyOf(1),
      true,
    );
  });

  it("probes upward past the places another execution of the tree claimed", async () => {
    const claimed = new Set([orderKeyOf(1), orderKeyOf(2), orderKeyOf(4)]);
    const store = trees(claimed);
    const parts = { registry: new CompensationRegistry(), trees: store } as never;

    expect(await claimedSequence(siteOf({ parts }))).toBe(3);
    expect(claimed.has(orderKeyOf(3))).toBe(true);
    expect(store.saveIfAbsentInTree.mock.calls.map((call) => call[1])).toEqual([
      orderKeyOf(1),
      orderKeyOf(2),
      orderKeyOf(3),
    ]);
  });

  it("keeps the in-process place and says so when the store fails", async () => {
    const warn = vi.fn();
    const parts = {
      registry: new CompensationRegistry(),
      trees: { saveIfAbsentInTree: () => Promise.reject(new Error("store down")) },
      log: { warn },
    } as never;

    expect(await claimedSequence(siteOf({ parts, entries: [entryOf("a", { sequence: 2 })] }))).toBe(
      3,
    );
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "compensation.order-unclaimed",
      "place 3 in the tree's undo order could not be claimed; the in-process place is kept",
      { executionId: "exec-1", tenantId: "acme" },
    );
  });

  it("keeps the place when the store fails and nobody is listening", async () => {
    const parts = {
      registry: new CompensationRegistry(),
      trees: { saveIfAbsentInTree: () => Promise.reject(new Error("store down")) },
    } as never;

    expect(await claimedSequence(siteOf({ parts }))).toBe(1);
  });
});
