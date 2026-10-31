import { expect } from "vitest";
import { systemClock } from "../../infrastructure/clock.js";
import type { ExecutionLeaseRepository } from "../../infrastructure/execution-lease.repository.js";
import type { Milliseconds } from "../../units/index.js";
import { ClockSkew } from "../clock-skew.js";
import type { ContractCase } from "./define.js";

/**
 * The store's time is the authority (#533): two instances whose own clocks disagree — the second
 * offset by ± lease/2, ± lease and ± 10 × lease — agree on a lease's expiry, because the store
 * decides it by its database's time (in-memory and SQLite: the host's), never by the caller's clock.
 * On real time, with a short lease: an instance ahead never takes a live lease, one behind takes an
 * expired one on time, and every answer's `remaining` is in `(0, lease]`.
 */

/** The cases' lease: short, real time. */
const LEASE = 800 as Milliseconds;

/** When the second instance tries: while the lease is live (300 ms left), and 200 ms after it ended. */
const WHILE_LIVE = (LEASE * 5) / 8;
const ONCE_OVER = (LEASE * 10) / 8;

const sleep = (delay: number): Promise<void> => systemClock.sleep(delay as Milliseconds);

/** The second instance's clock, by how far it is off: ahead and behind by lease/2, lease, 10 × lease. */
const OFFSETS: readonly (readonly [string, ClockSkew])[] = [0.5, 1, 10].flatMap((times) => {
  const by = (LEASE * times) as Milliseconds;
  return [
    [`${String(times)} × lease ahead`, ClockSkew.ahead(by)],
    [`${String(times)} × lease behind`, ClockSkew.behind(by)],
  ] as const;
});

/** `remaining` of an answer: some of the lease left, never more than asked for. */
const expectRemaining = (remaining: Milliseconds | undefined): void => {
  expect(remaining).toBeGreaterThan(0);
  expect(remaining).toBeLessThanOrEqual(LEASE);
};

const authorityCase = ([label, secondSkew]: readonly [
  string,
  ClockSkew,
]): ContractCase<ExecutionLeaseRepository> => ({
  name: `#533: with the other instance's clock ${label}, the store's time decides — no take of a live lease, the take of an expired one on time`,
  databaseTime: { secondSkew },
  run: async ({ first, second }) => {
    const held = await first.acquire("default", "root-1", LEASE);
    expectRemaining(held?.remaining);
    expectRemaining(held && (await first.renew(held, LEASE)));

    await sleep(WHILE_LIVE);
    const whileLive = await second.acquire("default", "root-1", LEASE);
    await sleep(ONCE_OVER - WHILE_LIVE);
    const onceOver = await second.acquire("default", "root-1", LEASE);

    expect(whileLive).toBeUndefined();
    expect(onceOver).toMatchObject({ holderInstanceId: "instance-2", leaseEpoch: 2 });
    expectRemaining(onceOver?.remaining);
    expect(held && (await first.renew(held, LEASE))).toBeUndefined();
  },
});

/** One case per offset of the second instance's clock (#533). */
export const LEASE_AUTHORITY_CASES: readonly ContractCase<ExecutionLeaseRepository>[] =
  OFFSETS.map(authorityCase);
