import { errorRecordOf, RecordedError } from "../../../src/core/error-record.js";
import { describe, expect, it } from "vitest";
import { AGBossError, ExecutionCancelledError } from "../../../src/core/errors.js";
import {
  CompensationEntryStatus,
  CompensationReason,
  CompensationStatus,
  type CompensationEntry,
} from "../../../src/flow/compensation.js";
import {
  causeOfMark,
  childUnwindingKeyOf,
  compensatedKeyOf,
  markUndone,
  markUnwinding,
  unwindingMarkOf,
  unwindingOf,
  UNWINDING_KEY,
  withUndoneMarks,
  type UnwindMarks,
} from "../../../src/flow/runtime/compensation/unwinding-marks.js";
import { bareRecordOf, ComponentKind } from "../../../src/flow/runtime/records.js";
import { InMemoryDatabase } from "../../../src/infrastructure/in-memory-database.js";
import { InMemoryExecutionTreeRepository } from "../../../src/infrastructure/execution-tree.repository.js";

/**
 * #340 PR 4 — the reserved keys of an undo under way: `@agboss/unwinding` (`{ reason, cause }`, the
 * first one kept), `@agboss/unwinding:<childExecutionId>` and `@agboss/compensated/<key>` for each
 * undo that succeeded — read back as closed entries with their records; a failed undo is not marked,
 * and a value the framework did not write reads as none.
 */

const tree = { tenantId: "default", rootExecutionId: "root-1" };

/** Marks on a store of their own: `trees` is the store, always there. */
const marksOf = (): UnwindMarks & { readonly trees: InMemoryExecutionTreeRepository } => ({
  trees: new InMemoryExecutionTreeRepository(new InMemoryDatabase()),
  tree,
  key: UNWINDING_KEY,
});

const entry = (key: string): CompensationEntry => ({
  key,
  executionId: "root-1",
  sequence: 1,
  action: "reserve-room-action",
  compensated: {
    component: bareRecordOf("reserve-room-action", ComponentKind.Action),
    nodeId: "reserve-room-action",
    visitNumber: 1,
    idempotencyKey: key,
    callId: undefined,
    itemIndex: undefined,
    copyNumber: 1,
    toolLoopIteration: undefined,
    validationAttempts: 0,
  },
  compensator: "release-room-action",
  input: {},
  status: CompensationEntryStatus.Open,
});

const undone = (key: string, status: CompensationStatus): CompensationEntry => ({
  ...entry(key),
  status: CompensationEntryStatus.Closed,
  undo: {
    compensated: entry(key).compensated,
    compensator: { ...bareRecordOf("release-room-action", ComponentKind.Action), schemaHash: "h" },
    reason: CompensationReason.ExecutionFailed,
    status,
    startedAt: "2026-01-05T09:00:00.000Z",
    endedAt: "2026-01-05T09:00:01.000Z",
  },
});

describe("the keys", () => {
  it("are reserved @agboss/ keys, the compensated one by the automatic undo's own key", () => {
    expect(UNWINDING_KEY).toBe("@agboss/unwinding");
    expect(childUnwindingKeyOf("child-1")).toBe("@agboss/unwinding:child-1");
    expect(compensatedKeyOf("root-1:a:1")).toBe("@agboss/compensated/root-1:a:1:compensation");
  });
});

