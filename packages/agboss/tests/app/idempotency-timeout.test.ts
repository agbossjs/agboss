import { onEffectCommit } from "../../src/infrastructure/in-memory-effect-writes.js";
/**
 * #1317a — what a `timeout` does, and what it never does. `runOnce`: the attempt's transaction is
 * dead at the timeout, and a late completion of `execute` writes nothing, whoever took the lease
 * over. `sendOnce`: a timeout is not "not sent" — the intent stays in doubt, its late answer is
 * recorded fenced (or told and logged as a late observation once the lease moved), a takeover goes
 * through the recovery and never resends blindly, and a retry sends under the same key.
 */
import { describe, expect, it } from "vitest";
import { hours, seconds } from "../../src/units/index.js";
import {
  IdempotencyRunStatus,
  OutboundCallSendStatus,
  OutboundCallStatus,
  OutboundRecovery,
  Reconciliation,
} from "../../src/index.js";
import { lookupKeyOf, outboundFrame, rejectionOf } from "../helpers/outbound-frame.js";

/** Lets every settled promise and its continuations run. */
const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await new Promise<void>((r) => setImmediate(r));
};

/** A promise settled by hand. */
function gate<TValue>(): {
  readonly promise: Promise<TValue>;
  readonly resolve: (value: TValue) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: TValue) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<TValue>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("#1317a runOnce: a timed-out attempt's transaction is dead", () => {
  it("execute resolves after the timeout and a takeover has started: nothing of it is committed, the effect runs exactly once", async () => {
    const frame = outboundFrame();
    const committed: string[] = [];
    const late = gate<undefined>();
    const first = await frame.keyIn("execution-1");
    const slow = frame.inFrame(first.key, () =>
      frame.idempotency.runOnce({
        name: "charge",
        ttl: hours(24),
        timeout: seconds(5),
        execute: async () => {
          await late.promise;
          // the attempt timed out: its buffered write is never applied (a SQLite attempt's
          // transaction is closed — tests/infrastructure/sqlite/sqlite-run-once-hold.test.ts)
          onEffectCommit(() => committed.push("late"));
          return { n: 1 };
        },
      }),
    );
    const settled = slow.catch((error: unknown) => error);
    await frame.clock.advance(seconds(6));
    expect(await settled).toMatchObject({ name: "TimeoutError" });

    // a takeover: the lease is released and taken again, a newer token
    await frame.leases.release(first.lease);
    const second = await frame.keyIn("execution-1");
    expect(second.key.token).toBeGreaterThan(first.key.token);
    const takenOver = await frame.inFrame(second.key, () =>
      frame.idempotency.runOnce({
        name: "charge",
        ttl: hours(24),
        execute: () => {
          onEffectCommit(() => committed.push("second"));
          return { n: 2 };
        },
      }),
    );
    late.resolve(undefined);
    await flush();
    const again = await frame.inFrame(second.key, () =>
      frame.idempotency.runOnce({ name: "charge", ttl: hours(24), execute: () => ({ n: 3 }) }),
    );

    expect(takenOver.status).toBe(IdempotencyRunStatus.Ran);
    expect(again).toMatchObject({ status: IdempotencyRunStatus.Replayed, result: { n: 2 } });
    expect(committed).toEqual(["second"]);
  });
});

/** The gateway: what it received by key, recorded when a call's answer is produced. */
function gateway() {
  const received = new Map<string, number>();
  return {
    received,
    record: (key: string): void => {
      received.set(key, (received.get(key) ?? 0) + 1);
    },
  };
}

const byBook =
  (book: ReturnType<typeof gateway>) =>
  (lookup: { readonly idempotencyKey: string }): Reconciliation<{ paymentId: string }> =>
    book.received.has(lookup.idempotencyKey)
      ? Reconciliation.completed({ paymentId: "p-1" })
      : Reconciliation.notExecuted();

