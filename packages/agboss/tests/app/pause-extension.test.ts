/**
 * #942 AC1, AC2, #1307: an operator changes an open pause's deadline (`app.setPauseTimeout`) — the
 * new deadline holds on every instance and the channel and the listener hear "timeout-changed"; a
 * change after the deadline is refused "expired", one past the run's deadline is refused as a
 * limit; the respondent is checked as for an answer; a change and the expiry look at one tick: one wins.
 */
import { LimitError } from "../../src/core/error-families/limit-errors.js";
import { ExecutionError } from "../../src/core/error-families/run-errors.js";
import { beforeEach, describe, expect, vi } from "vitest";
import { MAX_TIMEOUT_ATTEMPTS } from "../../src/app/pause-timeout.js";
import { PauseError, PauseClosedReason, PauseStatus, ValidationError } from "../../src/index.js";
import { pauseKeyOf } from "../../src/infrastructure/pause-record.js";
import { PausedExecutionRepository } from "../../src/infrastructure/paused-execution.repository.js";
import { testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { hours, minutes, seconds, Timeout } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { until } from "../channels/fixtures/pause-scripts.js";
import {
  ExtensionApplication,
  managerFlow,
  openFlow,
  ownerFlow,
  resetTold,
  told,
  span,
} from "../flow/fixtures/pause-extension.fixture.js";

const test = testWith(ExtensionApplication, { instances: 3 });
const ORDER = { orderId: "o-1" };
const THREAD = { threadId: "extend-1" };
const manager = { actor: { id: "manager-17" } };

beforeEach(resetTold);

const instance = (apps: readonly TestApp[], index: number): TestApp => {
  const found = apps[index];
  if (found === undefined) throw new Error(`no instance ${String(index)}`);
  return found;
};

const pauseIdOf = (): string => told.sent[0]?.pauseId ?? "";

const pauseOf = async (app: TestApp, pauseId: string, tenantId = "default") => {
  const found = await app
    .resolve(PausedExecutionRepository)
    .findByTenantIdAndPauseId(tenantId, pauseId);
  if (found === undefined) throw new Error("the pause is gone");
  return found;
};

const failureOf = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => undefined,
    (error: unknown) => error,
  );

