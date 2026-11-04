/**
 * #633 (undo shard) — one automatic undo (`undone`, `undo.ts`) on its own, on a site of its own:
 * an entry with no undo action to run, an undo action that is no action, the observers around it
 * (none listed too), a failure recorded and a fenced write handed over, the holder's fence before
 * it, a clean-up signal a cancel never aborts but a hand-over does — and nothing of it (a timer, a
 * listener) left once the undo returned.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Action, ExecutionCancelledError } from "../../../src/index.js";
import {
  ExecutionFencedError,
  ExecutionLeaseLostError,
  scopeKeyOf,
} from "../../../src/app/lease-lost.js";
import {
  CompensationEntryStatus,
  CompensationReason,
  CompensationStatus,
} from "../../../src/flow/compensation.js";
import { undone, type UndoSite } from "../../../src/flow/runtime/compensation/undo.js";
import { currentFrame } from "../../../src/flow/context/frame.js";
import { HandOverSite } from "../../../src/infrastructure/execution-lease-event.repository.js";
import { VirtualClock } from "../../../src/testing/index.js";
import { seconds, type Milliseconds } from "../../../src/units/index.js";
import { entryOf } from "./fixtures/compensation-entries.js";

/** What the undo action does, set by each test. */
const behaviour = vi.hoisted(() => ({
  run: (_signal: AbortSignal): Promise<unknown> => Promise.resolve(),
  signals: [] as AbortSignal[],
}));

@Action({ name: "cancel-booking-action", description: "Cancels the booking", input: {} })
class CancelBookingAction {
  execute(): Promise<unknown> {
    return Promise.resolve();
  }
}

@Action({
  name: "book-action",
  description: "Books",
  input: {},
  compensateWith: CancelBookingAction,
})
class BookAction {
  execute(): Promise<unknown> {
    return Promise.resolve();
  }
}

@Action({ name: "plain-action", description: "Nothing to undo", input: {} })
class PlainAction {
  execute(): Promise<unknown> {
    return Promise.resolve();
  }
}

@Action({
  name: "odd-action",
  description: "Undone by a class that is no action",
  input: {},
  compensateWith: Object as never,
})
class OddAction {
  execute(): Promise<unknown> {
    return Promise.resolve();
  }
}

/** The undo action's instance: it runs `behaviour.run` on its frame's clean-up signal. */
const runningUndo = {
  execute: () => {
    const signal = currentFrame()?.execution.signal ?? new AbortController().signal;
    behaviour.signals.push(signal);
    return behaviour.run(signal);
  },
};

/** A clock that keeps the signal of every sleep. */
class RecordingClock extends VirtualClock {
  readonly signals: (AbortSignal | undefined)[] = [];

  override sleep(delay: Milliseconds, signal?: AbortSignal): Promise<void> {
    this.signals.push(signal);
    return super.sleep(delay, signal);
  }
}

interface SiteOptions {
  readonly instance?: unknown;
  readonly observer?: UndoSite["observer"];
  readonly signal?: AbortSignal;
  readonly lease?: UndoSite["execution"]["lease"];
  readonly clock?: VirtualClock;
}

function siteOf(options: SiteOptions = {}): UndoSite {
  const nodes = new Map<string, { component: unknown }>([
    ["book-action", { component: BookAction }],
    ["plain-action", { component: PlainAction }],
    ["odd-action", { component: OddAction }],
    ["not-an-action", { component: Object }],
  ]);
  const instance = "instance" in options ? options.instance : runningUndo;
  const site: UndoSite = {
    graph: { nodes } as never,
    container: { get: () => instance as never },
    components: new Map(),
    observer: options.observer,
    execution: {
      executionId: "root-1",
      threadId: "thread-1",
      ownerId: undefined,
      signal: options.signal ?? new AbortController().signal,
      workflow: { name: "desk-workflow", version: "1.0.0", startedVersion: "1.0.0" },
      tenant: { tenantId: "acme" },
      values: {},
      lease: options.lease,
    } as never,
    clock: options.clock ?? new VirtualClock(),
    timeout: seconds(15),
    stepEntries: undefined,
    reason: CompensationReason.ExecutionFailed,
  };
  return site;
}

const BOOKED = entryOf("root-1:book-action:1", {
  action: "book-action",
  compensator: "cancel-booking-action",
});

/** An observer that records each hook it gets, with the event. */
function observerOf() {
  const seen: [string, Record<string, unknown>][] = [];
  const hook = (name: string) => (event: Record<string, unknown>) => {
    seen.push([name, event]);
    return Promise.resolve();
  };
  const observer = {
    onCompensationStart: hook("onCompensationStart"),
    onActionStart: hook("onActionStart"),
    onActionEnd: hook("onActionEnd"),
    onCompensationEnd: hook("onCompensationEnd"),
  };
  return { seen, observer: observer as never };
}

beforeEach(() => {
  behaviour.run = () => Promise.resolve(undefined);
  behaviour.signals.length = 0;
});

