/**
 * #942 AC1, AC2: an operator extends an open pause's deadline (`app.extendPause`) — the new
 * deadline holds on every instance and the channel and the listener hear "extended"; an extension
 * after the deadline is refused "expired", one past the run's deadline is refused with that
 * deadline; the respondent is checked as for an answer; extend and the expiry look at one tick: one wins.
 */
import { ExecutionError } from "../../src/core/error-families/run-errors.js";
import { beforeEach, describe, expect, vi } from "vitest";
import {
  PauseClosedError,
  PauseExtensionContendedError,
  UnknownPauseError,
} from "../../src/errors.js";
import { MAX_EXTEND_ATTEMPTS } from "../../src/app/pause-extension.js";
import { DeadlineExceededError } from "../../src/budgets/execution-deadline.js";
import { PauseError, PauseClosedReason, PauseStatus, ValidationError } from "../../src/index.js";
import { pauseKeyOf } from "../../src/infrastructure/pause-record.js";
import { PausedExecutionRepository } from "../../src/infrastructure/paused-execution.repository.js";
import { testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { hours, minutes, seconds } from "../../src/units/index.js";
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
    const oldDeadline = paused.pending[0]?.expiresAt ?? "";
    await clock.advance(hours(1));

    const extension = await instance(apps, 1).extendPause(
      { pauseId: pauseIdOf(), expiresIn: hours(24) },
      manager,
    );

    const expected = new Date(clock.now().getTime() + hours(24)).toISOString();
    expect(extension).toEqual({
      pauseKey: pauseKeyOf("default", pauseIdOf()),
      expiresAt: expected,
      previousExpiresAt: oldDeadline,
    });
    // on every instance: the record says so, and the old deadline passes with the pause open
    expect((await pauseOf(instance(apps, 2), pauseIdOf())).expiresAt).toBe(expected);
    await clock.advance(span(hours(23), minutes(30)));
    expect((await pauseOf(instance(apps, 2), pauseIdOf())).status).toBe(PauseStatus.Pending);
    const done = await instance(apps, 2).resume(
      { pauseId: pauseIdOf(), decision: { approved: true } },
      manager,
    );
    expect(done.status).toBe("finished");
    // the channel and the listener heard "extended until …" once, with the old deadline too
    await until(() => told.notices.filter((one) => one.kind === "extended").length === 2);
    await clock.advance(seconds(30));
    const extended = told.notices.filter((one) => one.kind === "extended");
    expect(extended.map((one) => one.receiver).sort()).toEqual(["channel", "listener"]);
    for (const one of extended)
      expect(one).toMatchObject({ expiresAt: expected, previousExpiresAt: oldDeadline });
  });

  test("AC1: the pause's remindAt moves with the deadline", async ({ apps, clock }) => {
    await instance(apps, 0).ready();
    await execute(instance(apps, 0), managerFlow.start, ORDER, THREAD);
    await clock.advance(hours(1));

    await instance(apps, 0).extendPause({ pauseId: pauseIdOf(), expiresIn: hours(24) }, manager);

    const pause = await pauseOf(instance(apps, 0), pauseIdOf());
    expect(pause.remindAt).toBe(
      new Date(Date.parse(pause.expiresAt ?? "") - hours(2)).toISOString(),
    );
  });

  test("a ThreadOwner pause: the owner extends, another owner is refused, answeredBy is refused", async ({
    app,
    clock,
  }) => {
    const paused = await execute(app, ownerFlow.start, ORDER, { ...THREAD, ownerId: "alice" });
    const pauseId = paused.pending[0]?.pauseId ?? "";
    await clock.advance(hours(1));
    const request = { pauseId, expiresIn: hours(24) };

    expect(await failureOf(app.extendPause(request, { ownerId: "bob" }))).toBeInstanceOf(
      ExecutionError.ThreadOwnerMismatch,
    );
    expect(await failureOf(app.extendPause(request, manager))).toBeInstanceOf(
      PauseError.PermissionDenied,
    );
    const extension = await app.extendPause(request, { ownerId: "alice" });

    expect(extension.expiresAt).toBe(new Date(clock.now().getTime() + hours(24)).toISOString());
  });

  test("a Channel pause needs answeredBy: none, an empty one and ownerId are refused", async ({
    app,
  }) => {
    await execute(app, managerFlow.start, ORDER, THREAD);
    const request = { pauseId: pauseIdOf(), expiresIn: hours(30) };

    for (const options of [{}, { actor: { id: " " } }, { ownerId: "alice" }])
      expect(await failureOf(app.extendPause(request, options as never))).toBeInstanceOf(
        PauseError.PermissionDenied,
      );
    expect((await pauseOf(app, pauseIdOf())).status).toBe(PauseStatus.Pending);
  });
});

