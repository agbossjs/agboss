/**
 * #1366: a quorum's entry made from a launch's ticket — closed (and its launch aborted, its pauses withdrawn) at once
 * when the ticket's deadline has passed, closed when the deadline falls while the entry is watched (its launch aborted;
 * the pauses withdrawn only while a branch of the pass runs), never closed without a deadline; a failure to read the
 * finished branches fails `ready` and is never an unhandled rejection; an answer without a value is judged as such.
 */
import { describe, expect, it, vi } from "vitest";
import { judgeAnswer } from "../../../../src/flow/runtime/launch/arbiters.js";
import { quorumMakerOf, markAnswer } from "../../../../src/flow/runtime/launch/quorum-branch.js";
import { QuorumKind } from "../../../../src/flow/ast.js";
import { VirtualClock } from "../../../../src/testing/clock.js";
import { seconds } from "../../../../src/units/index.js";

vi.mock("../../../../src/flow/runtime/launch/arbiters.js", () => ({ judgeAnswer: vi.fn() }));

function siteOf(
  clock: VirtualClock,
  deadlineAt: number | undefined,
  pending?: () => Promise<never[]>,
) {
  const withdrawn = { count: 0 };
  const site = {
    launch: { quorum: { kind: QuorumKind.Count, min: 1, max: 2 }, groups: [] },
    ticket: { branches: [{ node: "a" }, { node: "b" }], deadlineAt },
    clock,
    pending: pending ?? (() => Promise.resolve([])),
    withdraw: () => {
      withdrawn.count += 1;
      return Promise.resolve();
    },
  };
  const make = quorumMakerOf(site as never);
  if (make === undefined) throw new Error("no quorum");
  const controller = new AbortController();
  const quorum = make(controller);
  if (quorum === undefined) throw new Error("no entry");
  return { quorum, controller, withdrawn };
}

describe("#1366: a quorum entry whose deadline has passed", () => {
  it("is closed and its launch aborted and its pauses withdrawn as it is made", async () => {
    const clock = new VirtualClock();
    const { quorum, controller, withdrawn } = siteOf(clock, clock.now().getTime() - 1);

    await quorum.ready;

    expect(quorum.state.isDecided()).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(withdrawn.count).toBe(1);
  });

  it("is closed when the deadline is the very moment", async () => {
    const clock = new VirtualClock();
    const { quorum, controller, withdrawn } = siteOf(clock, clock.now().getTime());

    await quorum.ready;

    expect(quorum.state.isDecided()).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(withdrawn.count).toBe(1);
  });
});

describe("#1366: a quorum entry watched on the clock", () => {
  it("is closed and its launch aborted when the deadline falls, not before", async () => {
    const clock = new VirtualClock();
    const { quorum, controller } = siteOf(clock, clock.now().getTime() + seconds(10));
    await quorum.ready;

    await clock.advance(seconds(9));
    expect(quorum.state.isDecided()).toBe(false);
    expect(controller.signal.aborted).toBe(false);
    await clock.advance(seconds(2));

    expect(quorum.state.isDecided()).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  it("withdraws the pauses at the deadline while a branch of the pass runs", async () => {
    const clock = new VirtualClock();
    const { quorum, withdrawn } = siteOf(clock, clock.now().getTime() + seconds(10));
    await quorum.ready;
    let during = -1;

    await quorum.withdrawal.during(async () => {
      await clock.advance(seconds(11));
      during = withdrawn.count;
    });

    expect(during).toBe(1);
    expect(withdrawn.count).toBe(1);
  });

  it("leaves the pauses to the next pass when the deadline falls while no branch runs", async () => {
    const clock = new VirtualClock();
    const { quorum, controller, withdrawn } = siteOf(clock, clock.now().getTime() + seconds(10));
    await quorum.ready;

    await clock.advance(seconds(11));

    expect(controller.signal.aborted).toBe(true);
    expect(withdrawn.count).toBe(0);
  });

  it("without a deadline is never closed by the clock", async () => {
    const clock = new VirtualClock();
    const sleeps = vi.spyOn(clock, "sleep");
    const { quorum, controller } = siteOf(clock, undefined);
    await quorum.ready;
    expect(sleeps).not.toHaveBeenCalled(); // no timer is started for a deadline that does not exist

    await clock.advance(seconds(100_000));

    expect(quorum.state.isDecided()).toBe(false);
    expect(controller.signal.aborted).toBe(false);
  });
});

describe("#1366: a quorum entry whose finished branches cannot be read", () => {
  it("fails its ready and leaves no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listener);
    try {
      const clock = new VirtualClock();
      const { quorum } = siteOf(clock, undefined, () => Promise.reject(new Error("store down")));
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(unhandled).toEqual([]);
      await expect(quorum.ready).rejects.toThrow(Error);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });
});

describe("#1366: an answer without a value under arbiters", () => {
  it("is judged with no answer, not thrown at", async () => {
    vi.mocked(judgeAnswer).mockResolvedValue({ isAccepted: false, rejectedBy: ["x"], usage: [] });
    const live = {
      controller: new AbortController(),
      quorum: {
        state: { leave: () => undefined, accept: () => ({}), isDecided: () => false },
        withdrawal: { start: () => undefined },
      },
    };

    const marked = await markAnswer(live as never, { index: 0, node: "a" } as never, undefined, {
      launch: { launch: { arbitratedBy: (() => undefined) as never } },
      deps: {},
    } as never);

    expect(vi.mocked(judgeAnswer).mock.calls[0]?.[1]).toEqual({ node: "a", answer: undefined });
    expect(marked?.mark?.rejectedBy).toEqual(["x"]);
  });
});
