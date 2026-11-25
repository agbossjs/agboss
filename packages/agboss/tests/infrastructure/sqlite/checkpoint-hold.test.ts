/**
 * Bug hunt 2026-11-25, finding 1 (#1317): the checkpoint saver's `put` awaits the serde before
 * its transaction. A `runOnce` hold that opens in that gap must not fail it: the write waits for
 * the hold and runs once it ends.
 */
import { describe, expect, it } from "vitest";
import { emptyCheckpoint } from "@langchain/langgraph";
import { SqliteCheckpointSaver } from "../../../src/infrastructure/sqlite/sqlite-checkpoint-saver.js";
import { connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";

const turns = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("hunt: checkpoint saver vs an open hold", () => {
  it("put whose serde await straddles a hold's start waits for the hold, then writes", async () => {
    const connection = connectionTo(temporarySqlitePath());
    const saver = new SqliteCheckpointSaver(connection);
    const config = { configurable: { thread_id: "t1", checkpoint_ns: "", tenant_id: "default" } };
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const checkpoint = emptyCheckpoint();
    // put passes the gate synchronously and awaits the serde
    const putting = saver.put(config, checkpoint, { source: "input", step: -1, parents: {} });
    // a runOnce-like hold opens meanwhile
    const holding = connection.held(async () => {
      await gate;
      return 1;
    });
    let outcome: string | undefined;
    const settled = putting.then(
      () => (outcome = "ok"),
      (error: unknown) => (outcome = String(error)),
    );
    await turns();
    expect(outcome).toBeUndefined();
    release();
    await holding;
    await settled;
    expect(outcome).toBe("ok");
    expect((await saver.getTuple(config))?.checkpoint.id).toBe(checkpoint.id);
  });
});
