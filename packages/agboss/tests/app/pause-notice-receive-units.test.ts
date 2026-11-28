/**
 * #1356 (pause-notices shard) — which hook of which receiver a notice reaches (#940, #942, #945), on its own, the
 * pause's frame, the event builders and the call replaced by markers: a channel and a listener are told the kinds
 * they have a hook for, each with its own event, a receiver without the hook is told nothing and the notice counts
 * as delivered, an unknown receiver is refused naming it, and the timeout is the tool's for an approval.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  receive,
  UnknownReceiverError,
  type ReceiveParts,
} from "../../src/app/pause-notice-receive.js";
import { PauseNoticeKind, type PauseNotice } from "../../src/infrastructure/pause-notices.js";
import { PauseKind, type PauseRecord } from "../../src/infrastructure/pause-record.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { pauseOf, questionPauseOf } from "../../src/testing/contracts/paused-execution-data.js";
import { seconds } from "../../src/units/index.js";

const seen = vi.hoisted(
  (): {
    own: Record<string, unknown>;
    calls: { timeout: number; frame: unknown; interruption: unknown }[];
    sources: { masked: (value: unknown) => Promise<unknown>; deliveryId: string }[];
  } => ({ own: {}, calls: [], sources: [] }),
);

vi.mock("../../src/app/own-deps.js", () => ({ ownDepsOf: () => seen.own }));
vi.mock("../../src/app/pause-frame.js", () => ({
  treeStateOf: () => Promise.resolve("state"),
  pauseTreeOf: () => Promise.resolve("tree"),
  pauseFrameOf: () => "frame",
}));
vi.mock("../../src/app/pause-notice-call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/app/pause-notice-call.js")>()),
  callInFrame: (
    call: { timeout: number; frame: unknown; interruption: unknown },
    run: () => Promise<unknown>,
  ) => {
    seen.calls.push(call);
    return run();
  },
}));
vi.mock("../../src/app/pause-join-notices.js", () => ({
  channelJoinFailedOf: () => "channel-join-failed-event",
  listenerJoinFailedOf: (_sources: unknown, includePauseIds: boolean) =>
    Promise.resolve(`listener-join-failed-event:${String(includePauseIds)}`),
}));
vi.mock("../../src/app/pause-reassigned-events.js", () => ({
  channelReassignedOf: () => "channel-reassigned-event",
  listenerReassignedOf: (_sources: unknown, includePauseIds: boolean) =>
    Promise.resolve(`listener-reassigned-event:${String(includePauseIds)}`),
}));
vi.mock("../../src/app/pause-timeout-events.js", () => ({
  channelTimeoutChangedOf: () => "channel-extended-event",
  listenerTimeoutChangedOf: (_sources: unknown, includePauseIds: boolean) =>
    Promise.resolve(`listener-extended-event:${String(includePauseIds)}`),
}));
vi.mock("../../src/app/pause-notices.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/app/pause-notices.js")>()),
  deliveryIdOf: () => "delivery-1",
  channelClosedOf: (sources: {
    masked: (value: unknown) => Promise<unknown>;
    deliveryId: string;
  }) => {
    seen.sources.push(sources);
    return Promise.resolve("channel-closed-event");
  },
  channelNotTakenOf: () => Promise.resolve("channel-not-taken-event"),
  channelExpiringOf: () => "channel-expiring-event",
  listenerOpenedOf: (_sources: unknown, includePauseIds: boolean) =>
    Promise.resolve(`listener-opened-event:${String(includePauseIds)}`),
  listenerClosedOf: (_sources: unknown, includePauseIds: boolean) =>
    Promise.resolve(`listener-closed-event:${String(includePauseIds)}`),
  listenerNotTakenOf: (_sources: unknown, includePauseIds: boolean) =>
    Promise.resolve(`listener-not-taken-event:${String(includePauseIds)}`),
  listenerExpiringOf: (_sources: unknown, includePauseIds: boolean) =>
    Promise.resolve(`listener-expiring-event:${String(includePauseIds)}`),
}));

beforeEach(() => {
  seen.own = {};
  seen.calls.length = 0;
  seen.sources.length = 0;
});

const PAUSE: PauseRecord = { ...pauseOf("p-1"), kind: PauseKind.Approval };
const noticeOf = (kind: PauseNoticeKind): PauseNotice => ({
  seq: 1,
  kind,
  writtenAt: new Date("2026-11-20T10:00:00.000Z"),
});

/** What told receivers: the hook that ran and the event it got. */
const told: { hook: string; event: unknown }[] = [];
const hookOf = (hook: string) => (event: unknown) => {
  told.push({ hook, event });
  return Promise.resolve(`${hook}-returned`);
};