describe("#942 AC1: an operator extends an open approval", () => {
  test("AC1: extend: new deadline on the other instance; notices", async ({ apps, clock }) => {
    for (const app of apps) await app.ready();
    const paused = await execute(instance(apps, 0), managerFlow.start, ORDER, THREAD);
    const oldDeadline = paused.pending[0]?.expiresAt?.toISOString() ?? "";
    await clock.advance(hours(1));

    const extension = await instance(apps, 1).setPauseTimeout(
      { pauseId: pauseIdOf(), timeout: hours(24) },
      manager,
    );

    const expected = new Date(clock.now().getTime() + hours(24)).toISOString();
    expect(extension).toEqual({
      expiresAt: new Date(expected),
      previousExpiresAt: new Date(oldDeadline),
    });
    // on every instance: the record says so, and the old deadline passes with the pause open
    expect((await pauseOf(instance(apps, 2), pauseIdOf())).expiresAt).toEqual(new Date(expected));
    await clock.advance(span(hours(23), minutes(30)));
    expect((await pauseOf(instance(apps, 2), pauseIdOf())).status).toBe(PauseStatus.Pending);
    const done = await instance(apps, 2).resume(
      { pauseId: pauseIdOf(), decision: { approved: true } },
      manager,
    );
    expect(done.status).toBe("finished");
    // the channel and the listener heard "extended until …" once, with the old deadline too
    await until(() => told.notices.filter((one) => one.kind === "timeout-changed").length === 2);
    await clock.advance(seconds(30));
    const extended = told.notices.filter((one) => one.kind === "timeout-changed");
    expect(extended.map((one) => one.receiver).sort()).toEqual(["channel", "listener"]);
    for (const one of extended)
      expect(one).toMatchObject({ expiresAt: expected, previousExpiresAt: oldDeadline });
  });

  test("AC1: the pause's remindAt moves with the deadline", async ({ apps, clock }) => {
    await instance(apps, 0).ready();
    await execute(instance(apps, 0), managerFlow.start, ORDER, THREAD);
    await clock.advance(hours(1));

    await instance(apps, 0).setPauseTimeout({ pauseId: pauseIdOf(), timeout: hours(24) }, manager);

    const pause = await pauseOf(instance(apps, 0), pauseIdOf());
    expect(pause.remindAt).toEqual(
      new Date((pause.expiresAt?.getTime() ?? Number.NaN) - hours(2)),
    );
  });

  test("a ThreadOwner pause: the owner extends, another owner is refused, answeredBy is refused", async ({
    app,
    clock,
  }) => {
    const paused = await execute(app, ownerFlow.start, ORDER, { ...THREAD, ownerId: "alice" });
    const pauseId = paused.pending[0]?.pauseId ?? "";
    await clock.advance(hours(1));
    const request = { pauseId, timeout: hours(24) };

    expect(await failureOf(app.setPauseTimeout(request, { ownerId: "bob" }))).toBeInstanceOf(
      ExecutionError.ThreadOwnerMismatch,
    );
    expect(await failureOf(app.setPauseTimeout(request, manager))).toBeInstanceOf(
      PauseError.PermissionDenied,
    );
    const extension = await app.setPauseTimeout(request, { ownerId: "alice" });

    expect(extension.expiresAt).toEqual(new Date(clock.now().getTime() + hours(24)));
  });

  test("a Channel pause needs answeredBy: none, an empty one and ownerId are refused", async ({
    app,
  }) => {
    await execute(app, managerFlow.start, ORDER, THREAD);
    const request = { pauseId: pauseIdOf(), timeout: hours(30) };

    for (const options of [{}, { actor: { id: " " } }, { ownerId: "alice" }])
      expect(await failureOf(app.setPauseTimeout(request, options as never))).toBeInstanceOf(
        PauseError.PermissionDenied,
      );
    expect((await pauseOf(app, pauseIdOf())).status).toBe(PauseStatus.Pending);
  });
});

