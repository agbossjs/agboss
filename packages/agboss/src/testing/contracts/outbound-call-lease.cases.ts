import { expect } from "vitest";
import { OutboundCallLeaseState } from "../../infrastructure/execution-lease-event.repository.js";
import type { ExecutionLease } from "../../infrastructure/execution-lease.repository.js";
import type { FencedEffectKey } from "../../infrastructure/fenced-effect.repository.js";
import { seconds } from "../../units/index.js";
import type { ContractGroup } from "./define.js";
import { keyOf, leaseOf } from "./fenced-effect-data.js";
import { recorded, type OutboundCallCase, type OutboundCallStores } from "./outbound-call-data.js";
import { inTurn, PENDING, ROUNDS } from "./outbound-call-race.cases.js";

/**
 * The outbound-call contract's races across leases (#508 re-reviews), each run a number of rounds,
 * the two callers in both orders: one business key's row moved under two leases — which no lock of
 * either lease serializes, only the row's own compare-and-set — and `leaseStateOf` of an expired
 * lease against its holder's late renewal and another instance's take, which its check and close
 * must make one atomic step.
 */

/** Round `round`'s keys of one business key under two leases: two executions, two instances. */
const crossLeaseKeys = (
  one: FencedEffectKey,
  other: FencedEffectKey,
  round: number,
): readonly [FencedEffectKey, FencedEffectKey] => {
  const businessKey = `order:${String(round)}`;
  return [
    { ...one, businessKey, fingerprint: "f" },
    { ...other, businessKey, fingerprint: "f" },
  ];
};

/**
 * A business key's one row moved under two leases at once (#508 re-review): a lock of either lease
 * does not serialize them — only the row's own compare-and-set does.
 */
const crossLeaseRaced = (ending: "markCompleted" | "markPending"): OutboundCallCase => ({
  name: `#508: one business key's pending intent, ${ending === "markCompleted" ? "its attempt's markCompleted under one lease racing a new attempt's claim" : "a new attempt's claim under one lease racing another's"} under another, round after round: exactly one changes the intent`,
  run: async ({ first, second }) => {
    const one = keyOf(await leaseOf(first, "execution-1"));
    const other = keyOf(await leaseOf(second, "execution-2"));
    for (let round = 0; round < ROUNDS; round += 1) {
      const [a, b] = crossLeaseKeys(one, other, round);
      await recorded(first, a);
      const byFirst = () =>
        ending === "markCompleted"
          ? first.calls.markCompleted(a, "owner-1", '"r"')
          : first.calls.markPending(a, PENDING, { attempt: 2, attemptOwner: "owner-a" });

      const [isFirst, isSecond] = await inTurn(round, byFirst, () =>
        second.calls.markPending(b, PENDING, { attempt: 2, attemptOwner: "owner-2" }),
      );

      expect([isFirst, isSecond].filter(Boolean)).toHaveLength(1);
      const found = await second.calls.findByKey(b);
      const firstOwner = ending === "markCompleted" ? "owner-1" : "owner-a";
      expect(found?.attemptOwner).toBe(isFirst === true ? firstOwner : "owner-2");
    }
  },
});

/**
 * `leaseStateOf` of an expired lease racing its holder's late renewal (#508 final re-review): the
 * check and its close are one step — the lease is renewed and `Live`, or `Superseded` and not
 * renewable, never closed in the caller's eyes while the holder renewed it and sends on. Since #534
 * the renewal past the expiry is refused by the lease store itself, so it is always the latter.
 */
const stateRacingRenew: OutboundCallCase = {
  name: "#508: leaseStateOf of an expired lease racing its holder's renewal, round after round: renewed and Live, or Superseded and not renewable — never both",
  run: async ({ clock, first, second }) => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const executionId = `execution-${String(round)}`;
      const lease = await leaseOf(first, executionId, seconds(30));
      await clock.advance(seconds(31));

      const [state, isRenewed] = await inTurn<unknown>(
        round,
        () =>
          second.calls.leaseStateOf({
            tenantId: "default",
            leaseExecutionId: executionId,
            token: lease.leaseEpoch,
          }),
        async () => (await first.leases.renew(lease, seconds(30))) !== undefined,
      );

      // #534: past its expiry the lease is over for its holder too — the renewal never wins
      expect(isRenewed).toBe(false);
      const expected =
        isRenewed === true ? OutboundCallLeaseState.Live : OutboundCallLeaseState.Superseded;
      expect(state).toBe(expected);
      const after = isRenewed === true ? OutboundCallLeaseState.Live : OutboundCallLeaseState.Ended;
      expect(
        await second.calls.leaseStateOf({
          tenantId: "default",
          leaseExecutionId: executionId,
          token: lease.leaseEpoch,
        }),
      ).toBe(after);
    }
  },
};

/** `leaseStateOf` of an expired lease racing another instance's take of it: the take stands, held. */
const stateRacingAcquire: OutboundCallCase = {
  name: "#508: leaseStateOf of an expired lease racing another instance's take, round after round: the old token is not Live, the take stands and is held",
  run: async ({ clock, first, second }) => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const executionId = `execution-${String(round)}`;
      const lease = await leaseOf(first, executionId, seconds(30));
      await clock.advance(seconds(31));

      const [state, taken] = await inTurn<unknown>(
        round,
        () =>
          first.calls.leaseStateOf({
            tenantId: "default",
            leaseExecutionId: executionId,
            token: lease.leaseEpoch,
          }),
        () => second.leases.acquire("default", executionId, seconds(30)),
      );

      expect(state).not.toBe(OutboundCallLeaseState.Live);
      const held = taken as ExecutionLease | undefined;
      if (held === undefined) throw new Error("the take of the expired lease failed");
      expect(held.leaseEpoch).toBe(lease.leaseEpoch + 1);
      expect(await second.leases.renew(held, seconds(30))).toBe(seconds(30));
      expect(
        await first.calls.leaseStateOf({
          tenantId: "default",
          leaseExecutionId: executionId,
          token: held.leaseEpoch,
        }),
      ).toBe(OutboundCallLeaseState.Live);
    }
  },
};

/** The races across leases. */
export const outboundLeaseRaceCases = (): ContractGroup<OutboundCallStores> => ({
  title: "races across leases",
  isFencing: true,
  cases: [
    crossLeaseRaced("markCompleted"),
    crossLeaseRaced("markPending"),
    stateRacingRenew,
    stateRacingAcquire,
  ],
});
