import { afterEach, describe, expect, it } from "vitest";
import { InMemoryDatabase } from "../../../src/infrastructure/in-memory-database.js";
import {
  ExecutionTreeRepository,
  InMemoryExecutionTreeRepository,
} from "../../../src/infrastructure/execution-tree.repository.js";
import { heldStoreSeam, withHoldPoints } from "../../../src/testing/faults/held-stores.js";
import { HoldPhase, HoldPoints } from "../../../src/testing/faults/hold-points.js";
import { OperationHistory } from "../../../src/testing/faults/operation-history.js";
import { StoreHoldPoint } from "../../../src/testing/faults/store-points.js";
import { treeKeyFamilyOf } from "../../../src/testing/faults/tree-points.js";

/** #607 — the tree store's hold point: a key's write held by its family, recorded without a value. */

const tree = { tenantId: "default", rootExecutionId: "root-1" };
const done = "@agboss/compensated/root-1:reserve-action:1:compensation";

function heldTrees(database: InMemoryDatabase): ExecutionTreeRepository {
  const Concrete: unknown = withHoldPoints(InMemoryExecutionTreeRepository);
  return new (Concrete as new (...args: unknown[]) => ExecutionTreeRepository)(database);
}

const settled = async (promise: Promise<unknown>): Promise<boolean> => {
  let isDone = false;
  void promise.then(() => (isDone = true));
  await new Promise((resolve) => setImmediate(resolve));
  return isDone;
};

const history = new OperationHistory();
const points = new HoldPoints();

afterEach(() => {
  points.releaseAll();
});
heldStoreSeam.points = points;
heldStoreSeam.recorder = history;

describe("#607: the tree store's hold point", () => {
  it("names a key's family: the framework's prefix, a project's key as it is", () => {
    expect(treeKeyFamilyOf(done)).toBe("@agboss/compensated");
    expect(treeKeyFamilyOf("@agboss/unwinding")).toBe("@agboss/unwinding");
    expect(treeKeyFamilyOf("@agboss/unwinding:execution-2")).toBe("@agboss/unwinding");
    expect(treeKeyFamilyOf("@agboss/child-failure:execution-2")).toBe("@agboss/child-failure");
    expect(treeKeyFamilyOf("orders/seen")).toBe("orders/seen");
  });

  it("holds the write of a done mark after the store answered, and no other family", async () => {
    const trees = heldTrees(new InMemoryDatabase());
    points.arm({
      point: StoreHoldPoint.TreeSaveIfAbsent,
      key: "@agboss/compensated",
      phase: HoldPhase.After,
    });
    expect(await trees.saveIfAbsentInTree(tree, "@agboss/unwinding", { reason: "x" })).toBe(true);
    const held = trees.saveIfAbsentInTree(tree, done, { compensator: "release-action" });
    expect(await settled(held)).toBe(false);
    // written already: the hold is after the store
    expect(await trees.findByIdInTree(tree, done)).toEqual({ compensator: "release-action" });
    points.releaseAll();
    expect(await held).toBe(true);
    const recorded = history.operations.filter(
      ({ invoke }) => invoke.operation === StoreHoldPoint.TreeSaveIfAbsent,
    );
    expect(recorded.map(({ invoke }) => invoke.input)).toEqual([
      { ...tree, family: "@agboss/unwinding" },
      { ...tree, family: "@agboss/compensated" },
    ]);
    expect(recorded.map(({ complete }) => complete?.output)).toEqual([
      { saved: true },
      { saved: true },
    ]);
  });
});
