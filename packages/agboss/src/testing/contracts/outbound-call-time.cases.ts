import { expect } from "vitest";
import { OutboundCallStatus } from "../../infrastructure/outbound-call.repository.js";
import { minutes, seconds } from "../../units/index.js";
import type { ContractGroup } from "./define.js";
import { keyOf, leaseOf } from "./fenced-effect-data.js";
import { recorded, type OutboundCallCase, type OutboundCallStores } from "./outbound-call-data.js";

/**
 * The outbound-call contract's times (#658): what a `reconcile` is told of a pending attempt — when
 * it started and how old its key is — comes from the store, on the store's clock (the database's
 * own where it has one; the case's clock here). `saveIfAbsent` starts the first attempt,
 * `markPending` each next one and keeps the first's start; an ending keeps both; every read by key
 * says when it read the record (`readAt`), never stored.
 */

const FAILURE = { name: "GatewayTimeoutError", code: "GatewayTimeoutError", message: "timed out" };

const firstAttempt: OutboundCallCase = {
  name: "#658 saveIfAbsent starts the first attempt now: attemptStartedAt and firstAttemptStartedAt the store's time, as another instance reads them",
  run: async ({ clock, first, second }) => {
    const key = keyOf(await leaseOf(first));
    const started = clock.now().toISOString();
    await recorded(first, key);

    expect(await second.calls.findByKey(key)).toMatchObject({
      attemptStartedAt: started,
      firstAttemptStartedAt: started,
    });
  },
};

const readNow: OutboundCallCase = {
  name: "#658 every read by key says when it read the record: readAt the store's time at that read, never kept",
  run: async ({ clock, first, second }) => {
    const key = keyOf(await leaseOf(first, "execution-1", minutes(5)));
    await recorded(first, key);
    await clock.advance(seconds(7));
    const early = await second.calls.findByKey(key);
    await clock.advance(seconds(11));
    const late = await first.calls.findByKey(key);

    expect(early?.readAt).toBe(new Date(clock.now().getTime() - seconds(11)).toISOString());
    expect(late?.readAt).toBe(clock.now().toISOString());
    const [listed] = await first.calls.findAllByTenantIdAndStatus(
      "default",
      OutboundCallStatus.Pending,
    );
    expect(listed?.firstAttemptStartedAt).toBe(early?.firstAttemptStartedAt);
  },
};

const nextAttempt: OutboundCallCase = {
  name: "#658 markPending starts the next attempt at the store's time and keeps when the first started",
  run: async ({ clock, first, second }) => {
    const key = keyOf(await leaseOf(first, "execution-1", minutes(5)));
    const firstStarted = clock.now().toISOString();
    await recorded(first, key);
    await first.calls.markFailed(key, "owner-1", FAILURE);
    await clock.advance(seconds(40));
    const read = { status: OutboundCallStatus.Failed, attempt: 1, attemptOwner: "owner-1" };

    expect(await first.calls.markPending(key, read, { attempt: 2, attemptOwner: "owner-2" })).toBe(
      true,
    );
    expect(await second.calls.findByKey(key)).toMatchObject({
      attempt: 2,
      attemptStartedAt: clock.now().toISOString(),
      firstAttemptStartedAt: firstStarted,
    });
  },
};

const takenOverAttempt: OutboundCallCase = {
  name: "#658 the holder of a newer lease moves a pending intent on: its attempt starts at the store's time, the first's start kept",
  run: async ({ clock, first, second }) => {
    const old = await leaseOf(first, "execution-1", seconds(30));
    const firstStarted = clock.now().toISOString();
    await recorded(first, keyOf(old));
    await clock.advance(seconds(31));
    const key = keyOf(await leaseOf(second, "execution-1"));
    const read = { status: OutboundCallStatus.Pending, attempt: 1, attemptOwner: "owner-1" };

    await second.calls.markPending(key, read, { attempt: 2, attemptOwner: "owner-2" });

    expect(await second.calls.findByKey(key)).toMatchObject({
      attemptStartedAt: clock.now().toISOString(),
      firstAttemptStartedAt: firstStarted,
    });
  },
};

const endingsKeep: OutboundCallCase = {
  name: "#658 markCompleted and markFailed keep both times; a refused markPending changes neither",
  run: async ({ clock, first }) => {
    const key = keyOf(await leaseOf(first, "execution-1", minutes(5)));
    const started = clock.now().toISOString();
    await recorded(first, key);
    await clock.advance(seconds(5));
    await first.calls.markFailed(key, "owner-1", FAILURE);
    const stale = { status: OutboundCallStatus.Pending, attempt: 1, attemptOwner: "owner-1" };
    await clock.advance(seconds(5));
    await first.calls.markPending(key, stale, { attempt: 2, attemptOwner: "owner-2" });
    const failed = await first.calls.findByKey(key);
    const read = { status: OutboundCallStatus.Failed, attempt: 1, attemptOwner: "owner-1" };
    await first.calls.markPending(key, read, { attempt: 2, attemptOwner: "owner-2" });
    await first.calls.markCompleted(key, "owner-2", '"receipt"');
    const completed = await first.calls.findByKey(key);

    expect(failed).toMatchObject({ attemptStartedAt: started, firstAttemptStartedAt: started });
    expect(completed).toMatchObject({
      status: OutboundCallStatus.Completed,
      attemptStartedAt: clock.now().toISOString(),
      firstAttemptStartedAt: started,
    });
  },
};

/** The time cases. */
export const outboundTimeCases = (): ContractGroup<OutboundCallStores> => ({
  title: "times",
  cases: [firstAttempt, readNow, nextAttempt, takenOverAttempt, endingsKeep],
});