describe("#942 AC2: refused extensions", () => {
  test("AC2: after the deadline → PauseError.Closed expired (before the look expired the pause, and after)", async ({
    app,
    clock,
  }) => {
    const paused = await execute(app, managerFlow.start, ORDER, THREAD);
    const deadline = paused.pending[0]?.expiresAt ?? "";
    const store = app.resolve(PausedExecutionRepository);
    const spy = vi.spyOn(store, "findPendingByExpiresAtBefore").mockResolvedValue([]);

    await clock.advance(hours(24));
    const early = await failureOf(
      app.setPauseTimeout({ pauseId: pauseIdOf(), timeout: hours(24) }, manager),
    );
    spy.mockRestore();
    await clock.advance(seconds(10));
    await until(async () => (await pauseOf(app, pauseIdOf())).status !== PauseStatus.Pending);
    const late = await failureOf(
      app.setPauseTimeout({ pauseId: pauseIdOf(), timeout: hours(24) }, manager),
    );

    for (const refused of [early, late]) {
      expect(refused).toBeInstanceOf(PauseError.Closed);
      expect(refused).toMatchObject({ reason: PauseClosedReason.Expired, closedAt: deadline });
    }
    expect(told.notices.filter((one) => one.kind === "timeout-changed")).toEqual([]);
  });

  test("AC2: past the run deadline → PauseError.EscalationLimitExceeded; exactly the run deadline is allowed", async ({
    app,
  }) => {
    // the question's own 24 h, bound by a run that ends at hour 30
    const paused = await execute(app, managerFlow.start, ORDER, { ...THREAD, deadline: hours(30) });
    expect(paused.status).toBe("paused");
    const runDeadline = new Date((await pauseOf(app, pauseIdOf())).askedAt.getTime() + hours(30));

    const refused = await failureOf(
      app.setPauseTimeout({ pauseId: pauseIdOf(), timeout: hours(31) }, manager),
    );

    expect(refused).toBeInstanceOf(PauseError.EscalationLimitExceeded);
    expect((await pauseOf(app, pauseIdOf())).expiresAt).not.toEqual(runDeadline);
    const allowed = await app.setPauseTimeout(
      { pauseId: pauseIdOf(), timeout: hours(30) },
      manager,
    );
    expect(allowed.expiresAt).toEqual(runDeadline);
  });

  test("AC2: a shorter deadline is applied: from now, told with the one it replaced", async ({
    app,
    clock,
  }) => {
    const paused = await execute(app, managerFlow.start, ORDER, THREAD);
    const oldDeadline = paused.pending[0]?.expiresAt?.toISOString() ?? "";
    await clock.advance(hours(1));

    const changed = await app.setPauseTimeout({ pauseId: pauseIdOf(), timeout: hours(2) }, manager);

    const expected = new Date(clock.now().getTime() + hours(2));
    expect(changed).toEqual({ expiresAt: expected, previousExpiresAt: new Date(oldDeadline) });
    expect((await pauseOf(app, pauseIdOf())).expiresAt).toEqual(expected);
    // the reminder 2 h before is not after now: none
    expect((await pauseOf(app, pauseIdOf())).remindAt).toBeUndefined();
    await until(() => told.notices.filter((one) => one.kind === "timeout-changed").length === 2);
    for (const one of told.notices.filter((n) => n.kind === "timeout-changed"))
      expect(one).toMatchObject({
        expiresAt: expected.toISOString(),
        previousExpiresAt: oldDeadline,
      });
  });

  test("AC2: the same deadline again is a change too: the chain holds both", async ({ app }) => {
    await execute(app, managerFlow.start, ORDER, THREAD);

    for (const timeout of [hours(1), hours(1)])
      await app.setPauseTimeout({ pauseId: pauseIdOf(), timeout }, manager);

    const trail = (await pauseOf(app, pauseIdOf())).trail;
    expect(trail.filter((entry) => entry.action === "timeout-changed")).toHaveLength(2);
  });

  test("AC2: a timeout that is no duration → PauseError.InvalidTimeout, whatever the pause", async ({
    app,
  }) => {
    await execute(app, managerFlow.start, ORDER, THREAD);

    for (const expiresIn of [0, -5, Infinity, Number.NaN, seconds(0.5), "24h", undefined])
      expect(
        await failureOf(
          app.setPauseTimeout({ pauseId: pauseIdOf(), timeout: expiresIn as never }, manager),
        ),
      ).toBeInstanceOf(PauseError.InvalidTimeout);
  });

  test("AC2: another tenant's pause → PauseError.UnknownPause", async ({ app }) => {
    await execute(app, managerFlow.start, ORDER, { ...THREAD, tenant: { tenantId: "acme" } });
    const request = { pauseId: pauseIdOf(), timeout: hours(30) };

    expect(await failureOf(app.setPauseTimeout(request, manager))).toBeInstanceOf(
      PauseError.UnknownPause,
    );
    expect(
      await failureOf(
        app.setPauseTimeout({ ...request, pauseId: "nope" }, { ...manager, tenantId: "acme" }),
      ),
    ).toBeInstanceOf(PauseError.UnknownPause);
    const extension = await app.setPauseTimeout(request, { ...manager, tenantId: "acme" });
    expect(extension.expiresAt).toBeInstanceOf(Date);
  });

  test("a closed pause (answered) → PauseError.Closed answered", async ({ app }) => {
    await execute(app, managerFlow.start, ORDER, THREAD);
    await app.resume({ pauseId: pauseIdOf(), decision: { approved: true } }, manager);

    const refused = await failureOf(
      app.setPauseTimeout({ pauseId: pauseIdOf(), timeout: hours(30) }, manager),
    );

    expect(refused).toBeInstanceOf(PauseError.Closed);
    expect(refused).toMatchObject({ reason: PauseClosedReason.Answered });
  });
});

