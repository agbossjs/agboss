import type { StoreOutcomeUnknown } from "../../src/infrastructure/store-call-timeout.js";
import { StoreError } from "../../src/core/error-families/store-errors.js";
import { fencedRefusalOf } from "../../src/app/lease-lost.js";
import { ExecutionError } from "../../src/core/error-families/run-errors.js";
/**
 * #928 AC1 — the bounded store, call by call: what a store's own timeout, a fencing refusal, a late
 * answer or a clock nobody moves does to a call under a lease and to one outside it; and what a
 * leased timeout tells the log and the counter.
 */
import { afterEach, describe, expect, it } from "vitest";
import { leaseScope } from "../../src/app/lease-scope.js";
import { boundedStoreOf, type StoreCallParts } from "../../src/app/store-call-bound.js";
import type { FrameLease } from "../../src/flow/context/frame.js";
import {
  ExecutionCancelFencedError,
  ExecutionLeaseLostError,
  StoreOutcomeSource,
} from "../../src/index.js";
import { VirtualClock } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { recordingLog } from "../helpers/log.js";
import { rejectionOf } from "./fixtures/fence-takeover.js";

/** A store whose one call answers when the test says so. */
class Ledger {
  readonly asked: ((answer: Promise<string>) => void)[] = [];

  read(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.asked.push((answer) => void answer.then(resolve, reject));
    });
  }
}

/** What a lease says to the proxy, and what the proxy did to it. */
interface FakeLease extends FrameLease {
  readonly abandoned: StoreOutcomeUnknown[];
  readonly lose: (reason: Error) => void;
}

function fakeLease(left: number): FakeLease {
  const lost = new AbortController();
  const abandoned: StoreOutcomeUnknown[] = [];
  return {
    ...{ tenantId: "acme", leaseExecutionId: "root-1", scopeKey: "acme:root-1", token: 1 },
    ...{ trustedUntil: 0, isYielded: false, left, signal: lost.signal, abandoned },
    assertHeld: () => undefined,
    renewNow: () => Promise.resolve(),
    enterStep: () => Promise.resolve(() => undefined),
    abandon: (cause) => {
      abandoned.push(cause);
      return Promise.resolve();
    },
    lose: (reason) => {
      lost.abort(reason);
    },
  };
}

/** The parts of a bound on a virtual clock, with what they reported. */
function boundOn(clock: VirtualClock) {
  const { log, entries } = recordingLog();
  const counted: { count: number; attributes: Record<string, string> }[] = [];
  const parts: StoreCallParts = {
    clock,
    log,
    timedOut: { add: (count, attributes) => counted.push({ count, attributes }) },
  };
  const ledger = new Ledger();
  return { ledger, store: boundedStoreOf(Ledger, ledger, parts), entries, counted };
}

const settle = async (): Promise<void> => {
  for (let tick = 0; tick < 10; tick += 1) await new Promise((resolve) => setImmediate(resolve));
};

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};
process.on("unhandledRejection", onUnhandled);

afterEach(() => {
  unhandled.length = 0;
});

const commandTimeout = new StoreError.CallTimeout({
  store: "Ledger",
  operation: "read",
  timeout: seconds(10),
  source: StoreOutcomeSource.Command,
});

describe("#928 AC1: what a store's own error becomes", () => {
  it("AC1: a Command StoreError.CallTimeout from a store under a lease is a hand-over", async () => {
    const { ledger, store } = boundOn(new VirtualClock());
    const lease = fakeLease(seconds(20));
    const call = rejectionOf(leaseScope(lease, () => store.read()));
    ledger.asked[0]?.(Promise.reject(commandTimeout));

    const error = await call;
    expect(error).toBeInstanceOf(ExecutionLeaseLostError);
    expect(error).toMatchObject({ cause: commandTimeout });
    expect(lease.abandoned).toEqual([commandTimeout]);
  });

  it("AC1: unleased, the same error passes through unchanged and abandons nothing", async () => {
    const { ledger, store } = boundOn(new VirtualClock());
    const call = rejectionOf(store.read());
    ledger.asked[0]?.(Promise.reject(commandTimeout));

    expect(await call).toBe(commandTimeout);
  });

  it("AC1: ExecutionCancelFencedError and ExecutionError.Fenced pass through the proxy unchanged", async () => {
    const fenced = fencedRefusalOf({ scopeKey: "acme:root-1", token: 1 });
    const cancel = ExecutionCancelFencedError.of({
      ...{ scopeKey: "acme:root-1", tenantId: "acme", leaseExecutionId: "root-1" },
      ...{ token: 1, name: "charge" },
    });
    for (const refusal of [fenced, cancel]) {
      const { ledger, store } = boundOn(new VirtualClock());
      const lease = fakeLease(seconds(20));
      const call = rejectionOf(leaseScope(lease, () => store.read()));
      ledger.asked[0]?.(Promise.reject(refusal));

      expect(await call).toBe(refusal);
      expect(lease.abandoned).toEqual([]);
    }
  });
});

