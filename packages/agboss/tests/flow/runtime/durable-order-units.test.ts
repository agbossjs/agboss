/**
 * #1281 — the order the tree's undoable actions succeeded in is durable: a parent's entry, its
 * child's entry and the parent's next one are undone newest first after a resume in a fresh
 * process (a fresh registry), because each place is claimed in the tree's own store, across the
 * executions of the tree, and an entry moved up keeps the place it was written with.
 */
import { describe, expect, it, vi } from "vitest";
import { declarationOf } from "../../../src/flow/decorators/declaration.js";
import { Action } from "../../../src/index.js";
import { NodeKind } from "../../../src/flow/ast.js";
import {
  compensationsOfVisit,
  type CompensationEntry,
  type VisitCompensationSite,
} from "../../../src/flow/compensation.js";
import { mergedEntries } from "../../../src/flow/runtime/compensation/unwind.js";
import {
  movedToParent,
  takenFromChild,
} from "../../../src/flow/runtime/compensation/held-entries.js";
import { CompensationRegistry } from "../../../src/flow/runtime/compensation/registry.js";
import { orderKeyOf } from "../../../src/flow/runtime/compensation/durable-order.js";
import { InMemoryDatabase } from "../../../src/infrastructure/in-memory-database.js";
import { InMemoryExecutionTreeRepository } from "../../../src/infrastructure/execution-tree.repository.js";
import { bareRecordOf, ComponentKind } from "../../../src/flow/runtime/records.js";

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

const TREE = { tenantId: "acme", rootExecutionId: "root-1" };

const rootExecution = { executionId: "root-1", tenant: { tenantId: "acme" } };
const childExecution = {
  executionId: "child-1",
  tenant: { tenantId: "acme" },
  parent: { execution: rootExecution },
};

/** One visit of the reserve action in `execution`, as a process with `registry` runs it. */
function visit(
  execution: object,
  key: string,
  entries: readonly CompensationEntry[],
  registry: CompensationRegistry,
  trees: InMemoryExecutionTreeRepository,
): Promise<{ readonly compensations?: CompensationEntry[] }> {
  const site: VisitCompensationSite = {
    node: {
      id: "reserve-action",
      kind: NodeKind.Action,
      component: ReserveAction,
      declaration: declarationOf(ReserveAction),
    } as never,
    entries,
    frame: {
      step: {
        component: { type: Object, ...bareRecordOf("reserve-action", ComponentKind.Action) },
        nodeId: "reserve-action",
        visitNumber: 1,
        idempotencyKey: key,
        callId: undefined,
        itemIndex: undefined,
        copyNumber: 1,
        toolLoopIteration: undefined,
        validationAttempts: 0,
      },
      execution,
    } as never,
    scope: {},
    startedAt: new Date("2026-10-20T12:00:00.000Z"),
    endedAt: new Date("2026-10-20T12:00:01.000Z"),
    parts: { timeout: 1, registry, trees } as never,
  };
  return compensationsOfVisit(site);
}

const only = (written: { readonly compensations?: CompensationEntry[] }): CompensationEntry => {
  const [entry] = written.compensations ?? [];
  if (entry === undefined) throw new Error("the visit opened no entry");
  return entry;
};

describe("#1281: the undo order survives a resume in a fresh process", () => {
  it("a parent entry, a child entry, a parent entry: newest first, every process fresh", async () => {
    const trees = new InMemoryExecutionTreeRepository(new InMemoryDatabase());
    // process 1: the parent opens its first entry
    const a = only(await visit(rootExecution, "a", [], new CompensationRegistry(), trees));
    // process 2 (a restart): the child opens its own, its state holds nothing of the parent's
    const b = only(await visit(childExecution, "b", [], new CompensationRegistry(), trees));
    // the child's finish moves it up, the parent's step takes it: the place stays
    const taken = takenFromChild(movedToParent([b], "root-1"), "root-1", "child-node");
    // process 3 (another restart): the parent opens its next, its state holds both
    const d = only(
      await visit(rootExecution, "d", [a, ...taken], new CompensationRegistry(), trees),
    );

    expect([a, b, d].map((entry) => entry.sequence)).toEqual([1, 2, 3]);
    expect(taken[0]?.sequence).toBe(b.sequence);
    const unwound = [...mergedEntries([a], taken, [d])].sort((x, y) => y.sequence - x.sequence);
    expect(unwound.map((entry) => entry.key)).toEqual(["d", "b", "a"]);
  });

  it("two executions of one tree never share a place, whatever their state knows", async () => {
    const trees = new InMemoryExecutionTreeRepository(new InMemoryDatabase());
    const first = only(await visit(rootExecution, "x", [], new CompensationRegistry(), trees));
    const second = only(await visit(childExecution, "y", [], new CompensationRegistry(), trees));

    expect(new Set([first.sequence, second.sequence]).size).toBe(2);
    await expect(trees.findByIdInTree(TREE, orderKeyOf(second.sequence))).resolves.toBe(true);
  });

  it("a store that fails keeps the process's own place: the entry is not lost", async () => {
    const trees = new InMemoryExecutionTreeRepository(new InMemoryDatabase());
    vi.spyOn(trees, "saveIfAbsentInTree").mockRejectedValue(new Error("the store is down"));

    const entry = only(await visit(rootExecution, "a", [], new CompensationRegistry(), trees));

    expect(entry.sequence).toBe(1);
  });
});
