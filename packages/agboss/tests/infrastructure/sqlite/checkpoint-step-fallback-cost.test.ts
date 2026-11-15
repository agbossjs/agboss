/**
 * #1144: a namespace with a few rows whose SQL `step` reads -2 is read in O(rows at -2): the rows
 * with a readable step come from the index, only the -2 rows' metadata goes through the serde, and
 * no `checkpoint` blob is read but the winner's. The answer stays the scan's.
 */
import { gunzipSync, gzipSync } from "node:zlib";
import {
  emptyCheckpoint,
  type CheckpointMetadata,
  type CheckpointTuple,
} from "@langchain/langgraph";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newestFirstOrder, stepOf } from "../../../src/infrastructure/latest-by-step.js";
import { SqliteCheckpointSaver } from "../../../src/infrastructure/sqlite/sqlite-checkpoint-saver.js";
import { connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";

const at = { configurable: { thread_id: "t", checkpoint_ns: "" } };
const loop = (step: number): CheckpointMetadata => ({ source: "loop", step, parents: {} });
const stepless: unknown = { source: "update", parents: {} };

afterEach(() => vi.restoreAllMocks());

function open() {
  const connection = connectionTo(temporarySqlitePath());
  const saver = new SqliteCheckpointSaver(connection);
  const put = (id: string, metadata: unknown) =>
    saver.put(at, { ...emptyCheckpoint(), id }, metadata as CheckpointMetadata);
  return { saver, connection, put };
}

/** What a read costs: the serde's loads, and the rows the statements return (and whether they carry a blob). */
function measure(
  saver: SqliteCheckpointSaver,
  connection: ReturnType<typeof connectionTo>,
): { serdeLoads: () => number; rows: () => number; checkpointBlobs: () => number } {
  let serdeLoads = 0;
  let rows = 0;
  let checkpointBlobs = 0;
  const inner = saver.serde;
  saver.serde = {
    dumpsTyped: (value) => inner.dumpsTyped(value),
    loadsTyped: (type, bytes) => {
      serdeLoads += 1;
      return inner.loadsTyped(type, bytes);
    },
  };
  const prepare = connection.database.prepare.bind(connection.database);
  vi.spyOn(connection.database, "prepare").mockImplementation((sql: string) => {
    const statement = prepare(sql);
    const count = (found: unknown): void => {
      for (const row of Array.isArray(found) ? found : found === undefined ? [] : [found]) {
        rows += 1;
        if (typeof row === "object" && row !== null && "checkpoint" in row) checkpointBlobs += 1;
      }
    };
    return new Proxy(statement, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target);
        if (property !== "all" && property !== "get") return value;
        return (...args: unknown[]) => {
          const found: unknown = (value as (...a: unknown[]) => unknown).apply(target, args);
          count(found);
          return found;
        };
      },
    });
  });
  return { serdeLoads: () => serdeLoads, rows: () => rows, checkpointBlobs: () => checkpointBlobs };
}

async function scanned(saver: SqliteCheckpointSaver): Promise<string | undefined> {
  const tuples: CheckpointTuple[] = [];
  for await (const tuple of saver.list(at)) tuples.push(tuple);
  return tuples.sort((a, b) =>
    newestFirstOrder(
      { step: stepOf(a.metadata), id: a.checkpoint.id },
      { step: stepOf(b.metadata), id: b.checkpoint.id },
    ),
  )[0]?.checkpoint.id;
}

const ids = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `c-${String(index).padStart(4, "0")}`);

describe("#1144 AC1: the fallback reads O(rows at -2), not the namespace", () => {
  it("60 readable rows and one step-less row: the answer is the scan's, the cost is the one row's", async () => {
    const { saver, connection, put } = open();
    for (const [index, id] of ids(60).entries()) await put(id, loop(index));
    await put("z-stepless", stepless);
    const expected = await scanned(saver);
    expect(expected).toBe("c-0059");

    const cost = measure(saver, connection);
    expect((await saver.latestByStep(at))?.checkpoint.id).toBe(expected);
    // the step-less row's metadata, then the winner's checkpoint and metadata
    expect(cost.serdeLoads()).toBeLessThanOrEqual(3);
    expect(cost.rows()).toBeLessThanOrEqual(6);
  });

  it("the step-less row wins over rows with steps below it: found among the -2 rows", async () => {
    const { saver, connection, put } = open();
    for (const [index, id] of ids(30).entries()) await put(id, loop(-10 - index));
    await put("a-minus-two", { source: "loop", step: -2, parents: {} });
    await put("b-stepless", stepless);
    const expected = await scanned(saver);
    expect(expected).toBe("b-stepless");

    const cost = measure(saver, connection);
    expect((await saver.latestByStep(at))?.checkpoint.id).toBe(expected);
    expect(cost.serdeLoads()).toBeLessThanOrEqual(2 + 2);
    expect(cost.checkpointBlobs()).toBe(1);
  });

  it("code-point ties among the -2 rows and the index's rows are broken as the scan breaks them", async () => {
    const { saver, put } = open();
    await put("", loop(-2.5)); // below the -2 rows by step, so never the answer
    await put("\u{10000}", stepless);
    await put("￿", stepless); // both at -2: the astral id is greater by code point
    expect((await saver.latestByStep(at))?.checkpoint.id).toBe(await scanned(saver));
    expect((await saver.latestByStep(at))?.checkpoint.id).toBe("\u{10000}");
  });
});

describe("#1144 AC2: the fallback holds no checkpoint blob but the winner's", () => {
  it("all rows at -2 (a wrapping serde): every metadata is read, one checkpoint is", async () => {
    const { saver, connection, put } = open();
    const inner = saver.serde;
    saver.serde = {
      dumpsTyped: async (value) => {
        const [type, bytes] = await inner.dumpsTyped(value);
        return [type, type === "json" ? gzipSync(bytes) : bytes];
      },
      loadsTyped: (type, bytes) =>
        inner.loadsTyped(type, type === "json" ? gunzipSync(bytes as Uint8Array) : bytes),
    };
    for (const [index, id] of ids(25).entries()) await put(id, loop(index));
    const expected = await scanned(saver);
    expect(expected).toBe("c-0024");

    let namespaceRowsWithBlobs = 0;
    const prepare = connection.database.prepare.bind(connection.database);
    vi.spyOn(connection.database, "prepare").mockImplementation((sql: string) => {
      const statement = prepare(sql);
      return new Proxy(statement, {
        get(target, property) {
          const value: unknown = Reflect.get(target, property, target);
          if (property !== "all") return value;
          return (...args: unknown[]) => {
            const found = (value as (...a: unknown[]) => unknown[]).apply(target, args);
            namespaceRowsWithBlobs += found.filter(
              (row) => typeof row === "object" && row !== null && "checkpoint" in row,
            ).length;
            return found;
          };
        },
      });
    });
    expect((await saver.latestByStep(at))?.checkpoint.id).toBe(expected);
    expect(namespaceRowsWithBlobs).toBe(0);
  });
});
