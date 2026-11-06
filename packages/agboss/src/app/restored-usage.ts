import type { CheckpointTuple } from "@langchain/langgraph";
import { withLedgerMarkRead } from "../finops/ledger-mark.js";

/**
 * A state's usage as it was kept (#817): a checkpoint keeps it as JSON, so a usage record's ledger
 * mark comes back with its date as ISO text — and one kept before 0.1.1 with the fields of before.
 * Every read of a checkpoint through the application's checkpointer gives the records back with
 * their mark as this version keeps it (`withLedgerMarkRead`): a `Date`, one field. A mark this
 * version does not read fails the read — a state is never continued with spend it cannot place.
 */

/** The channel every flow and agent-loop state keeps its usage records in. */
const USAGE = "usage";

const isRecord = (value: unknown): value is object => typeof value === "object" && value !== null;

/** An array of usage records with their marks read; anything else as it is. */
const usageRead = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map((record: unknown) => (isRecord(record) ? withLedgerMarkRead(record) : record))
    : value;

/** `tuple` with the usage of its state, and of its pending writes to the usage channel, read. */
export function withUsageRead(tuple: CheckpointTuple): CheckpointTuple {
  const values = tuple.checkpoint.channel_values;
  const writes = tuple.pendingWrites;
  return {
    ...tuple,
    checkpoint: {
      ...tuple.checkpoint,
      channel_values: USAGE in values ? { ...values, [USAGE]: usageRead(values[USAGE]) } : values,
    },
    ...(writes === undefined
      ? {}
      : {
          pendingWrites: writes.map(([task, channel, value]) =>
            channel === USAGE ? [task, channel, usageRead(value)] : [task, channel, value],
          ),
        }),
  };
}

/** `tuple` read, when there is one. */
export const withUsageReadOf = (tuple: CheckpointTuple | undefined): CheckpointTuple | undefined =>
  tuple === undefined ? undefined : withUsageRead(tuple);