const HOOKS = {
  onPauseClosed: PauseNoticeKind.Closed,
  onPauseAnswerNotTaken: PauseNoticeKind.AnswerNotTaken,
  onPauseTimeoutChanged: PauseNoticeKind.TimeoutChanged,
  onPauseExpiring: PauseNoticeKind.Expiring,
  onPauseReassigned: PauseNoticeKind.Reassigned,
  onPauseJoinFailed: PauseNoticeKind.JoinFailed,
} as const;

/** A channel sender with exactly the hooks in `names`. */
const senderWith = (names: readonly string[]) =>
  Object.fromEntries(names.map((name) => [name, hookOf(name)]));

function partsOf(listeners: Record<string, { handler: object; includePauseIds: boolean }> = {}) {
  const stop = new AbortController().signal;
  const parts: ReceiveParts = {
    clock: new VirtualClock(),
    interruption: () => stop,
    listenerOf: (name) => listeners[name],
  };
  return { parts, stop };
}

const tell = (
  parts: ReceiveParts,
  recipient: string,
  kind: PauseNoticeKind,
  pause: PauseRecord = PAUSE,
) => receive(parts, {} as never, { recipient, pause, notice: noticeOf(kind) });

beforeEach(() => {
  told.length = 0;
});

describe("#1356: a channel is told the notices it has a hook for", () => {
  it.each(Object.entries(HOOKS))(
    "%s is told for a notice of its kind, with the event of it",
    async (hook, kind) => {
      seen.own = {
        channelOf: () => ({ sender: senderWith(Object.keys(HOOKS)) }),
        tools: () => ({ timeout: seconds(7) }),
      };
      const { parts } = partsOf();

      await tell(parts, "channel:refund", kind);

      expect(told).toEqual([
        {
          hook,
          event: {
            onPauseClosed: "channel-closed-event",
            onPauseAnswerNotTaken: "channel-not-taken-event",
            onPauseTimeoutChanged: "channel-extended-event",
            onPauseReassigned: "channel-reassigned-event",
            onPauseExpiring: "channel-expiring-event",
            onPauseJoinFailed: "channel-join-failed-event",
          }[hook],
        },
      ]);
    },
  );

  it("only the hook of the notice's kind runs, however many hooks the sender has", async () => {
    seen.own = {
      channelOf: () => ({ sender: senderWith(["onPauseClosed", "onPauseExpiring"]) }),
      tools: () => ({ timeout: seconds(7) }),
    };
    const { parts } = partsOf();

    await tell(parts, "channel:refund", PauseNoticeKind.Expiring);

    expect(told.map(({ hook }) => hook)).toEqual(["onPauseExpiring"]);
  });

  it("a sender without the hook of the kind is told nothing, and the notice counts as delivered: no call is made", async () => {
    seen.own = {
      channelOf: () => ({ sender: senderWith(["onPauseClosed"]) }),
      tools: () => ({ timeout: seconds(7) }),
    };
    const { parts } = partsOf();

    for (const kind of [
      PauseNoticeKind.AnswerNotTaken,
      PauseNoticeKind.TimeoutChanged,
      PauseNoticeKind.Expiring,
      PauseNoticeKind.Reassigned,
      PauseNoticeKind.JoinFailed,
      PauseNoticeKind.Opened,
    ])
      await expect(tell(parts, "channel:refund", kind)).resolves.toBeUndefined();

    expect(told).toEqual([]);
    expect(seen.calls).toEqual([]);
  });

  it("a sender with every hook is told nothing of a kind it has none for: `opened`, and a kind later work adds", async () => {
    seen.own = {
      channelOf: () => ({ sender: senderWith(Object.keys(HOOKS)) }),
      tools: () => ({ timeout: seconds(7) }),
    };
    const { parts } = partsOf();

    await tell(parts, "channel:refund", PauseNoticeKind.Opened);
    await tell(parts, "channel:refund", "later-kind" as PauseNoticeKind);

    expect(told).toEqual([]);
  });

  it("what a hook rejects with is what the notice rejects with: a failure is never swallowed", async () => {
    seen.own = {
      channelOf: () => ({
        sender: Object.fromEntries(
          Object.keys(HOOKS).map((name) => [
            name,
            () => Promise.reject(new Error(`${name} failed`)),
          ]),
        ),
      }),
      tools: () => ({ timeout: seconds(7) }),
    };
    const { parts } = partsOf();

    for (const [hook, kind] of Object.entries(HOOKS))
      await expect(tell(parts, "channel:refund", kind)).rejects.toThrow(`${hook} failed`);
  });

  it("a hook that returns nothing is told, and what it returns is what the call gives", async () => {
    const closed: unknown[] = [];
    seen.own = {
      channelOf: () => ({
        sender: {
          onPauseClosed: (event: unknown) => {
            closed.push(event);
          },
          onPauseTimeoutChanged: () => undefined,
          onPauseExpiring: () => undefined,
          onPauseReassigned: () => undefined,
          onPauseJoinFailed: () => undefined,
          onPauseAnswerNotTaken: () => undefined,
        },
      }),
      tools: () => ({ timeout: seconds(7) }),
    };
    const { parts } = partsOf();

    for (const kind of Object.values(HOOKS))
      await expect(tell(parts, "channel:refund", kind)).resolves.toBeUndefined();

    expect(closed).toEqual(["channel-closed-event"]);
  });

  it("is called in the pause's frame with the instance's stop, under the tool's timeout for an approval and the default for a question", async () => {
    seen.own = {
      channelOf: () => ({ sender: senderWith(["onPauseClosed"]) }),
      tools: (tool: string) => ({ timeout: tool === "charge" ? seconds(7) : seconds(1) }),
    };
    const { parts, stop } = partsOf();

    await tell(parts, "channel:refund", PauseNoticeKind.Closed);
    await tell(parts, "channel:refund", PauseNoticeKind.Closed, {
      ...questionPauseOf("p-q"),
      kind: PauseKind.ExternalTask,
    });

    expect(seen.calls[0]).toMatchObject({ timeout: 7000, frame: "frame", interruption: stop });
    expect(seen.calls[1]?.timeout).toBe(30_000);
  });

  it("an event is built from the notice with the delivery id and a masking of its values: none without a policy, the policy's with one", async () => {
    seen.own = {
      channelOf: () => ({ sender: senderWith(["onPauseClosed"]) }),
      tools: () => ({ timeout: seconds(7) }),
    };
    const { parts } = partsOf();

    await tell(parts, "channel:refund", PauseNoticeKind.Closed);
    const unmasked = seen.sources[0];
    expect(unmasked?.deliveryId).toBe("delivery-1");
    expect(await unmasked?.masked({ card: "4111" })).toEqual({ card: "4111" });

    seen.own = {
      ...seen.own,
      pii: { observability: { value: (value: unknown) => Promise.resolve({ masked: value }) } },
    };
    await tell(parts, "channel:refund", PauseNoticeKind.Closed);
    expect(await seen.sources[1]?.masked({ card: "4111" })).toEqual({ masked: { card: "4111" } });
  });

  it("a channel the application has not is refused, named; so is any when it has no channels at all", async () => {
    seen.own = { channelOf: () => undefined, tools: () => ({ timeout: seconds(7) }) };
    const { parts } = partsOf();

    await expect(tell(parts, "channel:gone", PauseNoticeKind.Closed)).rejects.toThrow(
      UnknownReceiverError,
    );
    await expect(tell(parts, "channel:gone", PauseNoticeKind.Closed)).rejects.toThrow(
      "no channel gone",
    );
    seen.own = { tools: () => ({ timeout: seconds(7) }) };
    await expect(tell(parts, "channel:gone", PauseNoticeKind.Closed)).rejects.toThrow(
      "no channel gone",
    );
    expect(new UnknownReceiverError("x").name).toBe("UnknownReceiverError");
  });
});

