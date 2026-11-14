/**
 * #928 AC1 — a call outside a held lease that never answers is a store error at its bound, never a
 * hand-over: 15 s for an unleased call, 5 min for a retention delete or an A2A file save, even
 * inside a lease scope; and the work that goes on after the terminal record stays unleased.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  A2AFileRepository,
  A2ATaskRepository,
  ChildExecutionQueueRepository,
  ExecutionLeaseLostError,
  ExecutionLeaseRepository,
  ExecutionRecordRepository,
  PausedExecutionRepository,
  StoreCallTimeoutError,
  StoreOutcomeSource,
} from "../../src/index.js";
import { ExecutionHistoryRepository } from "../../src/infrastructure/execution-history.repository.js";
import { FencedEffectRepository } from "../../src/infrastructure/fenced-effect.repository.js";
import { LONG_CALL_BOUND, STORE_CALL_BOUND } from "../../src/app/lease-fence.js";
import { leaseScope } from "../../src/app/lease-scope.js";
import { TestConcurrency, testWith } from "../../src/testing/index.js";
import { minutes, seconds } from "../../src/units/index.js";
import { logged, resetLogged } from "../helpers/log.js";
import { passLive } from "../helpers/live-time.js";
import { until } from "../helpers/until.js";
import { hung, HungStoreApplication, resetHung } from "./fixtures/hung-store.application.js";
import { boundedOver, heldLease, outcomeOf, silent } from "./fixtures/bound-stubs.js";
import { resetQuiet } from "./fixtures/unleased-store.application.js";

/** A store of every contract the cases name, each call of which never answers. */
class SilentStore {
  findByStatus = silent;
  claimFirstByStatusQueuedOrderByDepthDesc = silent;
  acquire = silent;
  requestCancel = silent;
  resolveByTenantIdAndPauseId = silent;
  saveIfAbsent = silent;
  deleteByStoredAtBefore = silent;
  deleteByEndedAtBefore = silent;
  save = silent;
}

beforeEach(() => {
  resetLogged();
  resetHung();
  resetQuiet();
});

afterEach(() => {
  resetHung();
  resetQuiet();
});

const unleased = [
  ["the sweep's look", ExecutionRecordRepository, "findByStatus"],
  ["a child claim", ChildExecutionQueueRepository, "claimFirstByStatusQueuedOrderByDepthDesc"],
  ["acquire", ExecutionLeaseRepository, "acquire"],
  ["requestCancel", ExecutionLeaseRepository, "requestCancel"],
  ["an answer to a pause", PausedExecutionRepository, "resolveByTenantIdAndPauseId"],
  ["an A2A accept", A2ATaskRepository, "saveIfAbsent"],
] as const;

describe("#928 AC1: an unleased call held for ever", () => {
  it.each(unleased)(
    "AC1: %s rejects StoreCallTimeoutError after 15 s on the Clock, and not before",
    async (_name, contract, operation) => {
      const { store, clock, reported } = boundedOver(contract, new SilentStore());
      const call = outcomeOf(Reflect.apply(Reflect.get(store, operation), store, []));
      let settled = false;
      void call.then(() => (settled = true));

      await clock.advance(seconds(14));
      expect(settled).toBe(false);
      await clock.advance(seconds(1));
      const error = await call;

      expect(error).toBeInstanceOf(StoreCallTimeoutError);
      expect(error).toMatchObject({
        store: "SilentStore",
        operation,
        timeout: STORE_CALL_BOUND,
        source: StoreOutcomeSource.Framework,
        code: "store.call-timeout",
      });
      expect(reported.warned).toEqual(["store.call-timeout"]);
      expect(reported.counted).toEqual([
        { contract: contract.name, operation, source: "framework", kind: "unleased" },
      ]);
    },
  );
});

const hungOnApp = testWith(HungStoreApplication, { concurrency: TestConcurrency.Real });
const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 100));