describe("#1307: who changed the deadline and why reach the channel and the listener", () => {
  test("actor and reason are on both events; a change without a reason carries none", async ({
    app,
  }) => {
    await execute(app, managerFlow.start, ORDER, THREAD);

    await app.setPauseTimeout(
      { pauseId: pauseIdOf(), timeout: hours(30), reason: "customer escalated" },
      manager,
    );
    await until(() => told.notices.filter((one) => one.kind === "timeout-changed").length === 2);
    const first = told.notices.filter((one) => one.kind === "timeout-changed");
    await app.setPauseTimeout({ pauseId: pauseIdOf(), timeout: hours(31) }, manager);
    await until(() => told.notices.filter((one) => one.kind === "timeout-changed").length === 4);
    const second = told.notices.filter((one) => one.kind === "timeout-changed").slice(2);

    expect(first.map((one) => one.receiver).sort()).toEqual(["channel", "listener"]);
    for (const one of first)
      expect(one).toMatchObject({ actor: { id: "manager-17" }, reason: "customer escalated" });
    for (const one of second) {
      expect(one.actor).toMatchObject({ id: "manager-17" });
      expect(one.reason).toBeUndefined();
    }
  });
});

describe("#1307: Timeout.None takes the deadline away, a timeout sets one again", () => {
  test("no deadline, no reminder: the old deadline passes with the pause open; the channel and the listener are told only the deadline it had", async ({
    app,
    clock,
  }) => {
    const paused = await execute(app, managerFlow.start, ORDER, THREAD);
    const oldDeadline = paused.pending[0]?.expiresAt?.toISOString() ?? "";

    const changed = await app.setPauseTimeout(
      { pauseId: pauseIdOf(), timeout: Timeout.None },
      manager,
    );
    await clock.advance(hours(30));

    expect(changed).toEqual({ previousExpiresAt: new Date(oldDeadline) });
    const pause = await pauseOf(app, pauseIdOf());
    expect(pause.status).toBe(PauseStatus.Pending);
    expect(pause.expiresAt).toBeUndefined();
    expect(pause.remindAt).toBeUndefined();
    await until(() => told.notices.filter((one) => one.kind === "timeout-changed").length === 2);
    for (const one of told.notices.filter((n) => n.kind === "timeout-changed")) {
      expect(one.previousExpiresAt).toEqual(oldDeadline);
      expect(one).not.toHaveProperty("expiresAt", expect.anything());
    }
    expect(told.notices.filter((one) => one.kind === "expiring")).toEqual([]);
  });

  test("a pause without a deadline is set one from now, with its reminder; it was told nothing of an earlier one", async ({
    app,
    clock,
  }) => {
    await execute(app, managerFlow.start, ORDER, THREAD);
    await app.setPauseTimeout({ pauseId: pauseIdOf(), timeout: Timeout.None }, manager);
    await clock.advance(hours(5));

    const set = await app.setPauseTimeout({ pauseId: pauseIdOf(), timeout: hours(10) }, manager);

    const expected = new Date(clock.now().getTime() + hours(10));
    expect(set).toEqual({ expiresAt: expected });
    const pause = await pauseOf(app, pauseIdOf());
    expect(pause.expiresAt).toEqual(expected);
    expect(pause.remindAt).toEqual(new Date(expected.getTime() - hours(2)));
    expect(pause.trail.filter((entry) => entry.action === "timeout-changed")).toHaveLength(2);
  });

  test("a pause bound by its run's deadline cannot lose it: Timeout.None is PauseError.EscalationLimitExceeded", async ({
    app,
  }) => {
    await execute(app, managerFlow.start, ORDER, { ...THREAD, deadline: hours(30) });
    const before = await pauseOf(app, pauseIdOf());

    const refused = await failureOf(
      app.setPauseTimeout({ pauseId: pauseIdOf(), timeout: Timeout.None }, manager),
    );

    expect(refused).toBeInstanceOf(PauseError.EscalationLimitExceeded);
    expect(await pauseOf(app, pauseIdOf())).toEqual(before);
  });
});

