/**
 * #1114 and #1115 on SQLite: a serde that keeps the metadata type `json` and changes the bytes
 * (compressed, enveloped, encrypted) is read by the serde, never ordered by a step of -2 and the
 * greatest id; and every path breaks a tie of steps by code point, as the contract says.
 */
import { gunzipSync, gzipSync } from "node:zlib";
import {
  emptyCheckpoint,
  type CheckpointMetadata,
  type CheckpointTuple,
} from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { newestFirstOrder, stepOf } from "../../../src/infrastructure/latest-by-step.js";
import { SqliteCheckpointSaver } from "../../../src/infrastructure/sqlite/sqlite-checkpoint-saver.js";
import { connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";

const at = { configurable: { thread_id: "t", checkpoint_ns: "" } };
const loop = (step: number): CheckpointMetadata => ({ source: "loop", step, parents: {} });
const put = (saver: SqliteCheckpointSaver, id: string, metadata: unknown): Promise<unknown> =>
  saver.put(at, { ...emptyCheckpoint(), id }, metadata as CheckpointMetadata);
const connections = new WeakMap<SqliteCheckpointSaver, ReturnType<typeof connectionTo>>();
function openSaver(path: string): SqliteCheckpointSaver {
  const connection = connectionTo(path);
  const saver = new SqliteCheckpointSaver(connection);
  connections.set(saver, connection);
  return saver;
}
const newSaver = (): SqliteCheckpointSaver => openSaver(temporarySqlitePath());
function databaseOf(saver: SqliteCheckpointSaver): ReturnType<typeof connectionTo>["database"] {
  const connection = connections.get(saver);
  if (connection === undefined) throw new Error("a saver this test did not open");
  return connection.database;
}

type Serde = SqliteCheckpointSaver["serde"];

/** Keeps the type `json` of the default serde and changes the bytes by `wrap` / `unwrap`. */
function bytesSerde(
  saver: SqliteCheckpointSaver,
  wrap: (bytes: Uint8Array) => Uint8Array,
  unwrap: (bytes: Uint8Array) => Uint8Array,
  type = (inner: string): string => inner,
): Serde {
  const inner = saver.serde;
  return {
    dumpsTyped: async (value) => {
      const [innerType, bytes] = await inner.dumpsTyped(value);
      return [type(innerType), innerType === "json" ? wrap(bytes) : bytes];
    },
    loadsTyped: (storedType, bytes) =>
      inner.loadsTyped(
        storedType === "json" || storedType === "" || storedType === "json+x" ? "json" : storedType,
        storedType === "json" || storedType === "" || storedType === "json+x"
          ? unwrap(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes)
          : bytes,
      ),
  };
}

const gzipped = (saver: SqliteCheckpointSaver): Serde =>
  bytesSerde(
    saver,
    (bytes) => gzipSync(bytes),
    (bytes) => gunzipSync(bytes),
  );
const enveloped = (saver: SqliteCheckpointSaver): Serde =>
  bytesSerde(
    saver,
    (bytes) =>
      new TextEncoder().encode(JSON.stringify({ v: 1, data: new TextDecoder().decode(bytes) })),
    (bytes) =>
      new TextEncoder().encode(
        (JSON.parse(new TextDecoder().decode(bytes)) as { data: string }).data,
      ),
  );

/** What the scan answers: `list()` ranked by `stepOf` and `newestFirstOrder`. */
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

describe("#1114 AC1: a serde that keeps the type json and changes the bytes", () => {
  for (const [name, make] of [
    ["gzip", gzipped],
    ["a JSON envelope", enveloped],
  ] as const)
    it(`AC1: ${name}: steps 1 and 9 with falling ids: latestByStep is the scan's answer, not the greatest id`, async () => {
      const saver = newSaver();
      saver.serde = make(saver);
      await put(saver, "b", loop(1));
      await put(saver, "a", loop(9));

      expect(await scanned(saver)).toBe("a");
      expect((await saver.latestByStep(at))?.checkpoint.id).toBe("a");
      expect((await saver.latestByStep(at))?.metadata?.step).toBe(9);
    });

  it("AC1: the stored type really is json, and SQL reads -2 (the premise of the defect)", async () => {
    const saver = newSaver();
    saver.serde = gzipped(saver);
    await put(saver, "b", loop(1));
    const row = databaseOf(saver).prepare("SELECT metadata_type, step FROM checkpoints").get();
    expect(row).toMatchObject({ metadata_type: "json", step: -2 });
  });

  it("AC1: rows written plain, then by the wrapping serde: the newest by step is found across both", async () => {
    const saver = newSaver();
    await put(saver, "c", loop(5));
    expect((await saver.latestByStep(at))?.checkpoint.id).toBe("c");
    const plain = saver.serde;
    const wrapping = gzipped(saver);
    saver.serde = {
      dumpsTyped: (value) => wrapping.dumpsTyped(value),
      // reads both kinds of row, as a serde in a migration would
      loadsTyped: async (type, bytes): Promise<unknown> => {
        try {
          return await wrapping.loadsTyped(type, bytes);
        } catch {
          return await plain.loadsTyped(type, bytes);
        }
      },
    };
    await put(saver, "b", loop(1));
    await put(saver, "a", loop(2));
    expect(await scanned(saver)).toBe("c");
    expect((await saver.latestByStep(at))?.checkpoint.id).toBe("c");
    await put(saver, "0", loop(7));
    expect((await saver.latestByStep(at))?.checkpoint.id).toBe("0");
  });

  it("AC1: a row with no step at all is read by the serde too, and still ranks -2", async () => {
    const saver = newSaver();
    await put(saver, "m", { source: "loop", parents: {} });
    await put(saver, "n", loop(-1));
    expect((await saver.latestByStep(at))?.checkpoint.id).toBe("n");
    expect(await scanned(saver)).toBe("n");
  });

  it("AC1: a namespace with only readable steps stays on the one-walk index: the probe is empty", async () => {
    const saver = newSaver();
    await put(saver, "x", loop(1));
    await put(saver, "y", loop(2));
    const database = databaseOf(saver);
    const plan = database
      .prepare(
        "EXPLAIN QUERY PLAN SELECT 1 FROM checkpoints INDEXED BY checkpoints_unreadable_step WHERE thread_id = ? AND checkpoint_ns = ? AND step = -2 LIMIT 1",
      )
      .all("t", "");
    expect(JSON.stringify(plan)).toContain("checkpoints_unreadable_step");
    expect(database.prepare("SELECT count(*) AS n FROM checkpoints WHERE step = -2").get()).toEqual(
      { n: 0 },
    );
    expect((await saver.latestByStep(at))?.checkpoint.id).toBe("y");
  });

  it("AC1: a file a #1101 build opened loses its foreign-metadata index and gets the new one", () => {
    const path = temporarySqlitePath();
    const first = openSaver(path);
    databaseOf(first).exec(
      "DROP INDEX checkpoints_unreadable_step; CREATE INDEX checkpoints_foreign_metadata ON checkpoints (thread_id, checkpoint_ns) WHERE metadata_type <> 'json'",
    );
    const reopened = openSaver(path);
    const names = databaseOf(reopened)
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'checkpoints_%' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    expect(names).toContain("checkpoints_unreadable_step");
    expect(names).not.toContain("checkpoints_foreign_metadata");
  });
});

describe("#1115 AC1: every SQLite path breaks a tie of steps by code point", () => {
  const astral = "\u{10000}";
  const high = "￿";

  it("AC1: the indexed path (type json): U+10000 beats U+FFFF, as the scan says", async () => {
    const saver = newSaver();
    await put(saver, high, loop(3));
    await put(saver, astral, loop(3));
    expect((await saver.latestByStep(at))?.checkpoint.id).toBe(astral);
    expect(await scanned(saver)).toBe(astral);
  });

  it("AC1: the serde path (gzip bytes): U+10000 beats U+FFFF, and a mixed set is ranked by code point", async () => {
    const saver = newSaver();
    saver.serde = gzipped(saver);
    for (const id of ["z", "", high, "\u{1F600}", astral]) await put(saver, id, loop(3));
    expect((await saver.latestByStep(at))?.checkpoint.id).toBe("\u{1F600}");
    expect(await scanned(saver)).toBe("\u{1F600}");
  });

  it("AC1: the serde path breaks equal steps by the greatest id, not the least or the first read", async () => {
    const saver = newSaver();
    saver.serde = gzipped(saver);
    for (const id of ["m", "b", "Z", "x", "a"]) await put(saver, id, loop(3));
    await put(saver, "zz", loop(2));
    expect((await saver.latestByStep(at))?.checkpoint.id).toBe("x");
  });
});

describe("#1114: a metadata type of the empty string is read by the serde", () => {
  it("rows typed '' (bytes gzipped) answer the scan's answer", async () => {
    const saver = newSaver();
    saver.serde = bytesSerde(
      saver,
      (bytes) => gzipSync(bytes),
      (bytes) => gunzipSync(bytes),
      (inner) => (inner === "json" ? "" : inner),
    );
    await put(saver, "b", loop(1));
    await put(saver, "a", loop(9));
    expect(
      databaseOf(saver).prepare("SELECT DISTINCT metadata_type AS t FROM checkpoints").all(),
    ).toEqual([{ t: "" }]);
    expect((await saver.latestByStep(at))?.checkpoint.id).toBe("a");
  });
});