describe("#1317a sendOnce: a timeout is not 'not sent'", () => {
  it("a hung call answers after the timeout, no takeover: the answer is recorded once, the next call replays it", async () => {
    const frame = outboundFrame();
    const book = gateway();
    const hung = gate<{ paymentId: string }>();
    let sends = 0;
    const { key } = await frame.keyIn("execution-1");
    const options = {
      target: "gateway",
      operation: "charge",
      request: { amount: 10 },
      timeout: seconds(5),
      send: async (call: { readonly idempotencyKey: string }) => {
        sends += 1;
        book.record(call.idempotencyKey);
        return hung.promise;
      },
      recovery: OutboundRecovery.permanentLookup(byBook(book)),
    };
    const first = frame.send(key, options);
    const failed = rejectionOf(first);
    await frame.clock.advance(seconds(6));
    expect(await failed).toMatchObject({ name: "TimeoutError" });
    expect((await frame.store.findByKey(lookupKeyOf(key)))?.status).toBe(
      OutboundCallStatus.Pending,
    );

    hung.resolve({ paymentId: "p-1" });
    await flush();

    const stored = await frame.store.findByKey(lookupKeyOf(key));
    expect(stored?.status).toBe(OutboundCallStatus.Completed);
    const replay = await frame.send(key, options);
    expect(replay.status).toBe(OutboundCallSendStatus.Replayed);
    expect(sends).toBe(1);
  });

  it("the same with a takeover: the late answer is not a success, the new holder reconciles it — no second send", async () => {
    const frame = outboundFrame();
    const book = gateway();
    const hung = gate<{ paymentId: string }>();
    let sends = 0;
    const first = await frame.keyIn("execution-1");
    const options = (idempotent: { sends: () => void }) => ({
      target: "gateway",
      operation: "charge",
      request: { amount: 10 },
      timeout: seconds(5),
      send: async (call: { readonly idempotencyKey: string }) => {
        idempotent.sends();
        book.record(call.idempotencyKey);
        return hung.promise;
      },
      recovery: OutboundRecovery.permanentLookup(byBook(book)),
    });
    const failed = rejectionOf(frame.send(first.key, options({ sends: () => (sends += 1) })));
    await frame.clock.advance(seconds(6));
    await failed;

    // another instance takes the lease over; the hung call answers only now
    await frame.leases.release(first.lease);
    const second = await frame.keyIn("execution-1");
    hung.resolve({ paymentId: "p-1" });
    await flush();

    // the late answer is no completion: its lease is not current
    expect((await frame.store.findByKey(lookupKeyOf(second.key)))?.status).toBe(
      OutboundCallStatus.Pending,
    );
    const other = frame.otherInstance();
    const settled = await frame.inFrame(second.key, () =>
      other.sendOnce({
        ...options({ sends: () => (sends += 1) }),
        name: second.key.name,
        key: frame.textOf(second.key),
        timeout: seconds(5),
        ttl: hours(48),
      } as never),
    );

    expect(settled.status).toBe(OutboundCallSendStatus.Reconciled);
    expect(sends).toBe(1);
    expect(frame.logger.entries).toContainEqual(
      expect.objectContaining({ code: "outbound-call.answered-after-hand-over" }),
    );
  });

  it("a call retried after a timeout is sent under the same idempotency key", async () => {
    const frame = outboundFrame();
    const keys: string[] = [];
    const hung = gate<{ paymentId: string }>();
    const { key } = await frame.keyIn("execution-1");
    const options = {
      target: "gateway",
      operation: "charge",
      request: { amount: 10 },
      timeout: seconds(5),
      send: async (call: { readonly idempotencyKey: string }) => {
        keys.push(call.idempotencyKey);
        return keys.length === 1 ? hung.promise : { paymentId: "p-2" };
      },
      // the other system never saw the first: a resend is the same call
      recovery: OutboundRecovery.permanentLookup<{ paymentId: string }>(() =>
        Reconciliation.notExecuted(),
      ),
    };
    const failed = rejectionOf(frame.send(key, options));
    await frame.clock.advance(seconds(6));
    await failed;
    // the hung send ends with an error: the intent stays pending, in doubt
    hung.reject(new Error("socket hang up"));
    await flush();

    const retried = await frame.send(key, options);

    expect(retried.attempt).toBe(2);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });
});

describe("#1317a options are checked before anything runs", () => {
  it("a recovery window not above the timeout, or a ttl below it, is refused with InvalidRecovery", async () => {
    const frame = outboundFrame();
    const { key } = await frame.keyIn("execution-1");
    const base = {
      target: "gateway",
      operation: "charge",
      request: { amount: 10 },
      send: () => ({ paymentId: "p" }),
    };

    const tooShort = await rejectionOf(
      frame.send(key, {
        ...base,
        timeout: seconds(15),
        recovery: OutboundRecovery.replayWithin(seconds(10)),
      }),
    );
    const ttlBelow = await rejectionOf(
      frame.send(key, {
        ...base,
        timeout: seconds(15),
        ttl: seconds(60),
        recovery: OutboundRecovery.replayWithin(hours(1)),
      } as never),
    );

    expect(tooShort).toMatchObject({ code: "outbound-call.invalid-recovery" });
    expect(ttlBelow).toMatchObject({ code: "outbound-call.invalid-recovery" });
  });
});
