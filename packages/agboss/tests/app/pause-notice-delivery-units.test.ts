/**
 * #1356 (pause-notices shard) — the delivery of pause notices (#940, #1131) on its own, the receiver replaced by a
 * fake: which mailboxes a look claims, how a failure is coded and retried or set aside, what a stop leaves alone,
 * how a claim is renewed while its receiver runs, and how kicks coalesce into looks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  backoffAfter,
  PauseNoticeDelivery,
  type DeliveryParts,
} from "../../src/app/pause-notice-delivery.js";
import { NoticeTimeoutError } from "../../src/app/pause-notice-call.js";
import { UnknownReceiverError } from "../../src/app/pause-notice-receive.js";
import { InMemoryPausedExecutionRepository } from "../../src/infrastructure/in-memory-paused-execution.repository.js";
import { PauseNoticeKind, type PauseNoticeClaim } from "../../src/infrastructure/pause-notices.js";
import { pauseKeyOf } from "../../src/infrastructure/pause-record.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { pauseOf } from "../../src/testing/contracts/paused-execution-data.js";
import { seconds, type Milliseconds } from "../../src/units/index.js";

const told = vi.hoisted(() => ({
  calls: [] as { recipient: string; kind: string; pauseId: string }[],
  run: (_input: { recipient: string; kind: string; pauseId: string }): Promise<void> =>
    Promise.resolve(),
}));
vi.mock("../../src/app/pause-notice-receive.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/app/pause-notice-receive.js")>()),
  receive: (
    _parts: unknown,
    _deps: unknown,
    input: { recipient: string; pause: { pauseId: string }; notice: { kind: string } },
  ) => {
    const call = {
      recipient: input.recipient,
      kind: input.notice.kind,
      pauseId: input.pause.pauseId,
    };
    told.calls.push(call);
    return told.run(call);
  },
}));

beforeEach(() => {
  told.calls.length = 0;
  told.run = () => Promise.resolve();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const RECIPIENTS = { channel: "refund", listeners: [] };
const CHANNEL = "channel:refund";
const START = new Date("2026-11-20T10:00:00.000Z");

/** A delivery over a store holding sent, answered pauses — each has one mailbox for the channel. */
async function made(
  ids: readonly string[] = ["p-1"],
  options: {
    rooted?: boolean;
    interruption?: AbortSignal;
    retention?: Milliseconds;
    clock?: VirtualClock;
  } = {},
) {
  const clock = options.clock ?? new VirtualClock(START);
  const pauses = new InMemoryPausedExecutionRepository();
  for (const id of ids) {
    await pauses.findOrCreateByStepKey({ ...pauseOf(id, `run-1:${id}`), isSent: false });
    await pauses.markSentByTenantIdAndPauseId("default", id, RECIPIENTS);
    await pauses.resolveByTenantIdAndPauseId(
      "default",
      id,
      { decision: { approved: true }, answeredBy: undefined },
      START,
      RECIPIENTS,
    );
  }
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const parts: DeliveryParts = {
    clock,
    pauses,
    log,
    retention: options.retention ?? seconds(3600),
    recipients: () => [CHANNEL],
    // reads the pause as the application's own does: a pause that is not there is no argument
    rootOf: (pause) =>
      Promise.resolve(options.rooted === false || pause.pauseId === "" ? undefined : ({} as never)),
    interruption: () => options.interruption,
    listenerOf: () => undefined,
  };
  return { delivery: new PauseNoticeDelivery(parts), pauses, clock, log };
}

/** The mailbox of a pause, as a claim shows it. */
const mailboxOf = async (pauses: InMemoryPausedExecutionRepository, at: Date) =>
  (await pauses.claimNoticesDue(at, 10, seconds(1), [CHANNEL]))[0]?.mailbox;

describe("#1356: the pause before the next attempt", () => {
  it("is a second doubled by each failed attempt, at most five minutes", () => {
    expect([0, 1, 2, 3, 8].map((attempts) => backoffAfter(attempts))).toEqual([
      1000, 2000, 4000, 8000, 256_000,
    ]);
    expect(backoffAfter(9)).toBe(300_000);
    expect(backoffAfter(20)).toBe(300_000);
    expect(backoffAfter(500)).toBe(300_000);
  });
});

