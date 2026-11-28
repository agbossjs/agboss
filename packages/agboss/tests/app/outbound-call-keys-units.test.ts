/**
 * #1356 (mutation shard `fencing-effects`): what a call's key and the stores under it do, each on its own over the
 * in-memory stores of `outboundFrame` — a business key's handle and its refusals, the scope of a runOnce, the secrets
 * a key digest needs, a rotation of the idempotency secret (what an in-memory store stored under the previous digest
 * is found again), the expiry an intent claimed again loses, the writes an in-memory effect buffers and a page's limit.
 */
import { describe, expect, it, vi } from "vitest";
import { callKeyIn } from "../../src/app/idempotency-keys.js";
import { inRunOnce, outsideRunOnce, runOnceNameOf } from "../../src/app/idempotency-scope.js";
import { OutboundCallSendStatus } from "../../src/app/outbound-call-types.js";
import { ConfigError } from "../../src/core/error-families/config-errors.js";
import { IdempotencyError } from "../../src/core/error-families/effect-errors.js";
import { FENCE } from "../../src/flow/context/execution-fence.js";
import { runInFrame, type FrameSpec } from "../../src/flow/context/frame.js";
import {
  businessKeyDigestsOf,
  callKeyDigestOf,
  shortKeyOf,
} from "../../src/infrastructure/business-key-digest.js";
import { businessKeyHashOf } from "../../src/infrastructure/fenced-effect-key.js";
import { IdempotencyRunStatus } from "../../src/infrastructure/fenced-effect.repository.js";
import {
  inEffectWrites,
  onEffectCommit,
} from "../../src/infrastructure/in-memory-effect-writes.js";
import {
  DEFAULT_OUTBOUND_CALL_PAGE,
  pageLimitOf,
} from "../../src/infrastructure/outbound-call-pages.js";
import { OutboundRecovery } from "../../src/index.js";
import { hours, seconds } from "../../src/units/index.js";
import { testFrame } from "../helpers/frame.js";
import { lookupKeyOf, outboundFrame } from "../helpers/outbound-frame.js";

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await new Promise<void>((r) => setImmediate(r));
};

const frameWith = (keys: {
  correlationKey?: string;
  fingerprintKeys?: { current: string; previous?: string };
}): FrameSpec => {
  const frame = testFrame();
  return { ...frame, execution: { ...frame.execution, ...keys } };
};

const contextOf = () =>
  ({
    executionId: "execution-1",
    root: { executionId: "execution-1" },
    step: {
      nodeId: "charge-action",
      visitNumber: 1,
      idempotencyKey: "execution-1:charge-action:1",
    },
    [FENCE]: {
      scopeKey: "default:execution-1",
      tenantId: "default",
      leaseExecutionId: "execution-1",
      token: 1,
    },
  }) as never;

describe("#1317d: the key of an Idempotency call", () => {
  it("under a business key and a PII key it carries the key's handle, the one businessKeyHashOf gives", async () => {
    const frame = frameWith({
      correlationKey: "pii-key",
      fingerprintKeys: { current: "secret" },
    });

    const [key, handle] = await runInFrame(frame, () =>
      Promise.resolve([
        callKeyIn(contextOf(), "charge", { key: "order:42", expiresAt: null }, "sendOnce"),
        businessKeyHashOf("order:42"),
      ] as const),
    );

    expect(handle).toMatch(/^[0-9a-f]{12}$/u);
    expect(key.businessKeyHash).toBe(handle);
  });

  it("with no PII key it has none; a key with a fingerprint or withoutFingerprint but no business key is refused", async () => {
    const frame = frameWith({ fingerprintKeys: { current: "secret" } });

    const key = await runInFrame(frame, () =>
      Promise.resolve(
        callKeyIn(contextOf(), "charge", { key: "order:42", expiresAt: null }, "runOnce"),
      ),
    );
    const refusal = (parts: Record<string, unknown>) =>
      runInFrame(frame, () =>
        Promise.resolve().then(() =>
          callKeyIn(contextOf(), "charge", { expiresAt: null, ...parts }, "runOnce"),
        ),
      ).catch((error: unknown) => error);

    expect(Object.keys(key)).not.toContain("businessKeyHash");
    for (const parts of [{ fingerprint: { a: 1 } }, { withoutFingerprint: true }]) {
      const error = await refusal(parts);
      expect(error).toBeInstanceOf(ConfigError.Option);
      expect((error as Error).message).toBe(
        "Idempotency.runOnce: a fingerprint needs a key: it says what the work under it does — nothing was recorded, run or sent",
      );
    }
  });
});