describe("#942: the caller's options", () => {
  test("an id of who calls that is no key's text is a ValidationError.DtoInvalid on PauseCallerOptions", async ({
    app,
  }) => {
    await execute(app, managerFlow.start, ORDER, THREAD);
    const request = { pauseId: pauseIdOf(), timeout: hours(30) };

    const refused = await failureOf(app.setPauseTimeout(request, { actor: { id: "bob\uD800" } }));

    expect(refused).toBeInstanceOf(ValidationError.DtoInvalid);
    expect(refused).toMatchObject({ dto: "PauseCallerOptions" });
  });

  test("call options a JS caller passes are not read: nothing runs (the types refuse them)", async ({
    app,
  }) => {
    await execute(app, managerFlow.start, ORDER, THREAD);
    const streamed: unknown[] = [];

    const extension = await app.setPauseTimeout({ pauseId: pauseIdOf(), timeout: hours(30) }, {
      actor: { id: "manager-17" },
      onStream: (event: unknown) => streamed.push(event),
    } as never);

    expect(extension.expiresAt).toBeDefined();
    expect(streamed).toEqual([]);
  });
});

describe("#942: what is refused first", () => {
  test("a closed pause is refused as closed even when the request would be invalid for it (shorter, past the bound)", async ({
    app,
  }) => {
    await execute(app, managerFlow.start, ORDER, THREAD);
    await app.resume({ pauseId: pauseIdOf(), decision: { approved: true } }, manager);

    const refused = await failureOf(
      app.setPauseTimeout({ pauseId: pauseIdOf(), timeout: hours(1) }, manager),
    );

    expect(refused).toBeInstanceOf(PauseError.Closed);
    expect(refused).toMatchObject({ reason: PauseClosedReason.Answered });
  });
});

describe("#942: extend and the expiry look at the same tick: one wins (the store's CAS)", () => {
  test("the deadline passes after the pause was read open: the store refuses the extension, the pause expires once, nothing is told 'extended'", async ({
    app,
    clock,
  }) => {
    await execute(app, managerFlow.start, ORDER, THREAD);
    const store = app.resolve(PausedExecutionRepository);
    const read = await pauseOf(app, pauseIdOf());
    const look = vi.spyOn(store, "findPendingByExpiresAtBefore").mockResolvedValue([]);
    await clock.advance(hours(24));
    // the caller's read is a moment old: it still shows a deadline an hour away
    const stale = { ...read, expiresAt: new Date(clock.now().getTime() + hours(1)) };
    // read twice: where the pause waits (the app's routing), then the extension's own read
    vi.spyOn(store, "findByTenantIdAndPauseId")
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(stale);

    const refused = await failureOf(
      app.setPauseTimeout({ pauseId: pauseIdOf(), timeout: hours(48) }, manager),
    );
    look.mockRestore();
    await clock.advance(seconds(10));
    await until(async () => (await pauseOf(app, pauseIdOf())).status !== PauseStatus.Pending);

    expect(refused).toBeInstanceOf(PauseError.Closed);
    expect(refused).toMatchObject({ reason: PauseClosedReason.Expired });
    expect(told.notices.filter((one) => one.kind === "timeout-changed")).toEqual([]);
    expect((await pauseOf(app, pauseIdOf())).expiresAt).toEqual(read.expiresAt);
  });

  test("the extension lands first: the look at the old deadline finds nothing to expire", async ({
    app,
    clock,
  }) => {
    await execute(app, managerFlow.start, ORDER, THREAD);
    await clock.advance(hours(23));
    await app.setPauseTimeout({ pauseId: pauseIdOf(), timeout: hours(24) }, manager);

    await clock.advance(hours(2));

    expect((await pauseOf(app, pauseIdOf())).status).toBe(PauseStatus.Pending);
    expect(told.other.filter((line) => line.includes("closed"))).toEqual([]);
  });
});

