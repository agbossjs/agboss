/**
 * #942 AC3: two hours before the deadline the channel and the listeners hear "expiring at …", once,
 * even with several instances; after an extension, again before the new deadline. No reminder for
 * a pause without a deadline, one the step gave less time than `remindBefore`, or one answered first;
 * a pause bound by its run's deadline is reminded before that deadline.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { remindAtOf } from "../../src/flow/runtime/pause-record-made.js";
import { PauseStatus } from "../../src/index.js";
import { PausedExecutionRepository } from "../../src/infrastructure/paused-execution.repository.js";
import { testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { hours, minutes, seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { until } from "../channels/fixtures/pause-scripts.js";
import {
  ExtensionApplication,
  managerFlow,
  resetTold,
  told,
  span,
} from "../flow/fixtures/pause-extension.fixture.js";

/** A deadline as the record keeps it: ISO 8601 (`""`: none). */
const isoOf = (at: Date | undefined): string => at?.toISOString() ?? "";

const memory = testWith(ExtensionApplication, { instances: 3 });
const ORDER = { orderId: "o-1" };
const THREAD = { threadId: "remind-1" };
const manager = { actor: { id: "manager-17" } };

beforeEach(resetTold);

const first = (apps: readonly TestApp[]): TestApp => {
  const [found] = apps;
  if (found === undefined) throw new Error("no instance");
  return found;
};

const expiring = () => told.notices.filter((one) => one.kind === "expiring");
const pauseIdOf = (): string => told.sent[0]?.pauseId ?? "";
const pauseOf = (app: TestApp) =>
  app.resolve(PausedExecutionRepository).findByTenantIdAndPauseId("default", pauseIdOf());

describe("#942 AC3: the reminder", () => {
  memory(
    "AC3: once at remindAt on 3 instances; again after an extension",
    async ({ apps, clock }) => {
      for (const app of apps) await app.ready();
      const paused = await execute(first(apps), managerFlow.start, ORDER, THREAD);
      const askedAt = clock.now().getTime();
      const firstDeadline = isoOf(paused.pending[0]?.expiresAt);
      expect((await pauseOf(first(apps)))?.remindAt).toBe(
        new Date(askedAt + hours(22)).toISOString(),
      );

      await clock.advance(hours(21));
      expect(expiring()).toEqual([]);
      await clock.advance(span(hours(1), seconds(10)));
      await until(() => expiring().length === 2);
      await clock.advance(minutes(10));

      // the channel and the listener, once each — whichever instance looked first
      expect(
        expiring()
          .map((one) => one.receiver)
          .sort(),
      ).toEqual(["channel", "listener"]);
      for (const one of expiring()) expect(one.expiresAt).toBe(firstDeadline);
      expect((await pauseOf(first(apps)))?.remindAt).toBeUndefined();

      // extended after the reminder: a new deadline, a new reminder before it
      const extension = await first(apps).setPauseTimeout(
        { pauseId: pauseIdOf(), timeout: hours(24) },
        manager,
      );
      expect((await pauseOf(first(apps)))?.remindAt).toBe(
        new Date(Number(extension.expiresAt) - hours(2)).toISOString(),
      );
      await clock.advance(hours(21));
      expect(expiring()).toHaveLength(2);
      await clock.advance(span(hours(1), minutes(5)));
      await until(() => expiring().length === 4);
      await clock.advance(minutes(10));

      const again = expiring().slice(2);
      expect(again.map((one) => one.receiver).sort()).toEqual(["channel", "listener"]);
      for (const one of again) expect(one.expiresAt).toBe(extension.expiresAt?.toISOString());
      expect(new Set(expiring().map((one) => one.deliveryId)).size).toBe(4);
    },
  );

  memory(
    "AC3: extended before the reminder: the reminder moves with the deadline",
    async ({ app, clock }) => {
      await execute(app, managerFlow.start, ORDER, THREAD);
      await clock.advance(hours(1));
      const extension = await app.setPauseTimeout(
        { pauseId: pauseIdOf(), timeout: hours(24) },
        manager,
      );

      await clock.advance(span(hours(21), minutes(30)));
      expect(expiring()).toEqual([]);
      await clock.advance(hours(1));
      await until(() => expiring().length === 2);

      for (const one of expiring()) expect(one.expiresAt).toBe(extension.expiresAt?.toISOString());
    },
  );

  memory(
    "AC3: reminder of a run-deadline-bound pause: before the run's deadline",
    async ({ app, clock }) => {
      const paused = await execute(app, managerFlow.start, ORDER, {
        ...THREAD,
        deadline: hours(10),
      });
      const runDeadline = paused.pending[0]?.expiresAt ?? new Date(Number.NaN);
      expect((await pauseOf(app))?.remindAt).toBe(
        new Date(runDeadline.getTime() - hours(2)).toISOString(),
      );

      await clock.advance(span(hours(8), seconds(10)));
      await until(() => expiring().length === 2);

      for (const one of expiring()) expect(one.expiresAt).toBe(runDeadline.toISOString());
    },
  );

  memory("AC3: a pause answered before its reminder is never reminded", async ({ app, clock }) => {
    await execute(app, managerFlow.start, ORDER, THREAD);
    await clock.advance(hours(21));
    await app.resume({ pauseId: pauseIdOf(), decision: { approved: true } }, manager);

    await clock.advance(hours(4));

    expect(expiring()).toEqual([]);
  });
});

describe("#942: edges of the reminder's time", () => {
  it("remindAtOf: a reminder exactly at the ask is none, one millisecond after it is set; none without a deadline or a lead", () => {
    const asked = new Date("2026-01-01T00:00:00.000Z");
    const deadline = "2026-01-01T02:00:00.000Z";

    expect(remindAtOf(deadline, hours(2), asked)).toBeUndefined();
    expect(remindAtOf(deadline, hours(2) - 1, asked)).toBe("2026-01-01T00:00:00.001Z");
    expect(remindAtOf(deadline, hours(3), asked)).toBeUndefined();
    expect(remindAtOf(deadline, undefined, asked)).toBeUndefined();
    expect(remindAtOf(undefined, hours(1), asked)).toBeUndefined();
  });

  memory(
    "a reminder first looked for once the deadline passed is never told: expiring after expired is not a notice",
    async ({ app, clock }) => {
      await execute(app, managerFlow.start, ORDER, THREAD);
      const store = app.resolve(PausedExecutionRepository);
      const blind = vi.spyOn(store, "findPendingByRemindAtBefore").mockResolvedValue([]);
      const past = vi.spyOn(store, "findPendingByExpiresAtBefore").mockResolvedValue([]);
      await clock.advance(span(hours(24), seconds(10)));
      past.mockRestore();
      blind.mockRestore();

      await clock.advance(seconds(30));
      await until(async () => (await pauseOf(app))?.status !== PauseStatus.Pending);

      expect(expiring()).toEqual([]);
    },
  );
});