describe("#1356: a look", () => {
  it("tells each mailbox due its head notice and acknowledges it: told once, and not again", async () => {
    const { delivery, pauses } = await made(["p-1", "p-2"]);

    await delivery.look();
    await delivery.look();

    expect(told.calls.map(({ pauseId, kind }) => `${pauseId} ${kind}`).sort()).toEqual([
      `p-1 ${PauseNoticeKind.Closed}`,
      `p-2 ${PauseNoticeKind.Closed}`,
    ]);
    expect(await pauses.countNotices()).toEqual({ live: 0, dead: 0 });
  });

  it("claims for the receivers this instance knows, and for none asks the store nothing", async () => {
    const { pauses, clock, log } = await made();
    const claims = vi.spyOn(pauses, "claimNoticesDue");
    const none = new PauseNoticeDelivery({
      clock,
      pauses,
      log,
      retention: seconds(1),
      recipients: () => [],
      rootOf: () => Promise.resolve(undefined),
      interruption: () => undefined,
      listenerOf: () => undefined,
    });

    await none.look();
    expect(claims).not.toHaveBeenCalled();
    expect(told.calls).toEqual([]);

    const { delivery, pauses: other } = await made();
    const asked = vi.spyOn(other, "claimNoticesDue");
    await delivery.look();
    expect(asked).toHaveBeenCalledWith(START, 50, 60_000, [CHANNEL]);
  });

  it("tells a mailbox's notices head first, one after the other, until none is left", async () => {
    const { delivery, pauses } = await made();
    await pauses.noticeOnceByTenantIdAndPauseId(
      "default",
      "p-1",
      PauseNoticeKind.JoinFailed,
      { launch: "l", errorCode: "boom" },
      START,
      RECIPIENTS,
    );

    await delivery.look();

    expect(told.calls.map(({ kind }) => kind)).toEqual([
      PauseNoticeKind.Closed,
      PauseNoticeKind.JoinFailed,
    ]);
    expect(await pauses.countNotices()).toEqual({ live: 0, dead: 0 });
  });
});