describe("#1317: the scope of a runOnce, as a continuation of its work sees it", () => {
  const seen = async (work: () => unknown): Promise<unknown[]> => {
    const names: unknown[] = [];
    const later = () =>
      new Promise<void>((resolve) =>
        setImmediate(() => {
          names.push(runOnceNameOf());
          resolve();
        }),
      );
    try {
      const result = work();
      if (result instanceof Promise) await result.catch(() => undefined);
    } catch {
      // the work's own failure is the test's input
    }
    await later();
    return names;
  };

  it("is closed once a synchronous work returned or threw, for what it left behind", async () => {
    const left: Promise<unknown>[] = [];
    const afterReturn = inRunOnce("charge", () => {
      left.push(
        new Promise((resolve) =>
          setImmediate(() => {
            resolve(runOnceNameOf());
          }),
        ),
      );
      return 1;
    });
    expect(afterReturn).toBe(1);
    expect(() =>
      inRunOnce("refund", () => {
        left.push(
          new Promise((resolve) =>
            setImmediate(() => {
              resolve(runOnceNameOf());
            }),
          ),
        );
        throw new Error("the work failed");
      }),
    ).toThrow("the work failed");

    expect(await Promise.all(left)).toEqual([undefined, undefined]);
    expect(await seen(() => 0)).toEqual([undefined]);
  });

  it("stays open while an asynchronous work runs, past its awaits, and is closed once it settled", async () => {
    const during: unknown[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = inRunOnce("charge", async () => {
      await Promise.resolve();
      during.push(runOnceNameOf());
      await held;
      during.push(runOnceNameOf());
    });
    await flush();
    expect(during).toEqual(["charge"]);
    release();
    await running;

    expect(during).toEqual(["charge", "charge"]);
    const late = new Promise((resolve) =>
      setImmediate(() => {
        resolve(runOnceNameOf());
      }),
    );
    expect(await late).toBeUndefined();
  });

  it("a work with no runOnce around it, inside one, is outside it", () => {
    const names = inRunOnce("charge", () => [
      runOnceNameOf(),
      outsideRunOnce(() => runOnceNameOf()),
      outsideRunOnce(() => "its own result"),
    ]);

    expect(names).toEqual(["charge", undefined, "its own result"]);
  });
});

describe("#1317d: the digests of a key need the execution's idempotency secrets", () => {
  it("none outside a step, none in a step that has none: SecretKeyMissing naming the effect", async () => {
    const outside = () => {
      try {
        businessKeyDigestsOf("charge", "order:42");
      } catch (error) {
        return error;
      }
      return undefined;
    };
    const outsideCall = () => {
      try {
        callKeyDigestOf({ tenantId: "t", name: "pay", idempotencyKey: "k" });
      } catch (error) {
        return error;
      }
      return undefined;
    };

    for (const run of [outside, outsideCall]) {
      expect(run()).toBeInstanceOf(IdempotencyError.SecretKeyMissing);
      const inFrame = await runInFrame(frameWith({}), () => Promise.resolve(run()));
      expect(inFrame).toBeInstanceOf(IdempotencyError.SecretKeyMissing);
    }
    expect((outside() as Error).message).toContain('"charge" is under a key');
    expect((outsideCall() as Error).message).toContain('"pay" is under a key');
  });

  it("a short key is a prefix of 16 to 43 characters, a whole number; anything else is none", () => {
    const key = "k".repeat(43);

    expect(shortKeyOf(key, 16)).toBe("k".repeat(16));
    expect(shortKeyOf(key, 43)).toBe(key);
    for (const length of [15, 44, 20.5, "20", undefined, Number.NaN, null])
      expect(shortKeyOf(key, length)).toBeUndefined();
  });
});

describe("#1317d: a rotation of the idempotency secret over the in-memory stores", () => {
  it("a call completed under the previous secret replays under the new one: nothing is sent again", async () => {
    const frame = outboundFrame({ fingerprintKeys: { current: "before" } });
    const { key } = await frame.keyIn("execution-1");
    const send = vi.fn(() => Promise.resolve({ ok: true }));
    const call = {
      target: "gateway",
      request: { amount: 1 },
      send,
      recovery: OutboundRecovery.permanentLookup(() => Promise.reject(new Error("not asked"))),
    } as never;
    await frame.send(key, call);

    frame.rotateTo({ current: "after", previous: "before" });
    const again = await frame.send(key, call);

    expect(again).toMatchObject({ status: OutboundCallSendStatus.Replayed });
    expect(send).toHaveBeenCalledOnce();
  });

  it("an effect run under the previous secret replays under the new one: execute is not called again", async () => {
    const frame = outboundFrame({ fingerprintKeys: { current: "before" } });
    const { key } = await frame.keyIn("execution-1");
    const run = (execute: () => number) =>
      frame.inFrame(key, () =>
        frame.idempotency.runOnce({
          name: "book",
          key: "order:42",
          fingerprint: { room: 1 },
          ttl: hours(24),
          execute,
        }),
      );
    const first = vi.fn(() => 7);
    const second = vi.fn(() => 8);

    expect(await run(first)).toMatchObject({ status: IdempotencyRunStatus.Ran, result: 7 });
    frame.rotateTo({ current: "after", previous: "before" });
    const again = await run(second);

    expect(again).toMatchObject({ status: IdempotencyRunStatus.Replayed, result: 7 });
    expect(second).not.toHaveBeenCalled();
  });

  it("a call that has no business key is found by its own row: no previous digest is looked for", async () => {
    const frame = outboundFrame();
    const { key } = await frame.keyIn("execution-1");
    const send = vi.fn(() => Promise.resolve({ ok: true }));
    const call = {
      target: "gateway",
      request: { amount: 1 },
      send,
      recovery: OutboundRecovery.permanentLookup(() => Promise.reject(new Error("not asked"))),
    } as never;

    await frame.send(key, call);
    const again = await frame.send(key, call);

    expect(again).toMatchObject({ status: OutboundCallSendStatus.Replayed });
    expect(send).toHaveBeenCalledOnce();
  });
});

describe("#1317: an intent claimed for a new attempt has no expiry until it ends", () => {
  it("a definite failure ends the intent with an expiry; the retry that claims it again is pending and never swept", async () => {
    const frame = outboundFrame();
    const { key } = await frame.keyIn("execution-1");
    const recovery = OutboundRecovery.permanentLookup(() => Promise.reject(new Error("not asked")));
    await frame
      .send(key, {
        target: "gateway",
        request: { amount: 1 },
        send: () => Promise.reject(new Error("refused")),
        isDefiniteFailure: () => true,
        recovery,
      } as never)
      .catch(() => undefined);
    const hold = new Promise<never>(() => undefined);
    void frame
      .send(key, {
        target: "gateway",
        request: { amount: 1 },
        send: () => hold,
        recovery,
        timeout: seconds(5),
      } as never)
      .catch(() => undefined);
    await flush();

    const removed = await frame.store.deleteExpired(
      new Date(frame.clock.now().getTime() + hours(24 * 365)),
    );

    expect(removed).toBe(0);
    expect(await frame.store.findByKey(lookupKeyOf(key))).toBeDefined();
    // "a pending intent has no entry" (`InMemoryDatabase.outboundCallExpiries`): the claim removed it, never set it to nothing
    const database = Reflect.get(frame.store, "database") as {
      outboundCallExpiries: Map<string, unknown>;
    };
    expect(database.outboundCallExpiries.size).toBe(0);
  });
});

describe("#1317c: the writes of an in-memory effect", () => {
  it("are applied at once when no effect is running, and held until it commits when one is", () => {
    const applied: string[] = [];
    onEffectCommit(() => applied.push("at once"));
    const buffer = inEffectWrites();

    buffer.run(() => {
      onEffectCommit(() => applied.push("held"));
    });

    expect(applied).toEqual(["at once"]);
    expect(buffer.writes).toHaveLength(1);
  });
});

describe("#825: a page's limit", () => {
  it("is the default one when left out, a whole number from 1 as given, else a RangeError", () => {
    expect(pageLimitOf(undefined)).toBe(DEFAULT_OUTBOUND_CALL_PAGE);
    expect(DEFAULT_OUTBOUND_CALL_PAGE).toBe(100);
    expect(pageLimitOf(1)).toBe(1);
    expect(pageLimitOf(250)).toBe(250);
    for (const limit of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2])
      expect(() => pageLimitOf(limit)).toThrow(RangeError);
  });
});
