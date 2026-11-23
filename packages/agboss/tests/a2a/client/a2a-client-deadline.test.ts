/**
 * #1366: when an A2A call's wait ends at the latest — the earlier of the execution's deadline and the call's own
 * timeout, whichever of them is given; none without either, and a deadline that is no date is none.
 */
import { describe, expect, it } from "vitest";
import { deadlineOf } from "../../../src/a2a/client/a2a-client-options.js";
import { runInFrame } from "../../../src/flow/context/frame.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { seconds } from "../../../src/units/index.js";
import { testFrame } from "../../helpers/frame.js";

const clock = new VirtualClock();
const NOW = clock.now().getTime();

/** The deadline of a call with `timeout` inside an execution whose own deadline is `at` (none without). */
function deadlineWith(
  at: string | undefined,
  timeout: number | undefined,
): Promise<Date | undefined> {
  const frame = testFrame();
  const execution =
    at === undefined ? frame.execution : { ...frame.execution, deadline: { at, deadline: 1 } };
  return runInFrame({ ...frame, execution } as never, () =>
    Promise.resolve(deadlineOf(clock, { timeout } as never)),
  );
}

describe("#1366: the end of an A2A call's wait", () => {
  it("is the execution's deadline when it is the earlier, the call's timeout when that is", async () => {
    const soon = new Date(NOW + seconds(10)).toISOString();
    const late = new Date(NOW + seconds(100)).toISOString();

    expect((await deadlineWith(soon, seconds(60)))?.getTime()).toBe(NOW + seconds(10));
    expect((await deadlineWith(late, seconds(60)))?.getTime()).toBe(NOW + seconds(60));
  });

  it("is the one given when only one of them is", async () => {
    const soon = new Date(NOW + seconds(10)).toISOString();

    expect((await deadlineWith(soon, undefined))?.getTime()).toBe(NOW + seconds(10));
    expect((await deadlineWith(undefined, seconds(60)))?.getTime()).toBe(NOW + seconds(60));
  });

  it("is none without either, and a deadline that is no date counts for nothing", async () => {
    expect(await deadlineWith(undefined, undefined)).toBeUndefined();
    expect((await deadlineWith("not a date", seconds(60)))?.getTime()).toBe(NOW + seconds(60));
    expect(await deadlineWith("not a date", undefined)).toBeUndefined();
  });
});