describe("#1356: a failed attempt", () => {
  const failing = (error: Error) => {
    told.run = () => Promise.reject(error);
  };

  it.each([
    ["a receiver that threw", new Error("secret token abc"), "receiver-failed"],
    [
      "a receiver the application has not",
      new UnknownReceiverError("no channel x"),
      "receiver-unknown",
    ],
    ["a hook past its timeout", new NoticeTimeoutError(seconds(5)), "receiver-timeout"],
  ])(
    "%s is retried after a second, under a fixed code that carries no message",
    async (_case, error, code) => {
      const { delivery, pauses, clock, log } = await made();
      failing(error);

      await delivery.look();

      expect(log.warn).toHaveBeenCalledTimes(1);
      const [logged, text, subject] = log.warn.mock.calls[0] as [string, string, unknown];
      expect(logged).toBe("pause.notice-failed");
      expect(text).toBe(
        `a notice failed to ${CHANNEL} (pause ${pauseKeyOf("default", "p-1")}): ${code}`,
      );
      expect(text).not.toContain("secret");
      expect(subject).toEqual({ tenantId: "default" });
      expect(
        await pauses.claimNoticesDue(new Date(clock.now().getTime() + 999), 10, seconds(1), [
          CHANNEL,
        ]),
      ).toEqual([]);
      const retried = await mailboxOf(pauses, new Date(clock.now().getTime() + 1000));
      expect(retried).toMatchObject({ attempts: 1, problem: code });
    },
  );

  it("a pause that is not there, or of no workflow here, is unreadable: retried as such, never told", async () => {
    const gone = await made(["p-1"], { rooted: false });

    await gone.delivery.look();

    expect(told.calls).toEqual([]);
    expect(gone.log.warn.mock.calls[0]?.[1]).toContain("pause-unreadable");
    expect(await mailboxOf(gone.pauses, new Date(START.getTime() + 1000))).toMatchObject({
      problem: "pause-unreadable",
    });
  });

  it("the pause grows with each attempt: two seconds after the second", async () => {
    const { delivery, pauses, clock } = await made();
    failing(new Error("boom"));

    await delivery.look();
    await clock.advance(seconds(1));
    await delivery.look();

    expect(
      await pauses.claimNoticesDue(new Date(clock.now().getTime() + 1999), 10, seconds(1), [
        CHANNEL,
      ]),
    ).toEqual([]);
    expect(await mailboxOf(pauses, new Date(clock.now().getTime() + 2000))).toMatchObject({
      attempts: 2,
    });
  });

  it("a head older than the retention is set aside, logged as an error once; at the retention exactly, too; younger, not", async () => {
    const old = await made(["p-1"], { retention: seconds(60) });
    failing(new Error("boom"));
    await old.clock.advance(seconds(59));
    await old.delivery.look();
    expect(await old.pauses.countNotices()).toEqual({ live: 1, dead: 0 });
    expect(old.log.error).not.toHaveBeenCalled();

    await old.clock.advance(seconds(1000));
    await old.delivery.look();
    await old.clock.advance(seconds(1000));
    await old.delivery.look();

    expect(await old.pauses.countNotices()).toEqual({ live: 0, dead: 1 });
    expect(old.log.error).toHaveBeenCalledTimes(1);
    const [code, text, subject] = old.log.error.mock.calls[0] as [string, string, unknown];
    expect(code).toBe("pause.notice-dead");
    expect(text).toBe(
      `a notice was set aside to ${CHANNEL} (pause ${pauseKeyOf("default", "p-1")}): receiver-failed`,
    );
    expect(subject).toEqual({ tenantId: "default" });
  });

  it("a head as old as the retention is set aside", async () => {
    const { delivery, pauses, clock } = await made(["p-1"], { retention: seconds(60) });
    failing(new Error("boom"));
    await clock.advance(seconds(60));

    await delivery.look();

    expect(await pauses.countNotices()).toEqual({ live: 0, dead: 1 });
  });

  it("an attempt cut off by the instance's stop is none: nothing retried, nothing set aside, nothing logged", async () => {
    const stop = new AbortController();
    const { delivery, pauses, clock, log } = await made(["p-1"], {
      interruption: stop.signal,
      retention: seconds(1),
    });
    told.run = () => {
      stop.abort();
      return Promise.reject(new Error("cut off"));
    };
    await clock.advance(seconds(100));

    await delivery.look();

    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
    expect(await pauses.countNotices()).toEqual({ live: 1, dead: 0 });
  });

  it("a pause that was removed meanwhile is unreadable too: the delivery never asks for its workflow", async () => {
    const { delivery, pauses, clock } = await made();
    vi.spyOn(pauses, "findByTenantIdAndPauseId").mockResolvedValue(undefined);

    await delivery.look();

    expect(told.calls).toEqual([]);
    expect(await mailboxOf(pauses, new Date(clock.now().getTime() + 1000))).toMatchObject({
      problem: "pause-unreadable",
    });
  });

  it("a failure of the store in one mailbox's delivery rejects the look, whichever mailbox it was", async () => {
    const { delivery, pauses } = await made(["p-1", "p-2"]);
    const ack = pauses.ackNotice.bind(pauses);
    vi.spyOn(pauses, "ackNotice").mockImplementation((claim, at) =>
      claim.mailbox.pauseId === "p-2" ? Promise.reject(new Error("store down")) : ack(claim, at),
    );

    await expect(delivery.look()).rejects.toThrow("store down");
    expect(told.calls).toHaveLength(2);
  });

  it("a look that met a failure of the store rejects with the first of them, after the others ended", async () => {
    const { delivery, pauses } = await made(["p-1", "p-2"]);
    vi.spyOn(pauses, "ackNotice").mockRejectedValue(new Error("store down"));

    await expect(delivery.look()).rejects.toThrow("store down");
    expect(told.calls).toHaveLength(2);
  });
});

describe("#1356: the renewal of a claim while its receiver runs (#1131)", () => {
  /** A receiver that runs until `release` is called. */
  function blocking() {
    let release: () => void = () => undefined;
    told.run = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    return () => {
      release();
    };
  }

  it("is renewed every twenty seconds, for a minute from then, until the receiver returns", async () => {
    const { delivery, pauses, clock } = await made();
    const renew = vi.spyOn(pauses, "renewNotice");
    const release = blocking();
    const looking = delivery.look();

    await clock.advance(seconds(19));
    expect(renew).not.toHaveBeenCalled();
    await clock.advance(seconds(1));
    expect(renew).toHaveBeenCalledTimes(1);
    expect(renew.mock.calls[0]?.[1]).toEqual(new Date(START.getTime() + 20_000));
    expect(renew.mock.calls[0]?.[2]).toBe(60_000);
    await clock.advance(seconds(20));
    expect(renew).toHaveBeenCalledTimes(2);
    release();
    await looking;
    await clock.advance(seconds(60));
    expect(renew).toHaveBeenCalledTimes(2);
  });

  it("ends when the store says the token is lost, and a renewal that fails or hangs is tried again at the next tick", async () => {
    const { delivery, pauses, clock } = await made();
    const renew = vi.spyOn(pauses, "renewNotice");
    renew.mockRejectedValueOnce(new Error("store down"));
    renew.mockImplementationOnce(() => new Promise<PauseNoticeClaim | undefined>(() => undefined));
    renew.mockResolvedValueOnce(undefined);
    const release = blocking();
    const looking = delivery.look();

    await clock.advance(seconds(20));
    await clock.advance(seconds(20));
    expect(renew).toHaveBeenCalledTimes(2);
    // the hung one is bound at five seconds
    await clock.advance(seconds(5));
    await clock.advance(seconds(20));
    expect(renew).toHaveBeenCalledTimes(3);
    await clock.advance(seconds(60));
    expect(renew).toHaveBeenCalledTimes(3);
    release();
    await looking;
  });
});

