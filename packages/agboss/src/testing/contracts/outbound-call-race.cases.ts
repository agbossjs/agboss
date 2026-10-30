import { expect } from "vitest";
import { ExecutionFencedError } from "../../app/lease-lost.js";
import type { FencedEffectKey } from "../../infrastructure/fenced-effect.repository.js";
import { OutboundCallStatus } from "../../infrastructure/outbound-call.repository.js";
import type { ContractGroup } from "./define.js";
import { keyOf, leaseOf, rejectionOf } from "./fenced-effect-data.js";
import {
  intentOf,
  recorded,
  type OutboundCallCase,
  type OutboundCallStores,
} from "./outbound-call-data.js";

/**
 * The outbound-call contract's races (#508), each run a number of rounds, the two callers in both
 * orders: what a store must make atomic — a row lock, a unique index, a compare-and-set in one
 * statement — so that a non-atomic port fails here rather than in production.
 */

/** How many rounds each race runs. */
const ROUNDS = 12;

/** The two callers of a round: the order alternates. */
const inTurn = <T>(round: number, a: () => Promise<T>, b: () => Promise<T>): Promise<T[]> =>
  round % 2 === 0 ? Promise.all([a(), b()]) : Promise.all([b(), a()]).then(([y, x]) => [x, y]);

/** A pending first attempt of owner `owner-1` (as `recorded` writes it), as a caller reads it. */
const PENDING = { status: OutboundCallStatus.Pending, attempt: 1, attemptOwner: "owner-1" };

const FAILURE = { name: "PaymentDeclinedError", code: "PaymentDeclinedError", message: "declined" };

/** Round `round`'s key of `name` under the lease the case holds. */
const roundKey = (key: FencedEffectKey, round: number): FencedEffectKey => ({
  ...key,
  name: `charge-${String(round)}`,
});

const movesRaced: OutboundCallCase = {
  name: "#508: two instances moving one pending intent from one read, round after round: exactly one wins each time",
  run: async ({ first, second }) => {
    const lease = await leaseOf(first);
    for (let round = 0; round < ROUNDS; round += 1) {
      const key = roundKey(keyOf(lease), round);
      await recorded(first, key);

      const moves = await inTurn(
        round,
        () => first.calls.markPending(key, PENDING, { attempt: 2, attemptOwner: "a" }),
        () => second.calls.markPending(key, PENDING, { attempt: 2, attemptOwner: "b" }),
      );

      expect(moves.filter(Boolean)).toHaveLength(1);
    }
  },
};

const savesRaced: OutboundCallCase = {
  name: "#508: two executions on two instances recording one business key at once, round after round: exactly one intent",
  run: async ({ first, second }) => {
    const one = keyOf(await leaseOf(first, "execution-1"));
    const other = keyOf(await leaseOf(second, "execution-2"));
    for (let round = 0; round < ROUNDS; round += 1) {
      const businessKey = `order:${String(round)}`;
      const [a, b] = [one, other].map((key) => ({ ...key, businessKey, fingerprint: "f" }));
      if (a === undefined || b === undefined) throw new Error("two keys expected");

      const saves = await inTurn(
        round,
        () => first.calls.saveIfAbsent(a, intentOf(a)),
        () => second.calls.saveIfAbsent(b, intentOf(b)),
      );

      expect(saves.filter(Boolean)).toHaveLength(1);
    }
  },
};

/** An ending racing a move of the same attempt: exactly one of them changes the intent. */
const endingRaced = (ending: "markCompleted" | "markFailed"): OutboundCallCase => ({
  name: `#508: ${ending} of an attempt racing a newer attempt's claim, round after round: exactly one changes the intent`,
  run: async ({ first, second }) => {
    const lease = await leaseOf(first);
    for (let round = 0; round < ROUNDS; round += 1) {
      const key = roundKey(keyOf(lease), round);
      await recorded(first, key);
      const end = () =>
        ending === "markCompleted"
          ? first.calls.markCompleted(key, "owner-1", '"r"')
          : first.calls.markFailed(key, "owner-1", FAILURE);

      const [isEnded, isMoved] = await inTurn(round, end, () =>
        second.calls.markPending(key, PENDING, { attempt: 2, attemptOwner: "owner-2" }),
      );

      expect([isEnded, isMoved].filter(Boolean)).toHaveLength(1);
      const found = await first.calls.findByKey(key);
      expect(found?.attemptOwner).toBe(isEnded === true ? "owner-1" : "owner-2");
      expect(found?.status === OutboundCallStatus.Pending).toBe(isMoved);
    }
  },
});

const writeRacingTakeover: OutboundCallCase = {
  name: "#508: a write racing its lease's release and the next take, round after round: it lands before them, or it is refused",
  run: async ({ first, second }) => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const executionId = `execution-${String(round)}`;
      const lease = await leaseOf(first, executionId);
      const key = keyOf(lease);
      await recorded(first, key);
      const handOver = async () => {
        await first.leases.release(lease);
        return leaseOf(second, executionId);
      };

      const write = first.calls.markPending(key, PENDING, { attempt: 2, attemptOwner: "late" });
      const [refused, taken] = await Promise.all([
        rejectionOf(write).catch(() => "landed"),
        handOver(),
      ]);

      const found = await second.calls.findByKey(keyOf(taken));
      if (refused === "landed") expect(found).toMatchObject({ attemptOwner: "late", token: 1 });
      else expect(refused).toBeInstanceOf(ExecutionFencedError);
      if (refused !== "landed") expect(found).toMatchObject({ attemptOwner: "owner-1" });
    }
  },
};

/** The race cases. */
export const outboundRaceCases = (): ContractGroup<OutboundCallStores> => ({
  title: "races",
  cases: [
    movesRaced,
    savesRaced,
    endingRaced("markCompleted"),
    endingRaced("markFailed"),
    writeRacingTakeover,
  ],
});
