/**
 * #1307 (G3, Q-A, P6a): every time a pause shows a caller, a channel or a listener is a `Date`; the
 * record and the store contract still keep ISO 8601 texts, and the one boundary between them compares by
 * instant. A compare-and-set, a ceiling or a due check written with `===` on two `Date`s would lose every
 * time (`UpdateContended` for good) or win when it must not: these tests fail on such code.
 */
import { beforeEach, describe, expect } from "vitest";
import { PauseClosedReason, PauseError, PauseStatus } from "../../src/index.js";
import { PausedExecutionRepository } from "../../src/infrastructure/paused-execution.repository.js";
import { pauseKeyOf } from "../../src/infrastructure/pause-record.js";
import { testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { hours, minutes, seconds } from "../../src/units/index.js";
import { until } from "../channels/fixtures/pause-scripts.js";
import {
  ExtensionApplication,
  managerFlow,
  resetTold,
  told,
} from "../flow/fixtures/pause-extension.fixture.js";
import { execute } from "../helpers/flow.js";

const test = testWith(ExtensionApplication);
const ORDER = { orderId: "o-1" };
const THREAD = { threadId: "dates-1" };
const manager = { actor: { id: "manager-17" } };

beforeEach(resetTold);

const pauseIdOf = (): string => told.sent[0]?.pauseId ?? "";

const recordOf = async (app: TestApp) => {
  const found = await app
    .resolve(PausedExecutionRepository)
    .findByTenantIdAndPauseId("default", pauseIdOf());
  if (found === undefined) throw new Error("the pause is gone");
  return found;
};

describe("P6a: what a caller sees of a pause is a Date", () => {
  test("result.pending[] holds Dates of the record's instants, trail included", async ({
    app,
    clock,
  }) => {
    const paused = await execute(app, managerFlow.start, ORDER, THREAD);
    const record = await recordOf(app);

    // `toMatchObject` equals a Date by its instant, and never equals a text
    expect(paused.pending[0]).toMatchObject({
      expiresAt: new Date(record.expiresAt ?? ""),
      trail: [{ action: "opened", at: clock.now(), expiresAt: new Date(record.expiresAt ?? "") }],
    });
  });

  test("listPauses holds Dates of the record's instants, trail included, and no closedAt while open", async ({
    app,
    clock,
  }) => {
    await execute(app, managerFlow.start, ORDER, THREAD);
    const record = await recordOf(app);

    const page = await app.listPauses({ tenantId: "default" });

    expect(page.items[0]).toMatchObject({
      askedAt: clock.now(),
      expiresAt: new Date(record.expiresAt ?? ""),
      trail: [{ action: "opened", at: clock.now() }],
    });
    expect(page.items[0]).not.toHaveProperty("closedAt");
  });

  test("a closed pause lists its closedAt as a Date", async ({ app, clock }) => {
    await execute(app, managerFlow.start, ORDER, THREAD);
    await clock.advance(minutes(5));
    const answeredAt = clock.now();
    await app.resume({ pauseId: pauseIdOf(), decision: { approved: true } }, manager);

    const page = await app.listPauses({
      tenantId: "default",
      status: [PauseStatus.Resolved, PauseStatus.Taken],
    });
    const [listed] = page.items;
    expect(listed?.closedAt).toBeInstanceOf(Date);
    expect(listed?.closedAt?.getTime()).toBe(answeredAt.getTime());
  });

  test("PauseError.Closed.closedAt is a Date; the error's details and message carry the ISO text", async ({
    app,
    clock,
  }) => {
    await execute(app, managerFlow.start, ORDER, THREAD);
    await clock.advance(minutes(5));
    const answeredAt = clock.now();
    await app.resume({ pauseId: pauseIdOf(), decision: { approved: true } }, manager);
    await clock.advance(minutes(1));

    const error = await app
      .resume({ pauseId: pauseIdOf(), decision: { approved: true } }, manager)
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );

    expect(error).toBeInstanceOf(PauseError.Closed);
    if (!(error instanceof PauseError.Closed)) throw new Error("not a PauseError.Closed");
    expect(error.closedAt).toBeInstanceOf(Date);
    expect(error.closedAt?.getTime()).toBe(answeredAt.getTime());
    expect(error.reason).toBe(PauseClosedReason.Answered);
    expect(error.details).toMatchObject({ closedAt: answeredAt.toISOString() });
    expect(error.message).toBe(
      `pause ${pauseKeyOf("default", pauseIdOf())} is closed: answered at ${answeredAt.toISOString()}`,
    );
  });

  test("the answer log of the record holds Dates", async ({ app, clock }) => {
    await execute(app, managerFlow.start, ORDER, THREAD);
    const askedAt = clock.now();
    await clock.advance(minutes(10));
    const answeredAt = clock.now();

    const done = await app.resume(
      { pauseId: pauseIdOf(), decision: { approved: true } },
      { ...manager, includeRecord: true },
    );

    const [answer] = done.record?.pauses ?? [];
    expect(answer).toMatchObject({
      askedAt,
      resolvedAt: answeredAt,
      trail: [{ action: "opened", at: askedAt, expiresAt: expect.any(Date) }],
    });
    // the stored JSON is the ISO texts as before: a record read back is the same
    const roundTrip: unknown = JSON.parse(JSON.stringify(answer));
    expect(roundTrip).toMatchObject({
      askedAt: askedAt.toISOString(),
      resolvedAt: answeredAt.toISOString(),
    });
  });
});

