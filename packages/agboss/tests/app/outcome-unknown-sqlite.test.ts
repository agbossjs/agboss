/**
 * #1017 AC1 on SQLite — the charge's COMMIT is applied and then fails with an I/O error: the store
 * reads it as unknown (it cannot tell whether the commit point passed), the holder hands over
 * without a failed record, and the next holder finds the committed row: one charge.
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { ExecutionLeaseLostError, SqliteConnection, StoreOutcomeSource } from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { passLive } from "../helpers/live-time.js";
import {
  ends,
  resetRecovery,
  seen as recovery,
} from "../infrastructure/fixtures/recovery.workflow.js";
import {
  chargesIn,
  SqliteChargeWorkflowStart,
  SqliteFencedEffectApplication,
} from "../infrastructure/sqlite/fixtures/sqlite-fenced-effect.workflow.js";
import { sqliteFilePerTest } from "../infrastructure/sqlite/fixtures/sqlite.workflow.js";
import { resetFencedEffect } from "./fixtures/fenced-effect.workflow.js";
import { instance, rejectionOf } from "./fixtures/fence-takeover.js";
import { causeOf } from "./fixtures/store-bound-helpers.js";

sqliteFilePerTest();
const two = testWith(SqliteFencedEffectApplication, { instances: 2 });

beforeEach(() => {
  resetFencedEffect();
  resetRecovery();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The COMMIT of the transaction that wrote a charge row is applied, and then reported as an I/O error, once. */
function commitFailsAfterTheCharge(): void {
  const proto = DatabaseSync.prototype;
  const prepare: (this: DatabaseSync, sql: string) => StatementSync = Reflect.get(proto, "prepare");
  const exec: (this: DatabaseSync, sql: string) => void = Reflect.get(proto, "exec");
  const io = Object.assign(new Error("disk I/O error"), {
    ...{ code: "ERR_SQLITE_ERROR", errcode: 1034, errstr: "disk I/O error" },
  });
  let isCharging = false;
  let isFailed = false;
  vi.spyOn(proto, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) {
    isCharging ||= sql.includes("INTO order_charges");
    return prepare.call(this, sql);
  });
  vi.spyOn(proto, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
    exec.call(this, sql);
    if (sql !== "COMMIT" || !isCharging || isFailed) return;
    isFailed = true;
    throw io;
  });
}

describe("#1017 AC1: a charge committed on SQLite and its COMMIT reported failed", () => {
  two(
    "hands over, no failed record; the next holder replays the row — one charge",
    async ({ apps, clock }) => {
      const [a, b] = [instance(apps, 0), instance(apps, 1)];
      await a.ready();
      await b.ready();
      commitFailsAfterTheCharge();

      const error = await rejectionOf(execute(a, SqliteChargeWorkflowStart, { text: "order-17" }));

      expect(error).toBeInstanceOf(ExecutionLeaseLostError);
      expect(causeOf(error)).toMatchObject({
        store: "SqliteConnection",
        operation: "COMMIT",
        source: StoreOutcomeSource.Transport,
      });
      expect(recovery.errors).toEqual([]);
      const rows = (): readonly string[] => chargesIn(b.resolve(SqliteConnection).database);
      expect(rows()).toEqual(["charge-order-17-1"]);

      await passLive(clock, seconds(60));
      const [end] = await ends(1);

      expect(end?.output).toEqual({ chargeId: "charge-order-17-1" });
      expect(rows()).toEqual(["charge-order-17-1"]);
    },
  );
});
