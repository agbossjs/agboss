/**
 * #509 acceptance corner cases of a test app's bounded close: a close already done wins even a
 * zero bound, a close that fails after the bound gave up is no unhandled rejection, and the error
 * names the instance and the bound.
 */
import { describe, expect, it } from "vitest";
import { closedWithin } from "../../src/testing/bounded-close.js";
import { AppCloseTimeoutError } from "../../src/testing/errors.js";
import { seconds } from "../../src/units/index.js";

describe("#509 acceptance: closedWithin at its edges", () => {
  it("a close already done is awaited as it is, even with a bound of 0 ms", async () => {
    await expect(closedWithin(Promise.resolve(), 1, seconds(0))).resolves.toBeUndefined();
  });

  it("a close that fails after the bound gave up leaves no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    let fail: (error: Error) => void = () => undefined;
    const closing = new Promise<void>((_resolve, reject) => {
      fail = reject;
    });

    await expect(closedWithin(closing, 3, seconds(0.02))).rejects.toBeInstanceOf(
      AppCloseTimeoutError,
    );
    fail(new Error("onStop failed late"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off("unhandledRejection", onUnhandled);

    expect(unhandled).toEqual([]);
  });

  it("the timeout names the instance and the bound in real time", async () => {
    const never = new Promise<void>(() => undefined);

    await expect(closedWithin(never, 7, seconds(0.01))).rejects.toThrow(/instance 7\b.*10 ms/s);
  });
});
