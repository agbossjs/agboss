/**
 * #500 — the fenced effect in a unit runner: `testAction` / `testTool` give the component the
 * built-in in-memory store on the runner's held lease (token 1, or the `fence` option's), so a
 * step's effect runs, replays on a second call of one runner, and is refused once the lease is lost
 * or past its confirmation.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { ExecutionFencedError, FencedEffectStatus } from "../../../src/index.js";
import { testAction } from "../../../src/testing/index.js";
import { seconds } from "../../../src/units/index.js";
import {
  book,
  ChargeOrderAction,
  resetFencedEffect,
} from "../../app/fixtures/fenced-effect.workflow.js";

beforeEach(resetFencedEffect);

const order = { message: { value: { text: "order-1" } } } as never;

describe("#500: a unit runner's fenced effect", () => {
  it("runs on the runner's held lease (token 1), then replays the receipt on the same step", async () => {
    const run = testAction(ChargeOrderAction);

    const first = await run(order);
    const second = await run(order);

    expect(first.output).toEqual({ chargeId: "charge-order-1-1" });
    expect(second.output).toEqual(first.output);
    expect(book.runs.map((each) => each.status)).toEqual([
      FencedEffectStatus.Ran,
      FencedEffectStatus.Replayed,
    ]);
    expect(book.charges).toHaveLength(1);
  });

  it("runs under the fence option's token", async () => {
    const run = testAction(ChargeOrderAction, { fence: { token: 4 } });

    const { output } = await run(order);

    expect(output).toEqual({ chargeId: "charge-order-1-4" });
    expect(book.charges).toEqual([{ order: "order-1", token: 4, chargeId: "charge-order-1-4" }]);
  });

  it("a lost lease (isLost) refuses the effect: nothing charged", async () => {
    const run = testAction(ChargeOrderAction, { fence: { isLost: true } });

    await expect(run(order)).rejects.toBeInstanceOf(ExecutionFencedError);
    expect(book.charges).toEqual([]);
  });

  it("past the lease's confirmation on the runner's clock the effect is refused", async () => {
    const run = testAction(ChargeOrderAction);
    await run.clock.advance(seconds(30));

    await expect(run(order)).rejects.toBeInstanceOf(ExecutionFencedError);
    expect(book.charges).toEqual([]);
  });
});
