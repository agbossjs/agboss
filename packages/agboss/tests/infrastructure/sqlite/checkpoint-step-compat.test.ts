/**
 * #1035: the newest-by-step read of a SQLite file is not a column an older version cannot fill. A
 * file written by the published `@agboss/core@0.1.0`, opened by this version, is written again by
 * 0.1.0 (its 9-value INSERT) and read in order; a populated 0.1.0 file migrates; a file a build
 * with a stored `step` column opened is converted.
 */
import { emptyCheckpoint, type CheckpointTuple } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { newestFirstOrder, stepOf } from "../../../src/infrastructure/latest-by-step.js";
import { SqliteCheckpointSaver } from "../../../src/infrastructure/sqlite/sqlite-checkpoint-saver.js";
import { connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";
import { installPublished010, oldPuts, type OldPut } from "./published-0.1.0.js";

installPublished010();

const at = (threadId: string, namespace = ""): { configurable: Record<string, string> } => ({
  configurable: { thread_id: threadId, checkpoint_ns: namespace },
});
const loop = (step: number): Record<string, unknown> => ({ source: "loop", step, parents: {} });

/** The answer the scan gives: every checkpoint of the thread, newest by step then id. */
async function scanLatest(saver: SqliteCheckpointSaver, threadId: string): Promise<string> {
  const tuples: CheckpointTuple[] = [];
  for await (const tuple of saver.list(at(threadId))) tuples.push(tuple);
  const ranked = tuples.map((tuple) => ({ id: tuple.checkpoint.id, step: stepOf(tuple.metadata) }));
  return ranked.sort(newestFirstOrder)[0]?.id ?? "";
}

describe("#1035 AC1: a file written by 0.1.0 and opened by this version", () => {
  it("AC1: 0.1.0 writes again after the open, and its checkpoint is the newest by step", async () => {
    const path = temporarySqlitePath();
    await oldPuts(path, [
      { id: "id-1", metadata: loop(1) },
      { id: "id-2", metadata: loop(2) },
    ]);
    const saver = new SqliteCheckpointSaver(connectionTo(path));
    expect((await saver.latestByStep(at("t")))?.checkpoint.id).toBe("id-2");
    await saver.put(at("t"), { ...emptyCheckpoint(), id: "id-3" }, loop(3));

    // 0.1.0 still on the file: the lowest id, the greatest step; and one without a step
    await oldPuts(path, [
      { id: "id-0", metadata: loop(9) },
      { id: "id-9", metadata: { source: "loop", parents: {} } },
    ]);

    expect((await saver.latestByStep(at("t")))?.checkpoint.id).toBe("id-0");
    expect(await scanLatest(saver, "t")).toBe("id-0");
    // 0.1.1 reads what 0.1.0 wrote; the greatest id is the step-less one
    expect((await saver.getTuple(at("t")))?.checkpoint.id).toBe("id-9");
    expect(
      (await new SqliteCheckpointSaver(connectionTo(path)).latestByStep(at("t")))?.checkpoint.id,
    ).toBe("id-0");
  });

  it("AC1: a populated 0.1.0 file migrates on open; every namespace answers as the scan does", async () => {
    const path = temporarySqlitePath();
    const puts: OldPut[] = [];
    for (let index = 0; index < 300; index += 1) {
      const id = `id-${String(300 - index).padStart(4, "0")}`; // ids fall while steps rise
      const metadata = index % 50 === 7 ? { source: "loop", parents: {} } : loop(index % 100);
      puts.push({ threadId: index % 2 === 0 ? "even" : "odd", id, metadata });
    }
    await oldPuts(path, puts);
    const connection = connectionTo(path);

    const saver = new SqliteCheckpointSaver(connection);
    new SqliteCheckpointSaver(connectionTo(path)); // a second open changes nothing

    for (const thread of ["even", "odd"])
      expect((await saver.latestByStep(at(thread)))?.checkpoint.id).toBe(
        await scanLatest(saver, thread),
      );
    expect((await saver.latestByStep(at("even")))?.checkpoint.id).not.toBe(
      (await saver.getTuple(at("even")))?.checkpoint.id,
    );
    const plan = connection.database
      .prepare(
        "EXPLAIN QUERY PLAN SELECT checkpoint_id FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ? ORDER BY step DESC, checkpoint_id DESC LIMIT 1",
      )
      .all("even", "")
      .map((row) => String(row.detail))
      .join(" | ");
    expect(plan).toMatch(/USING (COVERING )?INDEX checkpoints_latest_by_step/);
    expect(plan).not.toContain("TEMP B-TREE");
  });

  it("AC1: a file a build with a stored step column opened is converted, and 0.1.0 writes to it", async () => {
    const path = temporarySqlitePath();
    await oldPuts(path, [{ id: "id-1", metadata: loop(1) }]);
    const stored = connectionTo(path);
    stored.database.exec(`ALTER TABLE checkpoints ADD COLUMN step INTEGER;
      UPDATE checkpoints SET step = 1;
      CREATE INDEX checkpoints_latest_by_step ON checkpoints (thread_id, checkpoint_ns, step DESC, checkpoint_id DESC);
      CREATE INDEX checkpoints_without_step ON checkpoints (thread_id, checkpoint_ns) WHERE step IS NULL`);

    const saver = new SqliteCheckpointSaver(stored);
    await oldPuts(path, [{ id: "id-0", metadata: loop(5) }]);

    expect((await saver.latestByStep(at("t")))?.checkpoint.id).toBe("id-0");
    const names = stored.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'checkpoints'")
      .all()
      .map((row) => String(row.name));
    expect(names).not.toContain("checkpoints_without_step");
    expect(names).toContain("checkpoints_latest_by_step");
  });
});