describe("#928 AC1: what a late or a never answer does", () => {
  it("AC1: a late answer is dropped; a late rejection is not unhandled", async () => {
    const clock = new VirtualClock();
    const { ledger, store } = boundOn(clock);
    const lateAnswer = rejectionOf(store.read());
    const lateFailure = rejectionOf(store.read());
    await clock.advance(seconds(15));
    expect(await lateAnswer).toBeInstanceOf(StoreError.CallTimeout);
    expect(await lateFailure).toBeInstanceOf(StoreError.CallTimeout);

    ledger.asked[0]?.(Promise.resolve("too late"));
    ledger.asked[1]?.(Promise.reject(new Error("too late too")));
    await settle();

    expect(unhandled).toEqual([]);
  });

  it("#1090 follow-up: a rejection that arrives after the bound is not reported again: one log, one count", async () => {
    const clock = new VirtualClock();
    const { ledger, store, entries, counted } = boundOn(clock);
    const call = rejectionOf(store.read());
    await clock.advance(seconds(15));
    expect(await call).toBeInstanceOf(StoreError.CallTimeout);
    expect(entries.map((entry) => entry.code)).toEqual(["store.call-timeout"]);
    expect(counted).toHaveLength(1);

    // the store's own command timeout, arriving after the bound already ended the call
    ledger.asked[0]?.(Promise.reject(commandTimeout));
    await settle();

    expect(entries.map((entry) => entry.code)).toEqual(["store.call-timeout"]);
    expect(counted).toHaveLength(1);
    expect(unhandled).toEqual([]);
  });

  it("#1090 follow-up: under a lease a rejection after the hand-over abandons nothing more and says nothing more", async () => {
    const clock = new VirtualClock();
    const { ledger, store, entries, counted } = boundOn(clock);
    const lease = fakeLease(seconds(20));
    const call = rejectionOf(leaseScope(lease, () => store.read()));
    await clock.advance(seconds(20));
    expect(await call).toBeInstanceOf(ExecutionLeaseLostError);
    expect(lease.abandoned).toHaveLength(1);
    const logged = entries.map((entry) => entry.code);
    const timedOut = counted.length;

    // the answer that comes late: the transport's unknown outcome, after the hand-over
    const late = new StoreError.OutcomeUnknown({
      ...{ store: "Ledger", operation: "read", source: StoreOutcomeSource.Transport },
      cause: new Error("connection reset"),
    });
    ledger.asked[0]?.(Promise.reject(late));
    await settle();

    expect(lease.abandoned).toHaveLength(1);
    expect(entries.map((entry) => entry.code)).toEqual(logged);
    expect(counted).toHaveLength(timedOut);
    expect(unhandled).toEqual([]);
  });

  it("AC1: a VirtualClock never advanced never fires a bound", async () => {
    const { ledger, store, entries, counted } = boundOn(new VirtualClock());
    const call = rejectionOf(store.read());
    let isSettled = false;
    void call.then(() => (isSettled = true));

    // real time passes, the clock's does not: nothing fires
    await new Promise((resolve) => setTimeout(resolve, 30));
    await settle();
    expect(isSettled).toBe(false);
    expect(entries).toEqual([]);
    expect(counted).toEqual([]);
    ledger.asked[0]?.(Promise.reject(new Error("done")));
    await call;
  });
});

describe("#928 AC1: what a leased timeout tells", () => {
  it("AC1: unleased, it logs store.call-timeout once and counts it with its contract, operation, source and kind", async () => {
    const clock = new VirtualClock();
    const { store, entries, counted } = boundOn(clock);
    const call = rejectionOf(store.read());
    await clock.advance(seconds(15));
    await call;

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ level: "warn", code: "store.call-timeout" });
    expect(entries[0]?.message).toContain("Ledger.read");
    expect(counted).toEqual([
      {
        count: 1,
        attributes: {
          contract: "Ledger",
          operation: "read",
          source: "framework",
          kind: "unleased",
        },
      },
    ]);
  });

  it("AC1: leased, it ends at the trust's end, abandons the lease and counts kind leased", async () => {
    const clock = new VirtualClock();
    const { store, counted } = boundOn(clock);
    const lease = fakeLease(seconds(20));
    const call = rejectionOf(leaseScope(lease, () => store.read()));
    await clock.advance(seconds(19));
    await settle();
    expect(lease.abandoned).toEqual([]);
    await clock.advance(seconds(1));

    const error = await call;
    expect(error).toBeInstanceOf(ExecutionLeaseLostError);
    expect(lease.abandoned).toHaveLength(1);
    expect(lease.abandoned[0]).toMatchObject({ operation: "read", timeout: seconds(20) });
    expect(counted[0]?.attributes.kind).toBe("leased");
  });

  it("AC1: a call hanging when its lease is lost ends with the lease's reason, at the loss", async () => {
    const clock = new VirtualClock();
    const { store, entries } = boundOn(clock);
    const lease = fakeLease(seconds(20));
    const call = rejectionOf(leaseScope(lease, () => store.read()));
    const reason = new ExecutionLeaseLostError({ rootExecutionId: "root-1" });
    lease.lose(reason);

    expect(await call).toBe(reason);
    expect(entries).toEqual([]);
    expect(lease.abandoned).toEqual([]);
  });
});