describe("#1356: a listener is told the notices it has a method for", () => {
  const handlerWith = (names: readonly string[]) =>
    Object.fromEntries(names.map((name) => [name, hookOf(name)]));
  const ALL = [
    "onPauseOpened",
    "onPauseClosed",
    "onPauseAnswerNotTaken",
    "onPauseTimeoutChanged",
    "onPauseExpiring",
    "onPauseReassigned",
    "onPauseJoinFailed",
  ];

  it.each([
    ["onPauseOpened", PauseNoticeKind.Opened, "listener-opened-event"],
    ["onPauseClosed", PauseNoticeKind.Closed, "listener-closed-event"],
    ["onPauseAnswerNotTaken", PauseNoticeKind.AnswerNotTaken, "listener-not-taken-event"],
    ["onPauseTimeoutChanged", PauseNoticeKind.TimeoutChanged, "listener-extended-event"],
    ["onPauseExpiring", PauseNoticeKind.Expiring, "listener-expiring-event"],
    ["onPauseReassigned", PauseNoticeKind.Reassigned, "listener-reassigned-event"],
    ["onPauseJoinFailed", PauseNoticeKind.JoinFailed, "listener-join-failed-event"],
  ])(
    "%s is told for a %s notice, with the event of it, and whether the listener may answer",
    async (hook, kind, event) => {
      seen.own = {};
      for (const includePauseIds of [true, false]) {
        told.length = 0;
        const { parts } = partsOf({
          metrics: { handler: handlerWith(ALL), includePauseIds },
        });

        await tell(parts, "listener:metrics", kind);

        expect(told).toEqual([{ hook, event: `${event}:${String(includePauseIds)}` }]);
      }
    },
  );

  it("a listener without the optional method of a kind is told nothing, and the notice counts as delivered", async () => {
    seen.own = {};
    const { parts } = partsOf({
      metrics: { handler: handlerWith(["onPauseOpened", "onPauseClosed"]), includePauseIds: false },
    });

    for (const kind of [
      PauseNoticeKind.AnswerNotTaken,
      PauseNoticeKind.TimeoutChanged,
      PauseNoticeKind.Expiring,
      PauseNoticeKind.Reassigned,
      PauseNoticeKind.JoinFailed,
    ])
      await expect(tell(parts, "listener:metrics", kind)).resolves.toBeUndefined();

    expect(told).toEqual([]);
    expect(seen.calls).toEqual([]);
  });

  it("a listener with every method is told nothing of a kind later work adds", async () => {
    seen.own = {};
    const { parts } = partsOf({
      metrics: { handler: handlerWith(ALL), includePauseIds: false },
    });

    await tell(parts, "listener:metrics", "later-kind" as PauseNoticeKind);

    expect(told).toEqual([]);
  });

  it("what a method rejects with is what the notice rejects with: a failure is never swallowed", async () => {
    seen.own = {};
    const failing = Object.fromEntries(
      ALL.map((name) => [name, () => Promise.reject(new Error(`${name} failed`))]),
    );
    const { parts } = partsOf({ metrics: { handler: failing, includePauseIds: false } });

    for (const [hook, kind] of [
      ["onPauseOpened", PauseNoticeKind.Opened],
      ["onPauseClosed", PauseNoticeKind.Closed],
      ["onPauseAnswerNotTaken", PauseNoticeKind.AnswerNotTaken],
      ["onPauseTimeoutChanged", PauseNoticeKind.TimeoutChanged],
      ["onPauseExpiring", PauseNoticeKind.Expiring],
      ["onPauseReassigned", PauseNoticeKind.Reassigned],
      ["onPauseJoinFailed", PauseNoticeKind.JoinFailed],
    ] as const)
      await expect(tell(parts, "listener:metrics", kind)).rejects.toThrow(`${hook} failed`);
  });

  it("a method that returns nothing is told too, and its answer is what the call gives", async () => {
    seen.own = {};
    const optional = [
      "onPauseAnswerNotTaken",
      "onPauseTimeoutChanged",
      "onPauseExpiring",
      "onPauseReassigned",
      "onPauseJoinFailed",
    ];
    const { parts } = partsOf({
      metrics: {
        handler: {
          onPauseOpened: () => Promise.resolve(),
          onPauseClosed: () => Promise.resolve(),
          ...Object.fromEntries(optional.map((name) => [name, () => undefined])),
        },
        includePauseIds: false,
      },
    });

    for (const kind of [
      PauseNoticeKind.AnswerNotTaken,
      PauseNoticeKind.TimeoutChanged,
      PauseNoticeKind.Expiring,
      PauseNoticeKind.Reassigned,
      PauseNoticeKind.JoinFailed,
    ])
      await expect(tell(parts, "listener:metrics", kind)).resolves.toBeUndefined();
  });

  it("is told under the default timeout, and a listener the application has not is refused, named with its colons", async () => {
    seen.own = {};
    const { parts } = partsOf({
      "team:ops": { handler: handlerWith(ALL), includePauseIds: false },
    });

    await tell(parts, "listener:team:ops", PauseNoticeKind.Closed);
    expect(seen.calls[0]?.timeout).toBe(30_000);
    await expect(tell(parts, "listener:team:gone", PauseNoticeKind.Closed)).rejects.toThrow(
      "no listener team:gone",
    );
  });
});