describe("#942 AC2: refused extensions", () => {
  test("AC2: after the deadline → PauseClosedError expired (before the look expired the pause, and after)", async ({
    app,
    clock,
  }) => {
    const paused = await execute(app, managerFlow.start, ORDER, THREAD);
    const deadline = paused.pending[0]?.expiresAt ?? "";
    const store = app.resolve(PausedExecutionRepository);
    const spy = vi.spyOn(store, "findPendingByExpiresAtBefore").mockResolvedValue([]);

    await clock.advance(hours(24));
    const early = await failureOf(
      app.extendPause({ pauseId: pauseIdOf(), expiresIn: hours(24) }, manager),
    );
    spy.mockRestore();
    await clock.advance(seconds(10));
    await until(async () => (await pauseOf(app, pauseIdOf())).status !== PauseStatus.Pending);
    const late = await failureOf(
      app.extendPause({ pauseId: pauseIdOf(), expiresIn: hours(24) }, manager),
    );

    for (const refused of [early, late]) {
      expect(refused).toBeInstanceOf(PauseClosedError);
      expect(refused).toMatchObject({ reason: PauseClosedReason.Expired, closedAt: deadline });
    }
    expect(told.notices.filter((one) => one.kind === "extended")).toEqual([]);
  });

  test("AC2: past the run deadline → ValidationError.DtoInvalid naming that deadline; exactly the run deadline is allowed", async ({
    app,
  }) => {
    // the question's own 24 h, bound by a run that ends at hour 30
    const paused = await execute(app, managerFlow.start, ORDER, { ...THREAD, deadline: hours(30) });
    expect(paused.status).toBe("paused");
    const runDeadline = new Date(
      Date.parse((await pauseOf(app, pauseIdOf())).askedAt) + hours(30),
    ).toISOString();

    const refused = await failureOf(
      app.extendPause({ pauseId: pauseIdOf(), expiresIn: hours(31) }, manager),
    );

    expect(refused).toBeInstanceOf(ValidationError.DtoInvalid);
    expect(refused).toMatchObject({ dto: "ExtendPauseRequest" });
    expect((refused as Error).message).toContain(runDeadline);
    expect((await pauseOf(app, pauseIdOf())).expiresAt).not.toBe(runDeadline);
    const allowed = await app.extendPause({ pauseId: pauseIdOf(), expiresIn: hours(30) }, manager);
    expect(allowed.expiresAt).toBe(runDeadline);
  });

  test("AC2: no deadline → refused", async ({ app }) => {
    await execute(app, openFlow.start, ORDER, THREAD);
    const page = await app
      .resolve(PausedExecutionRepository)
      .findPageByTenantId("default", { statuses: [PauseStatus.Pending] }, 10);
    const [pause] = page.pauses;

    const refused = await failureOf(
      app.extendPause({ pauseId: pause?.pauseId ?? "", expiresIn: hours(1) }, manager),
    );

    expect(refused).toBeInstanceOf(ValidationError.DtoInvalid);
    expect(refused).toMatchObject({ dto: "ExtendPauseRequest" });
  });

  test("AC2: a shorter (or the same) deadline → refused", async ({ app }) => {
    await execute(app, managerFlow.start, ORDER, THREAD);

    for (const expiresIn of [hours(1), hours(24)])
      expect(
        await failureOf(app.extendPause({ pauseId: pauseIdOf(), expiresIn }, manager)),
      ).toMatchObject({
        name: "ValidationError.DtoInvalid",
        dto: "ExtendPauseRequest",
      });
    expect((await pauseOf(app, pauseIdOf())).expiresAt).toBeDefined();
  });

  test("AC2: an expiresIn that is no duration → refused, whatever the pause", async ({ app }) => {
    await execute(app, managerFlow.start, ORDER, THREAD);

    for (const expiresIn of [0, -5, Infinity, Number.NaN, seconds(0.5), "24h", undefined])
      expect(
        await failureOf(
          app.extendPause({ pauseId: pauseIdOf(), expiresIn: expiresIn as never }, manager),
        ),
      ).toBeInstanceOf(ValidationError.DtoInvalid);
  });

  test("AC2: another tenant's pause → UnknownPauseError", async ({ app }) => {
    await execute(app, managerFlow.start, ORDER, { ...THREAD, tenant: { tenantId: "acme" } });
    const request = { pauseId: pauseIdOf(), expiresIn: hours(30) };

    expect(await failureOf(app.extendPause(request, manager))).toBeInstanceOf(UnknownPauseError);
    expect(
      await failureOf(
        app.extendPause({ ...request, pauseId: "nope" }, { ...manager, tenantId: "acme" }),
      ),
    ).toBeInstanceOf(UnknownPauseError);
    const extension = await app.extendPause(request, { ...manager, tenantId: "acme" });
    expect(extension.pauseKey).toBe(pauseKeyOf("acme", pauseIdOf()));
  });

  test("a closed pause (answered) → PauseClosedError answered", async ({ app }) => {
    await execute(app, managerFlow.start, ORDER, THREAD);
    await app.resume({ pauseId: pauseIdOf(), decision: { approved: true } }, manager);

    const refused = await failureOf(
      app.extendPause({ pauseId: pauseIdOf(), expiresIn: hours(30) }, manager),
    );

    expect(refused).toBeInstanceOf(PauseClosedError);
    expect(refused).toMatchObject({ reason: PauseClosedReason.Answered });
  });
});

