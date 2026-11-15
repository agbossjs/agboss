/**
 * #1090 follow-up — a leased store call that never answers before the run's first checkpoint: the
 * run wrote nothing, so there is nothing for the next holder to continue (recovery would fail it
 * with `NothingToRecoverError`). The caller is told the truth — the store's own error, the run
 * failed and did not start — not that the tree was handed over and will be continued.
 */
import { afterEach, beforeEach, describe, expect } from "vitest";
import {
  ExecutionLeaseLostError,
  SqliteConnection,
  StoreCallTimeoutError,
} from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { processHoldPoints } from "../../src/testing/faults/hold-points.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { passLive } from "../helpers/live-time.js";
import { logged } from "../helpers/log.js";
import { resetRecovery } from "../infrastructure/fixtures/recovery.workflow.js";
import {
  chargesIn,
  SqliteChargeWorkflowStart,
} from "../infrastructure/sqlite/fixtures/sqlite-fenced-effect.workflow.js";
import { sqliteFilePerTest } from "../infrastructure/sqlite/fixtures/sqlite.workflow.js";
import { WritesWindowSqliteApplication } from "../infrastructure/sqlite/fixtures/writes-window-sqlite.application.js";
import { book, ChargeWorkflowStart, resetFencedEffect } from "./fixtures/fenced-effect.workflow.js";
import { instance, rejectionOf } from "./fixtures/fence-takeover.js";
import { rootOf } from "./fixtures/lease-scope-bound.helpers.js";
import {
  resetWindow,
  window,
  WritesWindowMemoryApplication,
} from "./fixtures/writes-window.application.js";

sqliteFilePerTest();
const memory = testWith(WritesWindowMemoryApplication, { instances: 2 });
const sqlite = testWith(WritesWindowSqliteApplication, { instances: 2 });

beforeEach(() => {
  resetWindow();
  resetFencedEffect();
  resetRecovery();
  logged.length = 0;
});

afterEach(() => {
  resetWindow();
  processHoldPoints.releaseAll();
});

describe("#1090 follow-up: a read that never answers before the first checkpoint", () => {
  const expectations = (error: unknown, status: string): void => {
    // the caller is not promised a continuation that recovery cannot give
    expect(error).toBeInstanceOf(ExecutionLeaseLostError);
    expect((error as ExecutionLeaseLostError).code).toBe("execution.lease-lost.not-started");
    expect((error as ExecutionLeaseLostError).message).toContain("the run did not start");
    expect((error as ExecutionLeaseLostError).cause).toBeInstanceOf(StoreCallTimeoutError);
    expect(status).toBe("failed");
  };

  memory(
    "the caller is told the run did not start; the next take ends the record failed (in memory)",
    async ({ apps, clock }) => {
      const [a, b] = [instance(apps, 0), instance(apps, 1)];
      await a.ready();
      await b.ready();
      window.hangGet = 1;

      const failure = rejectionOf(
        execute(a, ChargeWorkflowStart, { text: "order-1090" }, { threadId: "t-1" }),
      );
      await passLive(clock, seconds(40));
      const error = await failure;
      await passLive(clock, seconds(60));

      expectations(error, (await rootOf(b)).status);
      expect(book.charges).toEqual([]);
    },
  );

  sqlite(
    "the caller is told the run did not start; the next take ends the record failed (SQLite)",
    async ({ apps, clock }) => {
      const [a, b] = [instance(apps, 0), instance(apps, 1)];
      await a.ready();
      await b.ready();
      window.hangGet = 1;

      const failure = rejectionOf(
        execute(a, SqliteChargeWorkflowStart, { text: "order-1090" }, { threadId: "t-1" }),
      );
      await passLive(clock, seconds(40));
      const error = await failure;
      await passLive(clock, seconds(60));

      expectations(error, (await rootOf(b)).status);
      expect(chargesIn(b.resolve(SqliteConnection).database)).toEqual([]);
    },
  );
});