describe("@agboss/unwinding", () => {
  it("keeps the first reason, and rebuilds the error it ends with", async () => {
    const marks = marksOf();
    await markUnwinding(marks, unwindingMarkOf(new ExecutionCancelledError("cancelled here")));
    await markUnwinding(marks, unwindingMarkOf(new Error("a later failure")));

    const mark = await unwindingOf(marks.trees, tree, UNWINDING_KEY);

    expect(mark).toMatchObject({
      reason: CompensationReason.ExecutionCancelled,
      cause: { name: "ExecutionCancelledError", message: "cancelled here" },
      // #598: and its record, its class line by code
      error: { name: "ExecutionCancelledError", lineage: ["execution.cancelled", "agboss"] },
    });
    expect(mark && causeOfMark(mark)).toBeInstanceOf(ExecutionCancelledError);
  });

  it("#598: a failure is rebuilt from its record; a thrown value as a plain Error, never a framework error", async () => {
    const marks = marksOf();
    await markUnwinding(marks, unwindingMarkOf("a string thrown"));

    const mark = await unwindingOf(marks.trees, tree, UNWINDING_KEY);
    const error = mark && causeOfMark(mark);

    expect(mark?.reason).toBe(CompensationReason.ExecutionFailed);
    expect(error).toBeInstanceOf(RecordedError);
    expect(error).not.toBeInstanceOf(AGBossError);
    expect(error && errorRecordOf(error).lineage).toEqual(["Error"]);
    expect(error?.message).toBe("a string thrown");
  });

  it.each([
    ["no value", undefined],
    ["a text", "unwinding"],
    ["an unknown reason", { reason: "other", cause: { name: "E", message: "m" } }],
    ["no cause", { reason: CompensationReason.ExecutionFailed }],
    [
      "a cause without a message",
      { reason: CompensationReason.ExecutionFailed, cause: { name: "E" } },
    ],
  ])("%s reads as none", async (_name, value) => {
    const marks = marksOf();
    if (value !== undefined) await marks.trees.saveIfAbsentInTree(tree, UNWINDING_KEY, value);

    expect(await unwindingOf(marks.trees, tree, UNWINDING_KEY)).toBeUndefined();
  });
});

describe("without tree keys", () => {
  it("nothing is marked and nothing is read back", async () => {
    const marks: UnwindMarks = { trees: undefined, tree, key: UNWINDING_KEY };
    await markUnwinding(marks, unwindingMarkOf(new Error("failed")));
    await markUndone(marks, undone("k-1", CompensationStatus.Compensated));

    expect(await withUndoneMarks(marks, [entry("k-1")])).toEqual([entry("k-1")]);
  });
});

describe("@agboss/compensated/<key>", () => {
  it("an undo that succeeded reads back closed, with its record; a failed one stays open", async () => {
    const marks = marksOf();
    await markUndone(marks, undone("k-1", CompensationStatus.Compensated));
    await markUndone(marks, undone("k-2", CompensationStatus.Failed));
    await markUndone(marks, entry("k-3"));

    const [first, second, third, committed] = await withUndoneMarks(marks, [
      entry("k-1"),
      entry("k-2"),
      entry("k-3"),
      { ...entry("k-4"), status: CompensationEntryStatus.Committed },
    ]);

    expect(first?.status).toBe(CompensationEntryStatus.Closed);
    expect(first?.undo).toEqual({
      ...undone("k-1", CompensationStatus.Compensated).undo,
      compensator: {
        ...bareRecordOf("release-room-action", ComponentKind.Action),
        schemaHash: "h",
      },
    });
    expect(second?.status).toBe(CompensationEntryStatus.Open);
    expect(third?.status).toBe(CompensationEntryStatus.Open);
    expect(committed?.status).toBe(CompensationEntryStatus.Committed);
  });

  it.each([
    ["a text", "done"],
    ["no compensator", { reason: CompensationReason.ExecutionFailed }],
    [
      "no times",
      { compensator: "release-room-action", reason: CompensationReason.ExecutionFailed },
    ],
    [
      "no schema hash",
      {
        compensator: "release-room-action",
        reason: CompensationReason.ExecutionFailed,
        startedAt: "a",
        endedAt: "b",
        schemaHash: null,
      },
    ],
  ])(
    "%s: a value the framework did not write is none, its own without a hash is kept",
    async (name, value) => {
      const marks = marksOf();
      await marks.trees.saveIfAbsentInTree(tree, compensatedKeyOf("k-1"), value);

      const [read] = await withUndoneMarks(marks, [entry("k-1")]);

      const isKept = name === "no schema hash";
      expect(read?.status).toBe(
        isKept ? CompensationEntryStatus.Closed : CompensationEntryStatus.Open,
      );
      expect(read?.undo?.compensator.schemaHash).toBeUndefined();
    },
  );
});