describe("#942: the caller's options", () => {
  test("an id of who calls that is no key's text is a ValidationError.DtoInvalid on PauseCallerOptions", async ({
    app,
  }) => {
    await execute(app, managerFlow.start, ORDER, THREAD);
    const request = { pauseId: pauseIdOf(), expiresIn: hours(30) };

    const refused = await failureOf(app.extendPause(request, { actor: { id: "bob\uD800" } }));

    expect(refused).toBeInstanceOf(ValidationError.DtoInvalid);
    expect(refused).toMatchObject({ dto: "PauseCallerOptions" });
  });

  test("call options a JS caller passes are not read: nothing runs (the types refuse them)", async ({
    app,
  }) => {
    await execute(app, managerFlow.start, ORDER, THREAD);
    const streamed: unknown[] = [];

    const extension = await app.extendPause({ pauseId: pauseIdOf(), expiresIn: hours(30) }, {
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
      app.extendPause({ pauseId: pauseIdOf(), expiresIn: hours(1) }, manager),
    );

    expect(refused).toBeInstanceOf(PauseClosedError);
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
    const stale = { ...read, expiresAt: new Date(clock.now().getTime() + hours(1)).toISOString() };
    // read twice: where the pause waits (the app's routing), then the extension's own read
    vi.spyOn(store, "findByTenantIdAndPauseId")
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(stale);

    const refused = await failureOf(
      app.extendPause({ pauseId: pauseIdOf(), expiresIn: hours(48) }, manager),
    );
    look.mockRestore();
    await clock.advance(seconds(10));
    await until(async () => (await pauseOf(app, pauseIdOf())).status !== PauseStatus.Pending);

    expect(refused).toBeInstanceOf(PauseClosedError);
    expect(refused).toMatchObject({ reason: PauseClosedReason.Expired });
    expect(told.notices.filter((one) => one.kind === "extended")).toEqual([]);
    expect((await pauseOf(app, pauseIdOf())).expiresAt).toBe(read.expiresAt);
  });

  test("the extension lands first: the look at the old deadline finds nothing to expire", async ({
    app,
    clock,
  }) => {
    await execute(app, managerFlow.start, ORDER, THREAD);
    await clock.advance(hours(23));
    await app.extendPause({ pauseId: pauseIdOf(), expiresIn: hours(24) }, manager);

    await clock.advance(hours(2));

    expect((await pauseOf(app, pauseIdOf())).status).toBe(PauseStatus.Pending);
    expect(told.other.filter((line) => line.includes("closed"))).toEqual([]);
  });
});

describe("#942: extended to exactly the run's deadline: the tie goes to the run (#941 D8)", () => {
  test("the run fails at that instant with DeadlineExceededError; the channel's expiry decision is not asked, whatever it would decide", async ({
    app,
    clock,
  }) => {
    await execute(app, managerFlow.start, ORDER, { ...THREAD, deadline: hours(30) });
    const runDeadline = new Date(clock.now().getTime() + hours(30)).toISOString();
    await app.extendPause({ pauseId: pauseIdOf(), expiresIn: hours(30) }, manager);
    expect((await pauseOf(app, pauseIdOf())).expiresAt).toBe(runDeadline);

    await clock.advance(hours(30));
    await until(() => told.errors.length === 1);

    expect(told.errors[0]).toBeInstanceOf(DeadlineExceededError);
    expect(told.expiryAsked).toEqual([]);
    expect(told.recorded).toEqual([]);
  });
});

describe("#1099: racing extensions: the store's compare-and-set decides, 'extended' is told by the winner only", () => {
  const extendedNotices = () =>
    told.notices.filter((one) => one.kind === "extended" && one.receiver === "channel");

  test("AC1: a longer and a shorter extension at once, from two instances: the deadline never shortens, every told deadline is the stored chain", async ({
    apps,
    clock,
  }) => {
    await Promise.all(apps.map((one) => one.ready()));
    await execute(instance(apps, 0), managerFlow.start, ORDER, THREAD);
    await clock.advance(hours(1));
    const asked = (await pauseOf(instance(apps, 0), pauseIdOf())).expiresAt;

    const [long, short] = await Promise.allSettled([
      instance(apps, 0).extendPause({ pauseId: pauseIdOf(), expiresIn: hours(40) }, manager),
      instance(apps, 1).extendPause({ pauseId: pauseIdOf(), expiresIn: hours(26) }, manager),
    ]);

    const stored = (await pauseOf(instance(apps, 2), pauseIdOf())).expiresAt;
    expect(long.status).toBe("fulfilled");
    expect(stored).toBe(new Date(clock.now().getTime() + hours(40)).toISOString());
    // the shorter one either went first (and the longer one moved from its deadline) or was refused
    if (short.status === "rejected") {
      expect(short.reason).toBeInstanceOf(ValidationError.DtoInvalid);
      expect(long.status === "fulfilled" && long.value.previousExpiresAt).toBe(asked);
    } else {
      expect(long.status === "fulfilled" && long.value.previousExpiresAt).toBe(
        short.value.expiresAt,
      );
      expect(short.value.previousExpiresAt).toBe(asked);
    }
    await until(() => extendedNotices().length === (short.status === "rejected" ? 1 : 2));
    const told_ = extendedNotices().map((one) => one.expiresAt);
    expect(told_).toEqual([...told_].sort());
    expect(told_.at(-1)).toBe(stored);
  });

  test("AC2: a store whose extension always loses the compare-and-set: PauseExtensionContendedError (pause.update-contended) after 8 attempts, nothing told or written", async ({
    app,
    clock,
  }) => {
    await execute(app, managerFlow.start, ORDER, THREAD);
    await clock.advance(hours(1));
    const store = app.resolve(PausedExecutionRepository);
    const before = (await pauseOf(app, pauseIdOf())).expiresAt;
    const losing = vi.spyOn(store, "extendByTenantIdAndPauseId").mockResolvedValue(undefined);

    const refused = await failureOf(
      app.extendPause({ pauseId: pauseIdOf(), expiresIn: hours(26) }, manager),
    );

    expect(MAX_EXTEND_ATTEMPTS).toBe(8);
    expect(refused).toBeInstanceOf(PauseExtensionContendedError);
    expect(refused).toMatchObject({
      code: "pause.update-contended",
      attempts: 8,
      details: { attempts: 8 },
    });
    expect((refused as Error).message).toContain(pauseKeyOf("default", pauseIdOf()));
    expect((refused as Error).message).not.toContain(` ${pauseIdOf()} `);
    expect(losing).toHaveBeenCalledTimes(8);
    expect((await pauseOf(app, pauseIdOf())).expiresAt).toBe(before);
    expect(extendedNotices()).toHaveLength(0);
  });

  test("AC2: a longer extension lands between the shorter one's read and its write: the shorter is refused 'not later', nothing of it is told or written", async ({
    app,
    clock,
  }) => {
    await execute(app, managerFlow.start, ORDER, THREAD);
    await clock.advance(hours(1));
    const store = app.resolve(PausedExecutionRepository);
    const write = store.extendByTenantIdAndPauseId.bind(store);
    let racing: Promise<unknown> | undefined;
    vi.spyOn(store, "extendByTenantIdAndPauseId").mockImplementationOnce(async (...args) => {
      racing = app.extendPause({ pauseId: pauseIdOf(), expiresIn: hours(40) }, manager);
      await racing;
      return write(...args);
    });

    const refused = await failureOf(
      app.extendPause({ pauseId: pauseIdOf(), expiresIn: hours(26) }, manager),
    );

    expect(refused).toBeInstanceOf(ValidationError.DtoInvalid);
    expect(JSON.stringify(refused)).toContain("not later");
    expect((await pauseOf(app, pauseIdOf())).expiresAt).toBe(
      new Date(clock.now().getTime() + hours(40)).toISOString(),
    );
    await until(() => extendedNotices().length === 1);
    expect(extendedNotices()).toHaveLength(1);
  });

  test("AC2: a shorter extension lands between the longer one's read and its write: the longer one tries again and wins over the new deadline", async ({
    app,
    clock,
  }) => {
    await execute(app, managerFlow.start, ORDER, THREAD);
    await clock.advance(hours(1));
    const store = app.resolve(PausedExecutionRepository);
    const write = store.extendByTenantIdAndPauseId.bind(store);
    const shortDeadline = new Date(clock.now().getTime() + hours(26)).toISOString();
    vi.spyOn(store, "extendByTenantIdAndPauseId").mockImplementationOnce(async (...args) => {
      await app.extendPause({ pauseId: pauseIdOf(), expiresIn: hours(26) }, manager);
      return write(...args);
    });

    const long = await app.extendPause({ pauseId: pauseIdOf(), expiresIn: hours(40) }, manager);

    expect(long.previousExpiresAt).toBe(shortDeadline);
    expect(long.expiresAt).toBe(new Date(clock.now().getTime() + hours(40)).toISOString());
    expect((await pauseOf(app, pauseIdOf())).expiresAt).toBe(long.expiresAt);
    await until(() => extendedNotices().length === 2);
    expect(extendedNotices().map((one) => one.previousExpiresAt)).toEqual([
      expect.any(String),
      shortDeadline,
    ]);
  });

  test("AC2: the pause closes between the read and the write: refused 'closed', and no 'extended' is told", async ({
    app,
    clock,
  }) => {
    await execute(app, managerFlow.start, ORDER, THREAD);
    await clock.advance(hours(1));
    const store = app.resolve(PausedExecutionRepository);
    const write = store.extendByTenantIdAndPauseId.bind(store);
    vi.spyOn(store, "extendByTenantIdAndPauseId").mockImplementationOnce(async (...args) => {
      await app.resume({ pauseId: pauseIdOf(), decision: { approved: true } }, manager);
      return write(...args);
    });

    const refused = await failureOf(
      app.extendPause({ pauseId: pauseIdOf(), expiresIn: hours(40) }, manager),
    );

    expect(refused).toBeInstanceOf(PauseClosedError);
    expect(refused).toMatchObject({ reason: PauseClosedReason.Answered });
    expect(extendedNotices()).toEqual([]);
  });
});
