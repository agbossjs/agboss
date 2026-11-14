/**
 * #942 AC1, AC3 on SQLite, three instances on one file: the reminder is told once to each receiver
 * whichever instance looks first, and an extension on one instance moves the deadline for all.
 */
import { beforeEach, expect } from "vitest";
import { SqlitePausedExecutionRepository } from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { hours, minutes, seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { until } from "../channels/fixtures/pause-scripts.js";
import { SqliteExtensionApplication } from "../infrastructure/sqlite/fixtures/pause-extension.application.js";
import { sqliteFilePerTest } from "../infrastructure/sqlite/fixtures/sqlite.workflow.js";
import { managerFlow, resetTold, span, told } from "../flow/fixtures/pause-extension.fixture.js";

sqliteFilePerTest();

const test = testWith(SqliteExtensionApplication, { instances: 3 });
const ORDER = { orderId: "o-1" };
const THREAD = { threadId: "remind-sqlite" };
const manager = { answeredBy: "manager-17" };

beforeEach(resetTold);

const instance = (apps: readonly TestApp[], index: number): TestApp => {
  const found = apps[index];
  if (found === undefined) throw new Error(`no instance ${String(index)}`);
  return found;
};

const expiring = () => told.notices.filter((one) => one.kind === "expiring");

test("AC3: three instances on one file: one reminder for each receiver, after an extension one more", async ({
  apps,
  clock,
}) => {
  for (const app of apps) await app.ready();
  await execute(instance(apps, 0), managerFlow.start, ORDER, THREAD);
  const pauseId = told.sent[0]?.pauseId ?? "";

  await clock.advance(span(hours(22), seconds(10)));
  await until(() => expiring().length === 2);
  await clock.advance(minutes(10));
  expect(
    expiring()
      .map((one) => one.receiver)
      .sort(),
  ).toEqual(["channel", "listener"]);

  const extension = await instance(apps, 2).extendPause({ pauseId, expiresIn: hours(24) }, manager);
  const seenByOther = await instance(apps, 1)
    .resolve(SqlitePausedExecutionRepository)
    .findByTenantIdAndPauseId("default", pauseId);
  expect(seenByOther?.expiresAt).toBe(extension.expiresAt);
  await clock.advance(span(hours(22), minutes(1)));
  await until(() => expiring().length === 4);
  await clock.advance(hours(1));

  expect(expiring()).toHaveLength(4);
  expect(new Set(expiring().map((one) => one.deliveryId)).size).toBe(4);
  expect(
    expiring()
      .slice(2)
      .map((one) => one.expiresAt),
  ).toEqual([extension.expiresAt, extension.expiresAt]);
  const extended = told.notices.filter((one) => one.kind === "extended");
  expect(extended.map((one) => one.receiver).sort()).toEqual(["channel", "listener"]);
});
