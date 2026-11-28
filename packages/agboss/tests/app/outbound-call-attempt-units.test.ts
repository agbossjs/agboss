/**
 * #1356 (mutation shard `fencing-effects`): one attempt of an outbound call on its own — the bound of its `timeout`
 * on the instance's clock (the attempt's signal ends with it, a timer nobody raced is no unhandled rejection, a
 * finished attempt's timer is stopped), what a timed-out attempt leaves behind (the intent pending and told
 * ambiguous, its owner live until the late answer, that answer stored and told), the pieces a call's keys and
 * stores are made of (a business key's handle, a masked store's default, the writers of a business key), each over the in-memory
 * stores of `outboundFrame`.
 */
import { describe, expect, it, vi } from "vitest";
import { OutboundCallError } from "../../src/core/error-families/outbound-call-errors.js";
import { OutboundMasking } from "../../src/app/outbound-masking.js";
import { sendNow } from "../../src/app/outbound-call-attempt.js";
import { sendOutboundCall } from "../../src/app/outbound-call-protocol.js";
import { OutboundCallSendStatus } from "../../src/app/outbound-call-types.js";
import { businessKeyWriterUseOf } from "../../src/components/container/fenced-reach.js";
import { FencedEffectRepository } from "../../src/infrastructure/fenced-effect.repository.js";
import { InMemoryFencedEffectRepository } from "../../src/infrastructure/in-memory-fenced-effect.repository.js";
import { OutboundCallEventOutcome } from "../../src/infrastructure/execution-audit-log.repository.js";
import { OutboundCallStatus } from "../../src/infrastructure/outbound-call.repository.js";
import { OutboundRecovery } from "../../src/index.js";
import { ExecutionContextUnavailableError } from "../../src/flow/context/errors.js";
import { hours, seconds } from "../../src/units/index.js";
import { lookupKeyOf, outboundFrame } from "../helpers/outbound-frame.js";

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await new Promise<void>((r) => setImmediate(r));
};

const base = (changes: Record<string, unknown> = {}) =>
  ({
    target: "gateway",
    request: { amount: 1 },
    timeout: seconds(5),
    ttl: hours(48),
    send: () => Promise.resolve({ ok: true }),
    recovery: OutboundRecovery.permanentLookup(() => Promise.reject(new Error("not asked"))),
    ...changes,
  }) as never;

/** A send that stays out until the test lets it go, keeping the signal each attempt was given. */
function hangingSend() {
  const signals: AbortSignal[] = [];
  let answer: (value: { ok: boolean }) => void = () => undefined;
  const send = vi.fn((call: { signal: AbortSignal }) => {
    signals.push(call.signal);
    return new Promise<{ ok: boolean }>((resolve) => {
      answer = resolve;
    });
  });
  return {
    send,
    signals,
    answer: (value: { ok: boolean }) => {
      answer(value);
    },
  };
}

describe("#1317: an attempt that passes its timeout", () => {
  it("fails with a TimeoutError naming the call and the bound, aborts the signal the send was given with it, and is told ambiguous", async () => {
    const frame = outboundFrame();
    const { key } = await frame.keyIn("execution-1");
    const gate = hangingSend();

    const first = frame.send(key, base({ send: gate.send })).catch((error: unknown) => error);
    await flush();
    await frame.clock.advance(seconds(6));
    const error = await first;

    expect(error).toMatchObject({
      name: "TimeoutError",
      message: `outbound call "${key.name}" attempt passed its timeout of 5000 ms`,
    });
    expect(gate.signals[0]?.aborted).toBe(true);
    expect(gate.signals[0]?.reason).toBe(error);
    expect(frame.reports.at(-1)).toMatchObject({
      outcome: OutboundCallEventOutcome.Ambiguous,
      status: OutboundCallStatus.Pending,
      attempt: 1,
    });
    expect(
      frame.logger.entries.filter((e) => e.code === "outbound-call.outcome-unknown"),
    ).toHaveLength(1);
  });

  it("a call joined to it meanwhile shares that error and sends nothing itself", async () => {
    const frame = outboundFrame();
    const { key } = await frame.keyIn("execution-1");
    const gate = hangingSend();

    const first = frame.send(key, base({ send: gate.send })).catch((error: unknown) => error);
    const joined = frame.send(key, base({ send: gate.send })).catch((error: unknown) => error);
    await flush();
    await frame.clock.advance(seconds(6));

    const [one, other] = await Promise.all([first, joined]);
    expect(other).toBe(one);
    expect(gate.send).toHaveBeenCalledOnce();
  });

  it("its owner stays live until the late answer: a call after the timeout is refused as in flight, nothing sent again", async () => {
    const frame = outboundFrame();
    const { key } = await frame.keyIn("execution-1");
    const gate = hangingSend();
    const first = frame.send(key, base({ send: gate.send })).catch((error: unknown) => error);
    await flush();
    await frame.clock.advance(seconds(6));
    await first;

    const again = await frame.send(key, base({ send: gate.send })).catch((error: unknown) => error);

    expect(again).toBeInstanceOf(OutboundCallError.InFlight);
    expect(gate.send).toHaveBeenCalledOnce();
  });

  it("its late answer is stored and told sent, nothing superseded; the next call replays it and sends nothing", async () => {
    const frame = outboundFrame();
    const { key } = await frame.keyIn("execution-1");
    const gate = hangingSend();
    const first = frame.send(key, base({ send: gate.send })).catch((error: unknown) => error);
    await flush();
    await frame.clock.advance(seconds(6));
    await first;

    gate.answer({ ok: true });
    await flush();

    expect(frame.reports.at(-1)).toMatchObject({
      outcome: OutboundCallEventOutcome.Sent,
      status: OutboundCallStatus.Completed,
      attempt: 1,
    });
    expect(frame.logger.entries.filter((e) => e.code === "outbound-call.superseded")).toEqual([]);
    const replay = await frame.send(key, base({ send: gate.send }));
    expect(replay).toMatchObject({ status: OutboundCallSendStatus.Replayed });
    expect(gate.send).toHaveBeenCalledOnce();
  });

  it("a step that was aborted first is told and logged nothing of it", async () => {
    const step = new AbortController();
    const frame = outboundFrame({ signal: step.signal });
    const { key } = await frame.keyIn("execution-1");
    const gate = hangingSend();
    const first = frame.send(key, base({ send: gate.send })).catch((error: unknown) => error);
    await flush();

    step.abort(new Error("the step was cancelled"));
    await frame.clock.advance(seconds(6));
    const error = await first;

    expect(error).toMatchObject({ name: "TimeoutError" });
    expect(frame.reports.map((report) => report.outcome)).not.toContain(
      OutboundCallEventOutcome.Ambiguous,
    );
    expect(frame.logger.entries.filter((e) => e.code === "outbound-call.outcome-unknown")).toEqual(
      [],
    );
  });
});

