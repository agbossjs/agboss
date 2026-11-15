/**
 * #1104 AC3: `channel` of a pause is also a column an older writer does not fill (0.1.0's INSERT
 * names no `channel`). A pause such a process writes while this build runs is found by a
 * channel-filtered page at once, and is filled in at the next open.
 */
import { describe, expect, it } from "vitest";
import { PauseStatus } from "../../../src/index.js";
import { SqlitePausedExecutionRepository } from "../../../src/infrastructure/sqlite/sqlite-paused-execution.repository.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";
import { oldPauseJson } from "./pause-names-0.1.0.fixtures.js";

const clock = new VirtualClock(new Date(0));
const CHANNEL = "refund-approval-channel";

/** What an older process does: an INSERT that names no `channel`, no deadline, no reminder. */
const oldWriterInserts = (connection: ReturnType<typeof connectionTo>, id: string): void => {
  connection.database
    .prepare(
      "INSERT INTO pauses (tenant_id, pause_id, step_key, root_execution_id, status, is_sent, pause) VALUES ('default', ?, ?, 'run-1', 'pending', 1, ?)",
    )
    .run(id, `run-1:s:1:${id}`, oldPauseJson);
};

const idsOf = async (
  pauses: SqlitePausedExecutionRepository,
  channel: string,
): Promise<readonly string[]> =>
  (
    await pauses.findPageByTenantId("default", { statuses: [PauseStatus.Pending], channel }, 10)
  ).pauses.map((pause) => pause.pauseId);

describe("#1104 AC3: a pause written without channel is in the channel-filtered pages", () => {
  it("AC3: an older writer's pause, written after this build opened the file, is found at once", async () => {
    const path = temporarySqlitePath();
    const connection = connectionTo(path);
    const pauses = new SqlitePausedExecutionRepository(connection, clock);
    oldWriterInserts(connection, "late");

    expect(await idsOf(pauses, CHANNEL)).toEqual(["late"]);
    expect(await idsOf(pauses, "another-channel")).toEqual([]);
  });

  it("AC3: the next open fills the column in, and a second open changes nothing", () => {
    const path = temporarySqlitePath();
    const first = connectionTo(path);
    new SqlitePausedExecutionRepository(first, clock);
    oldWriterInserts(first, "late");

    const second = connectionTo(path);
    new SqlitePausedExecutionRepository(second, clock);

    expect(
      second.database.prepare("SELECT channel FROM pauses WHERE pause_id = 'late'").get(),
    ).toEqual({
      channel: CHANNEL,
    });
  });
});