describe("#1356: the instance's stop", () => {
  it("ends the renewal of a claim: a stop that is not aborted leaves it going, an aborted one ends it", async () => {
    const stop = new AbortController();
    const { delivery, pauses, clock } = await made(["p-1"], { interruption: stop.signal });
    const renew = vi.spyOn(pauses, "renewNotice");
    let release: () => void = () => undefined;
    told.run = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const looking = delivery.look();

    await clock.advance(seconds(20));
    expect(renew).toHaveBeenCalledTimes(1);
    stop.abort();
    await clock.advance(seconds(60));
    expect(renew).toHaveBeenCalledTimes(1);
    release();
    await looking;
  });
});

/** A clock that keeps the signal of every sleep of `delay`. */
class SleepsKept extends VirtualClock {
  readonly signals: AbortSignal[] = [];

  constructor(private readonly delay: number) {
    super(START);
  }

  override sleep(delay: Milliseconds, signal?: AbortSignal): Promise<void> {
    if (delay === this.delay && signal !== undefined) this.signals.push(signal);
    return super.sleep(delay, signal);
  }
}

describe("#1356: the bound of a renewal", () => {
  it("is a timer of five seconds, released when the renewal failed as when it answered", async () => {
    const clock = new SleepsKept(5000);
    const { delivery, pauses } = await made(["p-1"], { clock });
    const renew = vi.spyOn(pauses, "renewNotice");
    renew.mockRejectedValueOnce(new Error("store down"));
    let release: () => void = () => undefined;
    told.run = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const looking = delivery.look();

    await clock.advance(seconds(20));
    await clock.advance(seconds(20));

    expect(renew).toHaveBeenCalledTimes(2);
    expect(clock.signals).toHaveLength(2);
    expect(clock.signals.every((signal) => signal.aborted)).toBe(true);
    release();
    await looking;
  });
});

describe("#1356: kicks and looks", () => {
  it("a kick looks at once, not awaited, and `settled` waits for it", async () => {
    const { delivery } = await made();

    delivery.kick();
    await delivery.settled();

    expect(told.calls).toHaveLength(1);
  });

  it("kicks that come while a look runs coalesce into one more look", async () => {
    const { delivery, pauses } = await made();
    const claims = vi.spyOn(pauses, "claimNoticesDue");

    delivery.kick();
    delivery.kick();
    delivery.kick();
    await delivery.settled();

    expect(claims).toHaveBeenCalledTimes(2);
  });

  it("a kick with no look in flight starts one; with none kicked since, `settled` has nothing to wait for", async () => {
    const { delivery, pauses } = await made();
    const claims = vi.spyOn(pauses, "claimNoticesDue");

    await delivery.settled();
    expect(claims).not.toHaveBeenCalled();
    delivery.kick();
    await delivery.settled();
    delivery.kick();
    await delivery.settled();

    expect(claims).toHaveBeenCalledTimes(2);
  });

  it("a look that fails is logged as a warning, never thrown, and the next kick looks again", async () => {
    const { delivery, pauses, log } = await made();
    const claims = vi
      .spyOn(pauses, "claimNoticesDue")
      .mockRejectedValueOnce(new Error("store down"));

    delivery.kick();
    await delivery.settled();

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      "pause-timers.failed",
      "a look for pause notices failed: Error: store down",
    );
    delivery.kick();
    await delivery.settled();
    expect(claims).toHaveBeenCalledTimes(2);
    expect(told.calls).toHaveLength(1);
  });
});
