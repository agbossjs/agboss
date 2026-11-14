/**
 * #962 AC1: a file written before `checkpoints.step` is migrated on open — the column, the
 * indexes, its old rows backfilled from their metadata — and a row an older version still writes
 * without a step is read in order too.
 */
import { emptyCheckpoint } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { SqliteCheckpointSaver } from "../../../src/infrastructure/sqlite/sqlite-checkpoint-saver.js";
import { connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";

const at = { configurable: { thread_id: "t", checkpoint_ns: "" } };

/** A file as the version before wrote it: the saver's rows, then its step column and indexes dropped. */
async function oldFile(): Promise<string> {
  const path = temporarySqlitePath();
  const connection = connectionTo(path);
  const saver = new SqliteCheckpointSaver(connection);
  for (let step = 0; step < 300; step += 1)
    await saver.put(
      at,
      { ...emptyCheckpoint(), id: `id-${String(step).padStart(4, "0")}` },
      step === 7
        ? JSON.parse('{"source":"loop","parents":{}}')
        : { source: "loop", step: step % 100, parents: {} },
    );
  const { database } = connection;
  database.exec("DROP INDEX checkpoints_latest_by_step; DROP INDEX checkpoints_without_step");
  database.exec("ALTER TABLE checkpoints DROP COLUMN step");
  connection.onDestroy();
  return path;
}

describe("#962 AC1: the step column migrates a populated file", () => {
  it("AC1: old rows are backfilled from their metadata (missing: -2) and read newest by step", async () => {
    const connection = connectionTo(await oldFile());
    expect(connection.columnsOf("checkpoints")).not.toContain("step");

    const saver = new SqliteCheckpointSaver(connection);

    expect(connection.columnsOf("checkpoints")).toContain("step");
    const rows = connection.database
      .prepare("SELECT checkpoint_id, step FROM checkpoints ORDER BY checkpoint_id")
      .all();
    expect(rows).toHaveLength(300);
    expect(rows[7]).toMatchObject({ step: -2 });
    expect(rows[8]).toMatchObject({ step: 8 });
    expect(rows[250]).toMatchObject({ step: 50 });
    // steps run 0..99 three times: the greatest step 99, the greatest id of them
    expect((await saver.latestByStep(at))?.checkpoint.id).toBe("id-0299");
  });

  it("AC1: opening the migrated file again changes nothing; an old writer's row without a step is read in order", async () => {
    const path = await oldFile();
    const first = new SqliteCheckpointSaver(connectionTo(path));
    const connection = connectionTo(path);
    const saver = new SqliteCheckpointSaver(connection);
    expect((await saver.latestByStep(at))?.checkpoint.id).toBe("id-0299");

    // an older version still on the file writes a newer checkpoint without a step
    connection.database.exec(
      "INSERT INTO checkpoints SELECT thread_id, checkpoint_ns, 'id-9999', parent_checkpoint_id, checkpoint_type, checkpoint, metadata_type, metadata, tenant_id, NULL FROM checkpoints WHERE checkpoint_id = 'id-0099'",
    );

    // its metadata step is 99 (a tie with id-0099, id-0199, id-0299): the greatest id wins
    expect((await first.latestByStep(at))?.config.configurable?.checkpoint_id).toBe("id-9999");
    expect(
      connection.database.prepare("SELECT count(*) AS n FROM checkpoints WHERE step IS NULL").get(),
    ).toMatchObject({ n: 0 });
  });
});
