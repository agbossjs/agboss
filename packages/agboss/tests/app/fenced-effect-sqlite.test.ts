/**
 * #500 AC1, AC2 on SQLite — the order charged through `SqliteFencedEffectRepository` on one file
 * shared by two instances (each its own connection): a crash before the checkpoint charges once,
 * and a zombie that reaches its effect before the new holder wrote is refused — its row never
 * written. A unit runner gives the SQLite store its held lease too.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ExecutionFencedError,
  ExecutionLeaseLostError,
  FencedEffectStatus,
} from "../../src/index.js";
import { testAction, testWith } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import {
  ends,
  resetRecovery,
  seen as recovery,
} from "../infrastructure/fixtures/recovery.workflow.js";
import { sqliteFilePerTest } from "../infrastructure/sqlite/fixtures/sqlite.workflow.js";
import {
  chargesIn,
  SqliteChargeOrderAction,
  SqliteChargeWorkflowStart,
  SqliteFencedEffectApplication,
} from "../infrastructure/sqlite/fixtures/sqlite-fenced-effect.workflow.js";
import { instance, rejectionOf, settle } from "./fixtures/fence-takeover.js";
import {
  book,
  frozenRuns,
  gates,
  letAllGo,
  resetFencedEffect,
} from "./fixtures/fenced-effect.workflow.js";

const file = sqliteFilePerTest();
const two = testWith(SqliteFencedEffectApplication, { instances: 2 });

beforeEach(() => {
  resetFencedEffect();
  resetRecovery();
});

afterEach(() => {
  letAllGo();
});

/** The charge rows of the test's file, read on a connection of its own. */
function charges(): readonly string[] {
  const database = new DatabaseSync(file.path);
  try {
    return chargesIn(database);
  } finally {
    database.close();
  }
}

describe("#500 AC1, AC2: the fenced effect on one SQLite file, two instances", () => {
  two(
    "AC1: a crash before the checkpoint charges once on the file and the replay gets the first receipt",
    async ({ apps, clock, leases }) => {
      gates.after = 1;
      const [a, b] = [instance(apps, 0), instance(apps, 1)];
      await a.ready();
      await b.ready();
      const call = execute(a, SqliteChargeWorkflowStart, { text: "order-7" });
      call.catch(() => undefined);
      await frozenRuns(1);
      leases.stall(a);
      await clock.advance(seconds(31));
      await clock.advance(seconds(31));
      const [end] = await ends(1);

      expect(end?.output).toEqual({ chargeId: "charge-order-7-1" });
      expect(charges()).toEqual(["charge-order-7-1"]);
      expect(book.runs).toEqual([
        { token: 1, status: FencedEffectStatus.Ran },
        { token: 2, status: FencedEffectStatus.Replayed },
      ]);

      letAllGo();
      leases.resume(a);
      await settle();
      expect(await rejectionOf(call)).toBeInstanceOf(ExecutionLeaseLostError);
      expect(charges()).toHaveLength(1);
    },
  );

  two(
    "AC2: the zombie arriving before the new holder writes is refused: nothing on the file, no receipt",
    async ({ apps, clock, leases }) => {
      gates.before = 2;
      const [a, b] = [instance(apps, 0), instance(apps, 1)];
      await a.ready();
      await b.ready();
      const call = execute(a, SqliteChargeWorkflowStart, { text: "order-7" });
      call.catch(() => undefined);
      await frozenRuns(1);
      leases.stall(a);
      await clock.advance(seconds(31));
      await clock.advance(seconds(31));
      await frozenRuns(2);
      const [zombie, holder] = gates.frozen.splice(0);

      zombie?.();
      await settle();
      leases.resume(a);
      const error = await rejectionOf(call);
      const afterZombie = charges();
      holder?.();
      const [end] = await ends(1);

      expect(error).toBeInstanceOf(ExecutionFencedError);
      expect(error).toMatchObject({ token: 1, observedToken: 2 });
      expect(afterZombie).toEqual([]);
      expect(charges()).toEqual(["charge-order-7-2"]);
      expect(end?.output).toEqual({ chargeId: "charge-order-7-2" });
      expect(recovery.errors).toEqual([]);
    },
  );
});

describe("#500: a unit runner's SQLite fenced effect", () => {
  const order = { message: { value: { text: "order-1" } } } as never;
  // the SQLite stores read sqlitePath only; the fixtures' generated Environment is another shape
  const onFile = { environment: { sqlitePath: ":memory:" } as never };

  it("runs on the runner's held lease, then replays the receipt on the same step", async () => {
    const run = testAction(SqliteChargeOrderAction, onFile);

    const first = await run(order);
    const second = await run(order);

    expect(first.output).toEqual({ chargeId: "charge-order-1-1" });
    expect(second.output).toEqual(first.output);
    expect(book.runs.map((each) => each.status)).toEqual([
      FencedEffectStatus.Ran,
      FencedEffectStatus.Replayed,
    ]);
  });

  it("runs under the fence option's token; a lost lease is refused", async () => {
    const third = await testAction(SqliteChargeOrderAction, { ...onFile, fence: { token: 3 } })(
      order,
    );
    const lost = testAction(SqliteChargeOrderAction, { ...onFile, fence: { isLost: true } })(order);

    expect(third.output).toEqual({ chargeId: "charge-order-1-3" });
    await expect(lost).rejects.toBeInstanceOf(ExecutionFencedError);
  });
});
