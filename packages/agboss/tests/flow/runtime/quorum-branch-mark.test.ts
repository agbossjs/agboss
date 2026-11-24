import { usd } from "../../../src/units/index.js";
/**
 * #1366: what a branch's answer is marked with when the quorum is decided while its arbiters judge it — no mark, its
 * place in the quorum left and the spend of the arbiters' calls kept; and what happens to the other branches when
 * an answer decides the quorum: they are cancelled, and never when it is not decided.
 */
import { describe, expect, it, vi } from "vitest";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../../src/finops/usage.js";
import { judgeAnswer } from "../../../src/flow/runtime/launch/arbiters.js";
import { cancelIfDecided, markAnswer } from "../../../src/flow/runtime/launch/quorum-branch.js";

vi.mock("../../../src/flow/runtime/launch/arbiters.js", () => ({ judgeAnswer: vi.fn() }));

const record = (costUsd: number): UsageRecord => ({
  ...ZERO_USAGE,
  caller: "arbiter",
  model: "m",
  costUsd: usd(costUsd),
  costSource: CostSource.Api,
});

function liveOf(isDecided: boolean) {
  const controller = new AbortController();
  const left: number[] = [];
  const live = {
    controller,
    quorum: {
      state: {
        leave: (index: number) => {
          left.push(index);
        },
        accept: () => ({ verdict: "accepted", acceptedSequence: 1 }),
        isDecided: () => isDecided,
      },
      stop: new AbortController(),
      queued: undefined,
      withdrawal: { start: () => undefined },
    },
  };
  return { live: live as never, controller, left };
}

const ticket = { index: 3, node: "agent" } as never;
const arbiters = {
  launch: { launch: { arbitratedBy: (() => undefined) as never } },
  deps: {},
} as never;

describe("#1366: the mark of a judged answer", () => {
  it("an answer judged while the quorum was decided is no mark: its place left, the spend of its arbiters kept", async () => {
    const { live, controller, left } = liveOf(false);
    vi.mocked(judgeAnswer).mockImplementation(() => {
      controller.abort();
      return Promise.resolve({ isAccepted: true, rejectedBy: [], usage: [record(0.5)] });
    });

    const marked = await markAnswer(live, ticket, { value: "x" }, arbiters);

    expect(marked).toEqual({ usage: [record(0.5)] });
    expect(left).toEqual([3]);
  });

  it("an answer judged after the quorum was decided is not judged at all", async () => {
    const { live, controller, left } = liveOf(false);
    controller.abort();

    const marked = await markAnswer(live, ticket, { value: "x" }, arbiters);

    expect(marked).toEqual({ usage: [] });
    expect(left).toEqual([3]);
  });
});

describe("#1366: the branches of a decided quorum", () => {
  it("are cancelled once it is decided, and left running while it is not", () => {
    const decided = liveOf(true);
    const open = liveOf(false);

    cancelIfDecided(decided.live);
    cancelIfDecided(open.live);

    expect(decided.controller.signal.aborted).toBe(true);
    expect(open.controller.signal.aborted).toBe(false);
  });
});