describe("#928 AC1: the sweep runs again next period", () => {
  hungOnApp(
    "AC1: the sweep's look held for ever times out at 15 s and is made again",
    async ({ app, clock }) => {
      await app.ready();
      await settle();
      hung.records = true;
      await passLive(clock, seconds(30)); // the next sweep's look
      await until(() => hung.calls > 0, "the sweep looked");
      const first = hung.calls;

      await passLive(clock, seconds(15));
      await until(
        () => logged.some((entry) => entry.code === "store.call-timeout"),
        "the bound fired",
      );
      const entry = logged.find((candidate) => candidate.code === "store.call-timeout");
      expect(entry?.message).toContain("HungRecordRepository.findByStatus");
      expect(entry?.message).toContain("unleased call");

      // the sweep did not wait for ever on the look: its next period looks again
      await passLive(clock, seconds(60));
      await until(() => hung.calls > first, "the sweep looked again");
      expect(hung.calls).toBeGreaterThan(first);
    },
  );

  hungOnApp(
    "AC1: a child claim held for ever times out at 15 s and the worker claims again",
    async ({ app, clock }) => {
      await app.ready();
      await settle();
      hung.claim = true;
      await passLive(clock, seconds(30));
      await until(() => hung.calls > 0, "the worker claimed");
      const first = hung.calls;

      await passLive(clock, seconds(15));
      await until(
        () =>
          logged.some((entry) =>
            entry.message.includes("claimFirstByStatusQueuedOrderByDepthDesc"),
          ),
        "the bound fired on the claim",
      );
      await passLive(clock, seconds(60));
      await until(() => hung.calls > first, "the worker claimed again");
      expect(hung.calls).toBeGreaterThan(first);
    },
  );
});

describe("#928 AC1: a long call is bounded by 5 min and never hands over", () => {
  const long = [
    ["a retention delete", FencedEffectRepository, "deleteByStoredAtBefore"],
    [
      "the cancel-mark pruning of a retention delete",
      ExecutionHistoryRepository,
      "deleteByEndedAtBefore",
    ],
    ["an A2A file save", A2AFileRepository, "save"],
  ] as const;

  it.each(long)(
    "AC1: %s, inside a step frame's lease, rejects StoreCallTimeoutError at 5 min; no hand-over",
    async (_name, contract, operation) => {
      const { store, clock, reported } = boundedOver(contract, new SilentStore());
      const { lease, abandoned } = heldLease(seconds(29));
      const call = leaseScope(lease, () =>
        outcomeOf(Reflect.apply(Reflect.get(store, operation), store, [])).then((error) => {
          if (error === "answered") throw new Error("it answered");
          return error;
        }),
      );
      let settled = false;
      void call.then(() => (settled = true));

      await clock.advance(seconds(60)); // past the lease's trust, past the unleased bound
      expect(settled).toBe(false);
      await clock.advance(minutes(3));
      expect(settled).toBe(false);
      await clock.advance(seconds(59));
      expect(settled).toBe(false);
      await clock.advance(seconds(1));
      const error = await call;

      expect(error).toBeInstanceOf(StoreCallTimeoutError);
      expect(error).not.toBeInstanceOf(ExecutionLeaseLostError);
      expect(error).toMatchObject({ operation, timeout: LONG_CALL_BOUND, source: "framework" });
      expect(abandoned).toEqual([]);
      expect(reported.counted).toEqual([
        { contract: contract.name, operation, source: "framework", kind: "long" },
      ]);
    },
  );

  it("AC1: the control — the same scope hands a call that is no long one over at the trust's end", async () => {
    const { store, clock } = boundedOver(ExecutionRecordRepository, new SilentStore());
    const { lease, abandoned } = heldLease(seconds(29));
    const call = leaseScope(lease, () => outcomeOf(store.findByStatus()));

    await clock.advance(seconds(29));
    const error = await call;

    expect(error).toBeInstanceOf(ExecutionLeaseLostError);
    expect(abandoned).toHaveLength(1);
  });
});
