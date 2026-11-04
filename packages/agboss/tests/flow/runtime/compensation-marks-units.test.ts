/**
 * #633 (undo shard) — the reserved keys of an undo read and written at their boundary
 * (`unwinding-marks.ts`): a child's failure claim under its own key, a mark kept with its error's
 * record only when it has one, a value the framework did not write read as none, and a done
 * undo's mark read back only onto an entry still open.
 */
import { describe, expect, it } from "vitest";
import { CompensationEntryStatus, CompensationReason } from "../../../src/flow/compensation.js";
import {
  childFailureKeyOf,
  compensatedKeyOf,
  markUndone,
  markUnwinding,
  unwindingOf,
  withUndoneMarks,
  UNWINDING_KEY,
} from "../../../src/flow/runtime/compensation/unwinding-marks.js";
import { InMemoryDatabase } from "../../../src/infrastructure/in-memory-database.js";
import { InMemoryExecutionTreeRepository } from "../../../src/infrastructure/execution-tree.repository.js";
import { closedOf, entryOf, TREE } from "./fixtures/compensation-entries.js";

const storeOf = () => new InMemoryExecutionTreeRepository(new InMemoryDatabase());

describe("#633: the marks' keys", () => {
  it("a child's failure is claimed under @agboss/child-failure:<childExecutionId>", () => {
    expect(childFailureKeyOf("child-7")).toBe("@agboss/child-failure:child-7");
  });
});

describe("#633: a mark at the store's boundary", () => {
  it("a mark without an error's record is kept and read back without one", async () => {
    const trees = storeOf();
    const cause = { name: "Error", message: "declined" };
    await markUnwinding(
      { trees, tree: TREE, key: UNWINDING_KEY },
      { reason: CompensationReason.ExecutionFailed, cause },
    );

    const mark = await unwindingOf(trees, TREE, UNWINDING_KEY);

    expect(mark).toStrictEqual({ reason: CompensationReason.ExecutionFailed, cause });
  });

  it.each([
    ["an array", [{ reason: CompensationReason.ExecutionFailed }]],
    [
      "a cause without a text name",
      { reason: "execution-failed", cause: { name: 1, message: "m" } },
    ],
    ["a cause without a text message", { reason: "execution-failed", cause: { name: "n" } }],
  ])("%s: no mark", async (_case, value) => {
    const trees = storeOf();
    await trees.saveIfAbsentInTree(TREE, UNWINDING_KEY, value as never);

    expect(await unwindingOf(trees, TREE, UNWINDING_KEY)).toBeUndefined();
  });
});

describe("#633: a store that hands back live values", () => {
  it("a null value is no mark", async () => {
    const trees = { findByIdInTree: () => Promise.resolve(null) };

    expect(await unwindingOf(trees as never, TREE, UNWINDING_KEY)).toBeUndefined();
  });

  it("an array is no mark, even one that carries a mark's fields", async () => {
    const value = Object.assign([], {
      reason: CompensationReason.ExecutionFailed,
      cause: { name: "Error", message: "declined" },
    });
    const trees = { findByIdInTree: () => Promise.resolve(value) };

    expect(await unwindingOf(trees as never, TREE, UNWINDING_KEY)).toBeUndefined();
  });
});

describe("#633: a done undo's mark read back", () => {
  const done = {
    compensator: "release-room-action",
    schemaHash: null,
    reason: CompensationReason.ExecutionFailed,
    startedAt: "2026-10-20T12:00:00.000Z",
    endedAt: "2026-10-20T12:00:01.000Z",
  };

  it.each([
    ["no compensator's name", { ...done, compensator: 7 }],
    ["no start", { ...done, startedAt: undefined }],
    ["no end", { ...done, endedAt: undefined }],
  ])("a mark with %s: the entry stays open", async (_case, value) => {
    const trees = storeOf();
    await trees.saveIfAbsentInTree(TREE, compensatedKeyOf("k-1"), value as never);

    const [read] = await withUndoneMarks({ trees, tree: TREE }, [entryOf("k-1")]);

    expect(read?.status).toBe(CompensationEntryStatus.Open);
  });

  it("a committed entry stays committed, whatever its key's mark says", async () => {
    const trees = storeOf();
    await markUndone({ trees, tree: TREE }, closedOf(entryOf("k-1")));
    const committed = entryOf("k-1", { status: CompensationEntryStatus.Committed });

    expect(await withUndoneMarks({ trees, tree: TREE }, [committed])).toEqual([committed]);
  });
});