describe("#1310c: a @ChannelListener's hooks are each optional, and a deadline that moved is onPauseTimeoutChanged", () => {
  const handlerWith = (names: readonly string[]) =>
    Object.fromEntries(names.map((name) => [name, hookOf(name)]));

  it("a listener with onPauseExpiring alone is told the reminder, and nothing of an opening or a closing", async () => {
    seen.own = {};
    const { parts } = partsOf({
      expiring: { handler: handlerWith(["onPauseExpiring"]), includePauseIds: false },
    });

    await expect(tell(parts, "listener:expiring", PauseNoticeKind.Opened)).resolves.toBeUndefined();
    await expect(tell(parts, "listener:expiring", PauseNoticeKind.Closed)).resolves.toBeUndefined();
    expect(told).toEqual([]);
    expect(seen.calls).toEqual([]);

    await tell(parts, "listener:expiring", PauseNoticeKind.Expiring);
    expect(told).toEqual([{ hook: "onPauseExpiring", event: "listener-expiring-event:false" }]);
  });

  it("a listener with only the opening or only the closing is told that one, with the event of it", async () => {
    seen.own = {};
    const { parts } = partsOf({
      opened: { handler: handlerWith(["onPauseOpened"]), includePauseIds: true },
      closed: { handler: handlerWith(["onPauseClosed"]), includePauseIds: false },
    });

    await tell(parts, "listener:opened", PauseNoticeKind.Opened);
    await tell(parts, "listener:closed", PauseNoticeKind.Closed);

    expect(told).toEqual([
      { hook: "onPauseOpened", event: "listener-opened-event:true" },
      { hook: "onPauseClosed", event: "listener-closed-event:false" },
    ]);
  });

  it("onPauseTimeoutChanged is told for the notice of a moved deadline, with the extension's event", async () => {
    seen.own = {};
    const { parts } = partsOf({
      moved: { handler: handlerWith(["onPauseTimeoutChanged"]), includePauseIds: true },
    });

    await tell(parts, "listener:moved", PauseNoticeKind.TimeoutChanged);

    expect(told).toEqual([
      { hook: "onPauseTimeoutChanged", event: "listener-extended-event:true" },
    ]);
  });

  it("a listener with both names of the hook is told by the old one only, once", async () => {
    seen.own = {};
    const { parts } = partsOf({
      both: {
        handler: handlerWith(["onPauseTimeoutChanged", "onPauseTimeoutChanged"]),
        includePauseIds: false,
      },
    });

    await tell(parts, "listener:both", PauseNoticeKind.TimeoutChanged);

    expect(told.map(({ hook }) => hook)).toEqual(["onPauseTimeoutChanged"]);
  });

  it("a channel with onPauseTimeoutChanged is told the moved deadline, with the extension's event", async () => {
    seen.own = {
      channelOf: () => ({ sender: senderWith(["onPauseTimeoutChanged"]) }),
      tools: () => ({ timeout: seconds(7) }),
    };
    const { parts } = partsOf();

    await tell(parts, "channel:refund", PauseNoticeKind.TimeoutChanged);

    expect(told).toEqual([{ hook: "onPauseTimeoutChanged", event: "channel-extended-event" }]);
  });

  it("a channel with both names of the hook is told by the old one only, once", async () => {
    seen.own = {
      channelOf: () => ({ sender: senderWith(["onPauseTimeoutChanged", "onPauseTimeoutChanged"]) }),
      tools: () => ({ timeout: seconds(7) }),
    };
    const { parts } = partsOf();

    await tell(parts, "channel:refund", PauseNoticeKind.TimeoutChanged);

    expect(told.map(({ hook }) => hook)).toEqual(["onPauseTimeoutChanged"]);
  });
});
