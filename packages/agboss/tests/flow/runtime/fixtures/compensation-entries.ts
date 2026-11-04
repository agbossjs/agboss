import {
  CompensationEntryStatus,
  CompensationReason,
  CompensationStatus,
  type CompensationEntry,
  type CompensationRecord,
} from "../../../../src/flow/compensation.js";
import { bareRecordOf, ComponentKind } from "../../../../src/flow/runtime/records.js";

/** The tree the units' entries belong to. */
export const TREE = { tenantId: "acme", rootExecutionId: "root-1" };

/** An open entry of `reserve-room-action`, undone by `release-room-action`. */
export const entryOf = (
  key: string,
  overrides: Partial<CompensationEntry> = {},
): CompensationEntry => ({
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
  ...overrides,
});

/** The record of an undo of `entry` that ended `status`. */
export const undoOf = (
  entry: CompensationEntry,
  status = CompensationStatus.Compensated,
): CompensationRecord => ({
  compensated: entry.compensated,
  compensator: bareRecordOf(entry.compensator, ComponentKind.Action),
  reason: CompensationReason.ExecutionFailed,
  status,
  startedAt: "2026-10-20T12:00:00.000Z",
  endedAt: "2026-10-20T12:00:01.000Z",
});

/** `entry` closed by an undo that ended `status`. */
export const closedOf = (
  entry: CompensationEntry,
  status = CompensationStatus.Compensated,
): CompensationEntry => ({
  ...entry,
  status: CompensationEntryStatus.Closed,
  undo: undoOf(entry, status),
});
