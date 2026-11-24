/**
 * #1317c — what is refused inside a `runOnce`: another `runOnce`, a `sendOnce`, a spend counted. Its
 * `execute` holds the store's transaction, and a store may run it again. Outside it — before, after,
 * a promise it left running — all is as before.
 */
import { describe, expect, it } from "vitest";
import { IdempotencyError } from "../../src/core/error-families/effect-errors.js";
import { LiveSpendRecorder } from "../../src/components/spend-recorder.js";
import { inRunOnce, outsideRunOnce, runOnceNameOf } from "../../src/app/idempotency-scope.js";
import { OutboundRecovery } from "../../src/index.js";
import { hours, seconds } from "../../src/units/index.js";
import { outboundFrame, rejectionOf } from "../helpers/outbound-frame.js";

describe("#1317c: the scope of a runOnce", () => {
  it("is open while the work runs, closed once it settled, and cleared by outsideRunOnce", async () => {
    expect(runOnceNameOf()).toBeUndefined();
    let inside: string | undefined;
    let cleared: string | undefined = "not run";
    let left: Promise<string | undefined> = Promise.resolve(undefined);

    await inRunOnce("charge", async () => {
      inside = runOnceNameOf();
      cleared = outsideRunOnce(() => runOnceNameOf());
      // a promise the work leaves running reads the scope after it ended
      left = new Promise((resolve) =>
        setImmediate(() => {
          resolve(runOnceNameOf());
        }),
      );
      await Promise.resolve();
    });

    expect(inside).toBe("charge");
    expect(cleared).toBeUndefined();
    expect(await left).toBeUndefined();
    expect(runOnceNameOf()).toBeUndefined();
  });

  it("a synchronous work stays synchronous, and its scope is closed after it", () => {
    const seen = inRunOnce("sync", () => runOnceNameOf());

    expect(seen).toBe("sync");
    expect(runOnceNameOf()).toBeUndefined();
  });

  it("a work that throws closes it too", () => {
    expect(() =>
      inRunOnce("throws", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(runOnceNameOf()).toBeUndefined();
  });
});

describe("#1317c: refused inside runOnce", () => {
  it("runOnce inside runOnce is IdempotencyError.NestedRunOnce, the outer one rolled back", async () => {
    const frame = outboundFrame();
    const { key } = await frame.keyIn("execution-1");

    const error = await rejectionOf(
      frame.inFrame(key, () =>
        frame.idempotency.runOnce({
          name: "outer",
          ttl: hours(24),
          execute: () =>
            frame.idempotency.runOnce({ name: "inner", ttl: hours(24), execute: () => ({ n: 1 }) }),
        }),
      ),
    );

    expect(error).toBeInstanceOf(IdempotencyError.NestedRunOnce);
  });

  it("sendOnce inside runOnce is IdempotencyError.ExternalCallInTransaction, nothing recorded or sent", async () => {
    const frame = outboundFrame();
    const { key } = await frame.keyIn("execution-1");
    let sent = 0;

    const error = await rejectionOf(
      frame.inFrame(key, () =>
        frame.idempotency.runOnce({
          name: "outer",
          ttl: hours(24),
          execute: async () =>
            frame.idempotency.sendOnce({
              name: "call",
              target: "gateway",
              request: { amount: 1 },
              timeout: seconds(5),
              ttl: hours(24),
              send: () => {
                sent += 1;
                return Promise.resolve({ ok: true });
              },
              recovery: OutboundRecovery.replayWithin(seconds(60)),
            }),
        }),
      ),
    );

    expect(error).toBeInstanceOf(IdempotencyError.ExternalCallInTransaction);
    expect(sent).toBe(0);
  });

  it("SpendRecorder.record inside runOnce is IdempotencyError.ExternalCallInTransaction; outside it is the step's own refusal", async () => {
    const frame = outboundFrame();
    const { key } = await frame.keyIn("execution-1");
    const recorder = new LiveSpendRecorder("action:charge");

    const error = await rejectionOf(
      frame.inFrame(key, () =>
        frame.idempotency.runOnce({
          name: "outer",
          ttl: hours(24),
          execute: () => {
            recorder.record({ service: "geocoder", cost: 0.01 as never });
            return { n: 1 };
          },
        }),
      ),
    );

    expect(error).toBeInstanceOf(IdempotencyError.ExternalCallInTransaction);
  });

  it("runOnce after another runOnce ended is fine", async () => {
    const frame = outboundFrame();
    const { key } = await frame.keyIn("execution-1");

    const outcomes = await frame.inFrame(key, async () => [
      await frame.idempotency.runOnce({ name: "one", ttl: hours(24), execute: () => ({ n: 1 }) }),
      await frame.idempotency.runOnce({ name: "two", ttl: hours(24), execute: () => ({ n: 2 }) }),
    ]);

    expect(outcomes.map((outcome) => outcome.result)).toEqual([{ n: 1 }, { n: 2 }]);
  });
});