describe("#942: extended to exactly the run's deadline: the tie goes to the run (#941 D8)", () => {
  test("the run fails at that instant with LimitError.Deadline; the channel's expiry decision is not asked, whatever it would decide", async ({
    app,
    clock,
  }) => {
    await execute(app, managerFlow.start, ORDER, { ...THREAD, deadline: hours(30) });
    const runDeadline = new Date(clock.now().getTime() + hours(30));
    await app.setPauseTimeout({ pauseId: pauseIdOf(), timeout: hours(30) }, manager);
    expect((await pauseOf(app, pauseIdOf())).expiresAt).toEqual(runDeadline);

    await clock.advance(hours(30));
    await until(() => told.errors.length === 1);

    expect(told.errors[0]).toBeInstanceOf(LimitError.Deadline);
    expect(told.expiryAsked).toEqual([]);
    expect(told.recorded).toEqual([]);
  });
});

describe("#1099: racing extensions: the store's compare-and-set decides, 'extended' is told by the winner only", () => {
  const extendedNotices = () =>
    told.notices.filter((one) => one.kind === "timeout-changed" && one.receiver === "channel");

  test("AC1: a longer and a shorter change at once, from two instances: both apply, one after the other; every told deadline is the stored chain", async ({
    apps,
    clock,
  }) => {
    await Promise.all(apps.map((one) => one.ready()));
    await execute(instance(apps, 0), managerFlow.start, ORDER, THREAD);
    await clock.advance(hours(1));
    const asked = (await pauseOf(instance(apps, 0), pauseIdOf())).expiresAt;

    const [long, short] = await Promise.all([
      instance(apps, 0).setPauseTimeout({ pauseId: pauseIdOf(), timeout: hours(40) }, manager),
      instance(apps, 1).setPauseTimeout({ pauseId: pauseIdOf(), timeout: hours(26) }, manager),
    ]);

    const stored = (await pauseOf(instance(apps, 2), pauseIdOf())).expiresAt;
    // one went first and the other moved from its deadline: the second one's is stored
    const isLongFirst = short.previousExpiresAt?.toISOString() === long.expiresAt?.toISOString();
    const [first, second] = isLongFirst ? [long, short] : [short, long];
    expect(first.previousExpiresAt?.toISOString()).toEqual(asked?.toISOString());
    expect(second.previousExpiresAt?.toISOString()).toBe(first.expiresAt?.toISOString());
    expect(stored).toEqual(second.expiresAt);
    await until(() => extendedNotices().length === 2);
    const told_ = extendedNotices().map((one) => one.expiresAt);
    expect(told_.at(-1)).toBe(stored?.toISOString());
    expect(told_).toEqual([first.expiresAt?.toISOString(), second.expiresAt?.toISOString()]);
  });

  test("AC2: a store whose extension always loses the compare-and-set: PauseError.UpdateContended (pause.update-contended) after 8 attempts, nothing told or written", async ({
    app,
    clock,
  }) => {
    await execute(app, managerFlow.start, ORDER, THREAD);
    await clock.advance(hours(1));
    const store = app.resolve(PausedExecutionRepository);
    const before = (await pauseOf(app, pauseIdOf())).expiresAt;
    const losing = vi
      .spyOn(store, "changeTimeoutByTenantIdAndPauseId")
      .mockResolvedValue(undefined);

    const refused = await failureOf(
      app.setPauseTimeout({ pauseId: pauseIdOf(), timeout: hours(26) }, manager),
    );

    expect(MAX_TIMEOUT_ATTEMPTS).toBe(8);
    expect(refused).toBeInstanceOf(PauseError.UpdateContended);
    expect(refused).toMatchObject({
      code: "pause.update-contended",
      attempts: 8,
      details: { attempts: 8 },
    });
    expect((refused as Error).message).toContain(pauseKeyOf("default", pauseIdOf()));
    expect((refused as Error).message).not.toContain(` ${pauseIdOf()} `);
    expect(losing).toHaveBeenCalledTimes(8);
    expect((await pauseOf(app, pauseIdOf())).expiresAt).toEqual(before);
    expect(extendedNotices()).toHaveLength(0);
  });

  test("AC2: a longer change lands between the shorter one's read and its write: the shorter loses the compare-and-set, reads again and applies over the new deadline", async ({
    app,
    clock,
  }) => {
    await execute(app, managerFlow.start, ORDER, THREAD);
    await clock.advance(hours(1));
    const store = app.resolve(PausedExecutionRepository);
    const write = store.changeTimeoutByTenantIdAndPauseId.bind(store);
    const longDeadline = new Date(clock.now().getTime() + hours(40));
    vi.spyOn(store, "changeTimeoutByTenantIdAndPauseId").mockImplementationOnce(async (...args) => {
      await app.setPauseTimeout({ pauseId: pauseIdOf(), timeout: hours(40) }, manager);
      return write(...args);
    });

    const short = await app.setPauseTimeout({ pauseId: pauseIdOf(), timeout: hours(26) }, manager);

    expect(short.previousExpiresAt).toEqual(longDeadline);
    expect(short.expiresAt).toEqual(new Date(clock.now().getTime() + hours(26)));
    expect((await pauseOf(app, pauseIdOf())).expiresAt).toEqual(short.expiresAt);
    await until(() => extendedNotices().length === 2);
    expect(extendedNotices().map((one) => one.previousExpiresAt)).toEqual([
      expect.any(String),
      longDeadline.toISOString(),
    ]);
  });

  test("AC2: a shorter extension lands between the longer one's read and its write: the longer one tries again and wins over the new deadline", async ({
    app,
    clock,
  }) => {
    await execute(app, managerFlow.start, ORDER, THREAD);
    await clock.advance(hours(1));
    const store = app.resolve(PausedExecutionRepository);
    const write = store.changeTimeoutByTenantIdAndPauseId.bind(store);
    const shortDeadline = new Date(clock.now().getTime() + hours(26));
    vi.spyOn(store, "changeTimeoutByTenantIdAndPauseId").mockImplementationOnce(async (...args) => {
      await app.setPauseTimeout({ pauseId: pauseIdOf(), timeout: hours(26) }, manager);
      return write(...args);
    });

    const long = await app.setPauseTimeout({ pauseId: pauseIdOf(), timeout: hours(40) }, manager);

    expect(long.previousExpiresAt).toEqual(shortDeadline);
    expect(long.expiresAt).toEqual(new Date(clock.now().getTime() + hours(40)));
    expect((await pauseOf(app, pauseIdOf())).expiresAt).toEqual(long.expiresAt);
    await until(() => extendedNotices().length === 2);
    expect(extendedNotices().map((one) => one.previousExpiresAt)).toEqual([
      expect.any(String),
      shortDeadline.toISOString(),
    ]);
  });

  test("AC2: the pause closes between the read and the write: refused 'closed', and no 'extended' is told", async ({
    app,
    clock,
  }) => {
    await execute(app, managerFlow.start, ORDER, THREAD);
    await clock.advance(hours(1));
    const store = app.resolve(PausedExecutionRepository);
    const write = store.changeTimeoutByTenantIdAndPauseId.bind(store);
    vi.spyOn(store, "changeTimeoutByTenantIdAndPauseId").mockImplementationOnce(async (...args) => {
      await app.resume({ pauseId: pauseIdOf(), decision: { approved: true } }, manager);
      return write(...args);
    });

    const refused = await failureOf(
      app.setPauseTimeout({ pauseId: pauseIdOf(), timeout: hours(40) }, manager),
    );

    expect(refused).toBeInstanceOf(PauseError.Closed);
    expect(refused).toMatchObject({ reason: PauseClosedReason.Answered });
    expect(extendedNotices()).toEqual([]);
  });
});
