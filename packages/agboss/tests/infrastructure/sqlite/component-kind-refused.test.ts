/**
 * #1324 (P7): a stored component whose `kind` is a 0.1.0 spelling (`"question"`, `"reply-interpreter"`)
 * or missing is refused with `StoreError.UnreadableRecord` — never read as an approval, an interpreter
 * or an agent. At the reader, and on a pause row a SQLite file holds.
 */
import { describe, expect, it } from "vitest";
import { StoreError } from "../../../src/core/error-families/store-errors.js";
import { StoredComponent, readStored } from "../../../src/infrastructure/stored-step.js";
import { SqlitePausedExecutionRepository } from "../../../src/infrastructure/sqlite/sqlite-paused-execution.repository.js";
import { PAUSES_SCHEMA } from "../../../src/infrastructure/sqlite/sqlite-pause-schema.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";
import { pauseJson } from "./stored-rows.fixtures.js";

const OLD: readonly (string | undefined)[] = ["question", "reply-interpreter", undefined];

describe("the reader of a stored component", () => {
  it.each(OLD)("refuses kind %s", (kind) => {
    const read = () => readStored(StoredComponent, { name: "x", kind }, "component", ["name"]);
    expect(read).toThrow(StoreError.UnreadableRecord);
    expect(read).toThrow(/kind/);
  });

  it.each(["external-task", "channel-interpreter", "agent"])("reads kind %s", (kind) => {
    expect(readStored(StoredComponent, { name: "x", kind }, "component", ["name"]).kind).toBe(kind);
  });
});

describe("a pause row in a SQLite file", () => {
  const pausesWith = (component: unknown): SqlitePausedExecutionRepository => {
    const path = temporarySqlitePath();
    const connection = connectionTo(path);
    connection.database.exec(PAUSES_SCHEMA);
    const pause = JSON.stringify({
      ...JSON.parse(pauseJson),
      trail: [{ action: "opened", at: "2026-01-05T09:00:00.000Z", target: "refund-tool-approval" }],
      component,
    });
    connection.database
      .prepare(
        "INSERT INTO pauses (tenant_id, pause_id, step_key, root_execution_id, status, is_sent, pause, answer, resolution, resolved_at) VALUES ('default', 'p1', 'run-1:s:1', 'run-1', 'pending', 0, ?, NULL, NULL, NULL)",
      )
      .run(pause);
    return new SqlitePausedExecutionRepository(connectionTo(path), new VirtualClock(new Date(0)));
  };

  it.each(OLD)("is refused on get when its component kind is %s", async (kind) => {
    const pauses = pausesWith({ name: "clerk-agent", kind });
    const read = pauses.findByTenantIdAndPauseId("default", "p1");
    await expect(read).rejects.toBeInstanceOf(StoreError.UnreadableRecord);
    await expect(read).rejects.toThrow(/component\.kind/);
  });

  it("is read when its component kind is the new string", async () => {
    const pauses = pausesWith({ name: "approver-external-task", kind: "external-task" });
    const found = await pauses.findByTenantIdAndPauseId("default", "p1");
    expect(found?.component?.kind).toBe("external-task");
  });
});
