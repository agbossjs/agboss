/**
 * #1101 and the guarantees #1035 left unpinned: the `step` the newest-by-step read orders by is
 * read for every metadata type the saver can write (a serde that names its type anything but
 * `json` is read by the serde, never ordered by id); the column stays REAL (a step of 2^53 and above
 * is read as the double it was written as); a step that is not a number is -2, a missing one is -2 and not -1.
 */
import {
  emptyCheckpoint,
  type CheckpointMetadata,
  type CheckpointTuple,
} from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { SqliteCheckpointSaver } from "../../../src/infrastructure/sqlite/sqlite-checkpoint-saver.js";
import { connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";
const at = { configurable: { thread_id: "t", checkpoint_ns: "" } };
const loop = (step: number): CheckpointMetadata => ({ source: "loop", step, parents: {} });
const put = (saver: SqliteCheckpointSaver, id: string, metadata: unknown): Promise<unknown> =>
  saver.put(at, { ...emptyCheckpoint(), id }, metadata as CheckpointMetadata);

/** The saver's default serde, naming its metadata type `json+enc` (same bytes), as an encrypting one would. */
function renamingSerde(saver: SqliteCheckpointSaver): SqliteCheckpointSaver["serde"] {
  const inner = saver.serde;
  return {
    dumpsTyped: async (value) => {
      const [type, bytes] = await inner.dumpsTyped(value);
      return [type === "json" ? "json+enc" : type, bytes];
    },
    loadsTyped: (type, bytes) => inner.loadsTyped(type === "json+enc" ? "json" : type, bytes),
  };
}

const steps = (connection: ReturnType<typeof connectionTo>): number[] =>
  connection.database
    .prepare("SELECT step FROM checkpoints ORDER BY checkpoint_id")
    .all()
    .map((row) => Number(row.step));

describe("#1101 AC1: a serde that names its metadata type something else", () => {
  it("AC1: steps 1 and 9, ids falling: latestByStep is the step-9 checkpoint, as the scan says", async () => {
    const saver = new SqliteCheckpointSaver(connectionTo(temporarySqlitePath()));
    saver.serde = renamingSerde(saver);
    await put(saver, "b", loop(1));
    await put(saver, "a", loop(9));

    const listed: CheckpointTuple[] = [];
    for await (const tuple of saver.list(at)) listed.push(tuple);
    expect(listed.map((tuple) => tuple.metadata?.step).sort()).toEqual([1, 9]);
    expect((await saver.latestByStep(at))?.checkpoint.id).toBe("a");
    expect((await saver.latestByStep(at))?.metadata?.step).toBe(9);
  });

  it("AC1: a thread of json rows then rows of the other type: the newest by step is found across both", async () => {
    const saver = new SqliteCheckpointSaver(connectionTo(temporarySqlitePath()));
    await put(saver, "c", loop(5)); // json
    expect((await saver.latestByStep(at))?.checkpoint.id).toBe("c");
    saver.serde = renamingSerde(saver);
    await put(saver, "b", loop(1));
    await put(saver, "a", loop(2));
    expect((await saver.latestByStep(at))?.checkpoint.id).toBe("c");
    await put(saver, "0", loop(7));
    expect((await saver.latestByStep(at))?.checkpoint.id).toBe("0");
  });

  it("AC1: a step that is no number and a missing one rank as -2 under the other type too", async () => {
    const saver = new SqliteCheckpointSaver(connectionTo(temporarySqlitePath()));
    saver.serde = renamingSerde(saver);
    await put(saver, "m", { source: "loop", parents: {} }); // missing: -2
    await put(saver, "n", loop(-1)); // beats -2
    await put(saver, "z", { source: "loop", step: "7", parents: {} });
    expect((await saver.latestByStep(at))?.checkpoint.id).toBe("n");
  });

  it("AC1: another thread without such rows keeps the indexed read, and an empty one answers undefined", async () => {
    const saver = new SqliteCheckpointSaver(connectionTo(temporarySqlitePath()));
    saver.serde = renamingSerde(saver);
    await put(saver, "x", loop(1));
    expect(await saver.latestByStep({ configurable: { thread_id: "none" } })).toBeUndefined();
  });
});

describe("#1035 guarantees: the generated step column", () => {
  it("the column is REAL: a thread at step 2^53 and beyond is read, the newest is the highest", async () => {
    const path = temporarySqlitePath();
    const saver = new SqliteCheckpointSaver(connectionTo(path));
    await put(saver, "a", loop(2 ** 53));
    await put(saver, "b", loop(2 ** 53));
    await put(saver, "c", loop(2 ** 60));
    expect((await saver.latestByStep(at))?.checkpoint.id).toBe("c");
  });

  it("a step that is no number reads as -2; a missing one is -2, not -1, beside a step of -1", async () => {
    const connection = connectionTo(temporarySqlitePath());
    const saver = new SqliteCheckpointSaver(connection);
    await put(saver, "a", { source: "loop", step: "7", parents: {} });
    await put(saver, "b", { source: "loop", step: true, parents: {} });
    await put(saver, "c", { source: "loop", step: null, parents: {} });
    await put(saver, "d", { source: "loop", parents: {} });
    await put(saver, "e", loop(-1));
    await put(saver, "f", loop(0));
    expect(steps(connection)).toEqual([-2, -2, -2, -2, -1, 0]);
    // a step of -1 outranks the missing one (-2) even though its id is smaller
    const other = connectionTo(temporarySqlitePath());
    const second = new SqliteCheckpointSaver(other);
    await put(second, "z", { source: "loop", parents: {} });
    await put(second, "a", loop(-1));
    expect((await second.latestByStep(at))?.checkpoint.id).toBe("a");
  });

  it("every read names its columns: no statement the saver prepares is a SELECT *", async () => {
    const connection = connectionTo(temporarySqlitePath());
    const prepared: string[] = [];
    const { database } = connection;
    const original = database.prepare.bind(database);
    database.prepare = (sql: string) => {
      prepared.push(sql);
      return original(sql);
    };
    const saver = new SqliteCheckpointSaver(connection);
    await put(saver, "a", loop(2 ** 53));
    await saver.getTuple(at);
    await saver.latestByStep(at);
    for await (const tuple of saver.list(at)) expect(tuple.metadata?.step).toBe(2 ** 53);
    expect(prepared.filter((sql) => /select\s+\*/i.test(sql))).toEqual([]);
    expect(prepared.some((sql) => sql.includes("checkpoints"))).toBe(true);
  });
});
