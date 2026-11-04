/**
 * #633 (undo shard) — the instance's mirror of undoable actions (`CompensationRegistry`) on its
 * own: trees kept apart, an entry read through the caller's filter, a seal that catches only open
 * entries it covers, and a lift that frees what it sealed — never another unwind's seal.
 */
import { describe, expect, it, vi } from "vitest";
import { CompensationEntryStatus } from "../../../src/flow/compensation.js";
import { CompensationRegistry } from "../../../src/flow/runtime/compensation/registry.js";
import { closedOf, entryOf, TREE } from "./fixtures/compensation-entries.js";

const OTHER_TREE = { tenantId: "acme", rootExecutionId: "root-2" };
const all = () => true;

describe("#633: the registry's trees and reads", () => {
  it("two trees keep their own entries; a read keeps only what its filter matches", () => {
    const registry = new CompensationRegistry();
    registry.write(TREE, [entryOf("a"), entryOf("b", { executionId: "child-1" })]);
    registry.write(OTHER_TREE, [entryOf("c")]);

    expect(registry.entriesOf(TREE, all).map((entry) => entry.key)).toEqual(["a", "b"]);
    expect(registry.entriesOf(OTHER_TREE, all).map((entry) => entry.key)).toEqual(["c"]);
    const ofChild = registry.entriesOf(TREE, (entry) => entry.executionId === "child-1");
    expect(ofChild.map((entry) => entry.key)).toEqual(["b"]);
  });
});

describe("#633: seals", () => {
  it("a sealed tree hands a new open entry it covers to the seal, keeps a closed one", () => {
    const registry = new CompensationRegistry();
    const late = vi.fn();
    registry.seal(TREE, all, late);

    registry.write(TREE, [entryOf("late"), closedOf(entryOf("done"))]);

    expect(late.mock.calls.map(([entry]) => (entry as { key: string }).key)).toEqual(["late"]);
    expect(registry.entriesOf(TREE, all).map((entry) => entry.status)).toEqual([
      CompensationEntryStatus.Closed,
    ]);
  });

  it("a lift frees what it sealed: the next open entry is kept", () => {
    const registry = new CompensationRegistry();
    const late = vi.fn();
    const lift = registry.seal(TREE, all, late);

    lift();
    registry.write(TREE, [entryOf("after")]);

    expect(late).not.toHaveBeenCalled();
    expect(registry.entriesOf(TREE, all).map((entry) => entry.key)).toEqual(["after"]);
  });

  it("lifting one of two seals leaves the other", () => {
    const registry = new CompensationRegistry();
    const [first, second] = [vi.fn(), vi.fn()];
    const lift = registry.seal(TREE, (entry) => entry.executionId === "child-1", first);
    registry.seal(TREE, (entry) => entry.executionId === "child-2", second);

    lift();
    registry.write(TREE, [
      entryOf("one", { executionId: "child-1" }),
      entryOf("two", { executionId: "child-2" }),
    ]);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it("a tree's last seal lifted: no sealed tree left behind; one of two lifted: still sealed", () => {
    const registry = new CompensationRegistry();
    const first = registry.seal(TREE, all, vi.fn());
    const second = registry.seal(TREE, all, vi.fn());

    first();
    const withOne = registry.sealedTrees;
    second();

    expect([withOne, registry.sealedTrees]).toEqual([1, 0]);
  });

  it("an old seal lifted again after a new one: the new one stays", () => {
    const registry = new CompensationRegistry();
    const [old, current] = [vi.fn(), vi.fn()];
    const lift = registry.seal(TREE, all, old);
    lift();
    registry.seal(TREE, all, current);

    lift();
    registry.write(TREE, [entryOf("late")]);

    expect(current).toHaveBeenCalledOnce();
  });
});