describe("#1317: an attempt that is over stops its timer", () => {
  it("a send that answered in time keeps its signal: the clock passing the timeout later aborts nothing", async () => {
    const frame = outboundFrame();
    const { key } = await frame.keyIn("execution-1");
    const signals: AbortSignal[] = [];

    await frame.send(
      key,
      base({
        send: (call: { signal: AbortSignal }) => {
          signals.push(call.signal);
          return Promise.resolve({ ok: true });
        },
      }),
    );
    await frame.clock.advance(seconds(30));
    await flush();

    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
  });

  it("a send refused before it started (the holder's fence) leaves a timer that raises no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const listen = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listen);
    try {
      const frame = outboundFrame({
        assertHeld: () => {
          throw new Error("the lease was lost");
        },
      });
      const { key } = await frame.keyIn("execution-1");
      const gate = hangingSend();

      const refused = await frame
        .send(key, base({ send: gate.send }))
        .catch((error: unknown) => error);
      await frame.clock.advance(seconds(30));
      await flush();

      expect(refused).toMatchObject({ message: "the lease was lost" });
      expect(gate.send).not.toHaveBeenCalled();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listen);
    }
  });
});

describe("#1317: the parts a call's stores and keys are made of", () => {
  it("a masking setting masks unless it says it need not, and is frozen", () => {
    expect(new OutboundMasking().requiresMask).toBe(true);
    expect(new OutboundMasking({ requiresMask: false }).requiresMask).toBe(false);
    expect(Object.isFrozen(new OutboundMasking())).toBe(true);
  });

  it("a fenced-effect store is a writer under business keys, whatever its kind", () => {
    expect(businessKeyWriterUseOf([FencedEffectRepository], () => [])).toEqual({
      component: FencedEffectRepository,
      writer: FencedEffectRepository,
    });
    expect(businessKeyWriterUseOf([InMemoryFencedEffectRepository], () => [])).toMatchObject({
      writer: InMemoryFencedEffectRepository,
    });
  });

  it("an attempt of a frame that has no lease is a broken invariant, never a send", async () => {
    const run = { parts: { repository: {} }, frame: { execution: {} } } as never;

    await expect(sendNow(run, 1, "owner")).rejects.toThrow(
      "unreachable: an outbound call is sent under the lease its key was made under",
    );
  });

  it("a masking setting of options with no boolean masks", () => {
    expect(new OutboundMasking({}).requiresMask).toBe(true);
    expect(new OutboundMasking({ requiresMask: "no" } as never).requiresMask).toBe(true);
  });

  it("a send outside a step is refused, naming the service and the call", async () => {
    const frame = outboundFrame();
    const { key } = await frame.keyIn("execution-1");

    const error = await sendOutboundCall(
      { repository: frame.store } as never,
      lookupKeyOf(key),
      base(),
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ExecutionContextUnavailableError);
    expect((error as Error).message).toMatch(/^Idempotency read sendOnce outside an execution\./);
  });
});
