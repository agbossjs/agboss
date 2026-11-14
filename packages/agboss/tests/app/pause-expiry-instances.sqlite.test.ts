/**
 * #941 AC3 on SQLite, instances on one file: three instances look at the same tick — one takes the
 * tree's lease, the channel's expiry decision is asked once and one decision is recorded; a holder
 * that dies after the handler and before the compare-and-set lets another run the handler again,
 * still one decision (I5); a holder that dies after it marked the root `running` or after the
 * expiry was recorded leaves a root recovery continues — never a `paused` root with a closed pause
 * (I4). (The processes killed for real: the fault suite's scenarios 22 and 22b.)
 */
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import {
  ApplicationContext,
  SqliteExecutionRecordRepository,
  SqlitePausedExecutionRepository,
} from "../../src/index.js";
import { PauseResolution, PauseStatus } from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { hours, seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { until } from "../channels/fixtures/pause-scripts.js";
import { ExpiryWorkflowStart, expiry, resetExpiry } from "../flow/fixtures/expiry.fixture.js";
import { levers, resetRecovery } from "../infrastructure/fixtures/recovery.workflow.js";
import { SqliteExpiryApplication } from "../infrastructure/sqlite/fixtures/pause-expiry.application.js";
import { sqliteFilePerTest } from "../infrastructure/sqlite/fixtures/sqlite.workflow.js";

sqliteFilePerTest();

const test = testWith(SqliteExpiryApplication, { instances: 3 });
const THREAD = { threadId: "expiry-sqlite" };

beforeEach(() => {
  resetExpiry();
  resetRecovery();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const instance = (apps: readonly TestApp[], index: number): TestApp => {
  const found = apps[index];
  if (found === undefined) throw new Error(`the test runs no instance ${String(index)}`);
  return found;
};

const storeOf = (app: TestApp): SqlitePausedExecutionRepository =>
  app.resolve(SqlitePausedExecutionRepository);

const killed = (app: TestApp): void => {
  levers.dead.add(app.resolve(ApplicationContext).instanceId);
};

/** The tree's pauses, as the file keeps them. */
const pausesOf = (app: TestApp, rootExecutionId: string) =>
  storeOf(app).findAllByTenantIdAndRootExecutionId("default", rootExecutionId);

describe("#941 AC3: instances expiring one pause: one decision", () => {
  test("AC3: three instances look at the same tick: the handler is asked once, one decision is recorded", async ({
    apps,
    clock,
  }) => {
    for (const app of apps) await app.ready();
    const paused = await execute(
      instance(apps, 0),
      ExpiryWorkflowStart,
      { orderId: "o-1" },
      THREAD,
    );

    await clock.advance(hours(24));
    await until(() => expiry.directorAsked.length === 1);
    await clock.advance(seconds(10));

    expect(expiry.asked).toHaveLength(1);
    expect(expiry.directorAsked).toHaveLength(1);
    const pauses = await pausesOf(instance(apps, 1), paused.executionId);
    expect(pauses.filter((pause) => pause.resolution === PauseResolution.Expired)).toHaveLength(1);
  });

  test("AC3: the holder dies after the handler, before the compare-and-set: another runs the handler again, one decision is recorded", async ({
    apps,
    clock,
  }) => {
    for (const app of apps) await app.ready();
    const paused = await execute(
      instance(apps, 0),
      ExpiryWorkflowStart,
      { orderId: "o-1" },
      THREAD,
    );
    // only instance 1 looks first; its expiry's record never happens: its process is gone
    for (const index of [0, 2])
      vi.spyOn(storeOf(instance(apps, index)), "findPendingByExpiresAtBefore").mockResolvedValue(
        [],
      );
    vi.spyOn(storeOf(instance(apps, 1)), "expireByTenantIdAndPauseId").mockImplementationOnce(
      () => {
        killed(instance(apps, 1));
        return Promise.reject(new Error("the process died"));
      },
    );

    // its process is gone and its lease released: the root stays `running`, recovery continues it
    await clock.advance(hours(24));

    await until(() => expiry.directorAsked.length === 1);
    expect(expiry.asked).toHaveLength(2);
    const pauses = await pausesOf(instance(apps, 0), paused.executionId);
    expect(pauses.map((pause) => [pause.status, pause.resolution])).toEqual([
      [PauseStatus.Cancelled, PauseResolution.Expired],
      [PauseStatus.Pending, undefined],
    ]);
  });

  test("I4: dead between the root's mark and the record of the expiry: the root is `running`, the pause still pending — recovery's to continue", async ({
    apps,
    clock,
  }) => {
    for (const app of apps) await app.ready();
    const paused = await execute(
      instance(apps, 0),
      ExpiryWorkflowStart,
      { orderId: "o-1" },
      THREAD,
    );
    const seen: { root?: string; pause?: string } = {};
    for (const index of [0, 2]) {
      const store = storeOf(instance(apps, index));
      vi.spyOn(store, "findPendingByExpiresAtBefore").mockResolvedValue([]);
    }
    const store = storeOf(instance(apps, 1));
    const record = instance(apps, 1).resolve(SqliteExecutionRecordRepository);
    vi.spyOn(store, "expireByTenantIdAndPauseId").mockImplementationOnce(async () => {
      seen.root = (await record.findByTenantIdAndRunId("default", paused.executionId))?.status;
      seen.pause = (await pausesOf(instance(apps, 1), paused.executionId))[0]?.status;
      killed(instance(apps, 1));
      throw new Error("the process died");
    });

    await clock.advance(hours(24));
    await until(() => expiry.directorAsked.length === 1);

    expect(seen).toEqual({ root: "running", pause: PauseStatus.Pending });
  });

  test("I4: dead right after the expiry was recorded: the root is `running` with the closed pause; recovery continues with it — the handler asked once, the director once", async ({
    apps,
    clock,
  }) => {
    for (const app of apps) await app.ready();
    const paused = await execute(
      instance(apps, 0),
      ExpiryWorkflowStart,
      { orderId: "o-1" },
      THREAD,
    );
    for (const index of [0, 2]) {
      const store = storeOf(instance(apps, index));
      vi.spyOn(store, "findPendingByExpiresAtBefore").mockResolvedValue([]);
    }
    const store = storeOf(instance(apps, 1));
    const record = instance(apps, 1).resolve(SqliteExecutionRecordRepository);
    const seen: { root?: string; pause?: string } = {};
    const reads = store.findAllByTenantIdAndRootExecutionId.bind(store);
    let calls = 0;
    vi.spyOn(store, "findAllByTenantIdAndRootExecutionId").mockImplementation(async (...args) => {
      calls += 1;
      // the first read finds the due pause; the one after the record is where the process dies
      if (calls !== 2) return reads(...args);
      seen.root = (await record.findByTenantIdAndRunId("default", paused.executionId))?.status;
      seen.pause = (await reads(...args))[0]?.resolution;
      killed(instance(apps, 1));
      throw new Error("the process died");
    });

    await clock.advance(hours(24));
    await until(() => expiry.directorAsked.length === 1);

    expect(seen).toEqual({ root: "running", pause: PauseResolution.Expired });
    expect(expiry.asked).toHaveLength(1);
    expect(expiry.directorAsked).toHaveLength(1);
  });
});