describe("P6a: compare-and-set and ceilings by instant", () => {
  test("two changes in a row each win the compare-and-set over a deadline the store hands back as a new Date", async ({
    app,
    clock,
  }) => {
    await execute(app, managerFlow.start, ORDER, THREAD);
    await clock.advance(hours(1));

    const first = await app.setPauseTimeout({ pauseId: pauseIdOf(), timeout: hours(12) }, manager);
    await clock.advance(minutes(10));
    const second = await app.setPauseTimeout({ pauseId: pauseIdOf(), timeout: hours(6) }, manager);

    // the second read what the first wrote: the same instant, a different object
    expect(second.previousExpiresAt).not.toBe(first.expiresAt);
    expect(second.previousExpiresAt?.getTime()).toBe(first.expiresAt?.getTime());
    expect(second.expiresAt?.getTime()).toBe(clock.now().getTime() + hours(6));
    expect((await recordOf(app)).expiresAt).toEqual(second.expiresAt);
  });

  test("the receivers of a change are told Dates: previousExpiresAt the deadline it had, expiresAt the one it has", async ({
    app,
    clock,
  }) => {
    const paused = await execute(app, managerFlow.start, ORDER, THREAD);
    const had = paused.pending[0]?.expiresAt;
    await clock.advance(hours(1));

    const changed = await app.setPauseTimeout(
      { pauseId: pauseIdOf(), timeout: hours(24) },
      manager,
    );
    await until(() => told.raw.length === 2);
    await clock.advance(seconds(30));

    expect(told.raw).toHaveLength(2);
    for (const event of told.raw) {
      expect(event).toMatchObject({
        expiresAt: changed.expiresAt,
        previousExpiresAt: had,
      });
      expect(Reflect.get(event, "expiresAt")).toBeInstanceOf(Date);
      expect(Reflect.get(event, "previousExpiresAt")).toBeInstanceOf(Date);
    }
  });

  test("a deadline shortened to the very instant the clock shows is refused, one a millisecond later is taken", async ({
    app,
    clock,
  }) => {
    await execute(app, managerFlow.start, ORDER, THREAD);
    await clock.advance(minutes(1));

    await expect(
      app.setPauseTimeout({ pauseId: pauseIdOf(), timeout: hours(2) }, manager),
    ).resolves.toMatchObject({
      expiresAt: new Date(clock.now().getTime() + hours(2)),
    });
    const record = await recordOf(app);
    expect(record.expiresAt).toEqual(new Date(clock.now().getTime() + hours(2)));
    // the reminder two hours before a two-hour deadline is not after the change: none
    expect(record.remindAt).toBeUndefined();
  });
});