describe("#633: what an entry is undone by", () => {
  it.each([
    ["an action no node of the graph has", "unknown-action"],
    ["a node that is no action", "not-an-action"],
    ["an action without compensateWith", "plain-action"],
    ["an action whose compensateWith is no action", "odd-action"],
  ])("%s: a TypeError naming the action", async (_case, action) => {
    const entry = { ...BOOKED, action };

    await expect(undone(entry, siteOf())).rejects.toThrow(
      new TypeError(`${action} has no compensateWith action to undo it`),
    );
  });

  it.each([
    ["null", null],
    ["an object without execute", {}],
    ["an object whose execute is no function", { execute: "run" }],
    ["a function with an execute method", Object.assign(() => undefined, { execute: () => 1 })],
  ])(
    "an undo action instance that is %s: a TypeError naming the undo action",
    async (_c, instance) => {
      await expect(undone(BOOKED, siteOf({ instance }))).rejects.toThrow(
        new TypeError("cancel-booking-action has no execute(input)"),
      );
    },
  );
});

describe("#633: the undo's events and its record", () => {
  it("no observer listed: the undo runs and is recorded", async () => {
    const ran = await undone(BOOKED, siteOf({ observer: undefined }));

    expect(ran.entry.status).toBe(CompensationEntryStatus.Closed);
    expect(ran.entry.undo).not.toHaveProperty("error");
    expect(ran.entry.undo?.status).toBe(CompensationStatus.Compensated);
  });

  it("an undo that returned: start, the action's start and end with its update, its end", async () => {
    behaviour.run = () => Promise.resolve({ cancelled: true });
    const { seen, observer } = observerOf();

    await undone(BOOKED, siteOf({ observer }));

    expect(seen.map(([name]) => name)).toEqual([
      "onCompensationStart",
      "onActionStart",
      "onActionEnd",
      "onCompensationEnd",
    ]);
    expect(seen[2]?.[1]).toMatchObject({
      name: "cancel-booking-action",
      update: { cancelled: true },
    });
    expect(seen[3]?.[1]).toMatchObject({ status: CompensationStatus.Compensated });
    expect(seen[3]?.[1]).not.toHaveProperty("error");
  });

  it("an undo that threw: no action end, its end Failed with the error, the record Failed", async () => {
    behaviour.run = () => Promise.reject(new Error("desk down"));
    const { seen, observer } = observerOf();

    const ran = await undone(BOOKED, siteOf({ observer }));

    expect(seen.map(([name]) => name)).not.toContain("onActionEnd");
    expect(seen.at(-1)?.[1]).toMatchObject({
      status: CompensationStatus.Failed,
      error: { message: "desk down" },
    });
    expect(ran.entry.undo).toMatchObject({
      status: CompensationStatus.Failed,
      error: { message: "desk down" },
    });
  });

  it("a fenced write of the undo: a hand-over, thrown as it is — never a failed undo", async () => {
    const fenced = new ExecutionFencedError({
      scopeKey: scopeKeyOf("acme", "root-1"),
      token: 1,
      observedToken: 2,
    });
    behaviour.run = () => Promise.reject(new Error("driver", { cause: fenced }));
    const { seen, observer } = observerOf();

    await expect(undone(BOOKED, siteOf({ observer }))).rejects.toBe(fenced);
    expect(seen.map(([name]) => name)).not.toContain("onCompensationEnd");
  });
});

describe("#633: the holder's fence before the undo", () => {
  it("past its lease: the lease's loss thrown and recorded as a hand-over at the undo", async () => {
    const run = new AbortController();
    const lost = new ExecutionLeaseLostError("root-1");
    const recordHandOver = vi.fn();
    const lease = {
      scopeKey: scopeKeyOf("acme", "root-1"),
      recordHandOver,
      assertHeld: () => {
        run.abort(lost);
        throw new Error("expired here");
      },
    };

    await expect(
      undone(BOOKED, siteOf({ signal: run.signal, lease: lease as never })),
    ).rejects.toBe(lost);
    expect(recordHandOver).toHaveBeenCalledWith(
      expect.objectContaining({ error: lost, site: HandOverSite.Compensation }),
    );
  });

  it("a fence that throws for another reason: thrown as it is, no hand-over recorded", async () => {
    const recordHandOver = vi.fn();
    const broken = new Error("store unreachable");
    const lease = {
      scopeKey: scopeKeyOf("acme", "root-1"),
      recordHandOver,
      assertHeld: () => {
        throw broken;
      },
    };

    await expect(undone(BOOKED, siteOf({ lease: lease as never }))).rejects.toBe(broken);
    expect(recordHandOver).not.toHaveBeenCalled();
  });
});

describe("#633: the undo's clean-up signal", () => {
  it("the execution cancelled: the undo's signal goes on", async () => {
    const run = new AbortController();
    run.abort(new ExecutionCancelledError("cancelled"));

    await undone(BOOKED, siteOf({ signal: run.signal }));

    expect(behaviour.signals.map((signal) => signal.aborted)).toEqual([false]);
  });

  it("its lease lost before the undo: the undo runs on an aborted signal, then hands over", async () => {
    const run = new AbortController();
    const lost = new ExecutionLeaseLostError("root-1");
    run.abort(lost);

    await expect(undone(BOOKED, siteOf({ signal: run.signal }))).rejects.toBe(lost);
    expect(behaviour.signals.map((signal) => signal.aborted)).toEqual([true]);
  });

  it("returned: its timer ended, and a later loss of the lease no longer reaches its signal", async () => {
    const clock = new RecordingClock();
    const run = new AbortController();

    await undone(BOOKED, siteOf({ signal: run.signal, clock }));
    run.abort(new ExecutionLeaseLostError("root-1"));

    expect(clock.signals.every((signal) => signal?.aborted === true)).toBe(true);
    expect(behaviour.signals.map((signal) => signal.aborted)).toEqual([false]);
  });
});
