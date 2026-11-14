import type { MockInstance } from "vitest";
import type { Class } from "../../../src/components/injection.js";
import type { FrameLease } from "../../../src/flow/context/frame.js";
import type { FrameworkLog } from "../../../src/infrastructure/logger.js";
import type { StoreOutcomeUnknownError } from "../../../src/infrastructure/store-call-timeout.js";
import { boundedStoreOf } from "../../../src/app/store-call-bound.js";
import { VirtualClock } from "../../../src/testing/clock.js";

/**
 * #928 — unit instruments of the bound: a store whose calls never answer, bounded on a
 * `VirtualClock` of its own, with what the bound reported; and a held lease to run a call under.
 */

/** A call that never answers, as a peer gone quiet. */
export const silent = <T>(): Promise<T> => new Promise<T>(() => undefined);

/** What a bounded store reported: warnings by code, the counter's attributes. */
export interface Reported {
  readonly warned: string[];
  readonly counted: Record<string, string>[];
}

/** `store` (an instance of a class of `contract`) bounded on a clock of its own. */
export function boundedOver<T extends object>(
  contract: Class,
  store: T,
): { readonly store: T; readonly clock: VirtualClock; readonly reported: Reported } {
  const clock = new VirtualClock();
  const reported: Reported = { warned: [], counted: [] };
  const log: FrameworkLog = {
    info: () => undefined,
    warn: (code) => void reported.warned.push(code),
    error: () => undefined,
  };
  const timedOut = {
    add: (_count: number, attributes: Record<string, string>) =>
      void reported.counted.push(attributes),
  };
  return { store: boundedStoreOf(contract, store, { clock, log, timedOut }), clock, reported };
}

/** What a call settled with, as a value: the error, or `"answered"`. */
export const outcomeOf = (call: Promise<unknown>): Promise<unknown> =>
  call.then(
    () => "answered",
    (thrown: unknown) => thrown,
  );

/** A lease held with `left` ms of trust: the hand-overs it was asked for, and a way to lose it. */
export function heldLease(left: number): {
  readonly lease: FrameLease;
  readonly abandoned: StoreOutcomeUnknownError[];
} {
  const abandoned: StoreOutcomeUnknownError[] = [];
  const lease: FrameLease = {
    tenantId: "default",
    leaseExecutionId: "root-1",
    scopeKey: "root-1",
    token: 1,
    trustedUntil: Number.POSITIVE_INFINITY,
    isYielded: false,
    left,
    signal: new AbortController().signal,
    assertHeld: () => undefined,
    renewNow: () => Promise.resolve(),
    enterStep: () => Promise.resolve(() => undefined),
    abandon: (cause) => {
      abandoned.push(cause);
      return Promise.resolve();
    },
  };
  return { lease, abandoned };
}

/**
 * The next call of the method `spy` watches took effect and is never answered: it runs for real,
 * then stays silent — the unknown outcome of a lost answer, with no one to release it. (The real
 * call is the spy's own, made once its one-time implementation was taken: it counts twice.)
 */
export function appliedThenSilent<Args extends unknown[], Answer>(
  spy: MockInstance<(...args: Args) => Promise<Answer>>,
): MockInstance<(...args: Args) => Promise<Answer>> {
  // a vitest spy is a function; the types of its instance do not say so
  const call: unknown = spy;
  if (typeof call !== "function") throw new TypeError("a spy is a function");
  return spy.mockImplementationOnce(async function (this: unknown, ...args: Args) {
    await Reflect.apply(call, this, args);
    return silent<Answer>();
  });
}
