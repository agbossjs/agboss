import { expect } from "vitest";
import { systemClock } from "../../infrastructure/clock.js";
import type {
  ExecutionLease,
  ExecutionLeaseRepository,
} from "../../infrastructure/execution-lease.repository.js";
import type { Milliseconds } from "../../units/index.js";
import { ClockSkew } from "../clock-skew.js";
import type { ContractCase } from "./define.js";

/**
 * The store's time is the authority (#533): two instances whose own clocks disagree — the second
 * offset by ± lease/2, ± lease and ± 10 × lease — agree on a lease's expiry, because the store
 * decides it by its database's time (in-memory and SQLite: the host's), never by the caller's clock.
 * On real time, with a short lease: an instance ahead never takes a live lease, one behind takes an
 * expired one on time, and every answer's `remaining` is in `(0, lease]`.
 *
 * Timed, never guessed (#762): each call's real start and end are measured, and an attempt is judged
 * only when they prove both outcomes — the lease surely live at the first try and surely over at the
 * second by the store's time, and surely the other way round by the skewed caller's (a store on the
 * caller's clock fails every judged attempt). A runner stalled past a margin makes the attempt
 * untimed: it is run again on a fresh tree, and a case with no timed attempt fails — never a pass.
 */

/** The cases' lease: short, real time. */
const LEASE = 800 as Milliseconds;

/** When the second instance tries: while the lease is live (300 ms left), and 200 ms after it ended. */
const WHILE_LIVE = (LEASE * 5) / 8;
const ONCE_OVER = (LEASE * 10) / 8;

/** How far inside a window a call must land to count: the clocks' read and rounding error. */
const GUARD = 50;

/** The attempts a case makes before it fails as untimed. */
const ATTEMPTS = 10;

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

/** A call's real start and end (ms, monotonic). */
interface Span {
  readonly start: number;
  readonly end: number;
}

/** `call`, and when it ran. */
async function timed<T>(
  call: () => Promise<T>,
): Promise<{ readonly value: T; readonly span: Span }> {
  const start = systemClock.monotonicNow();
  const value = await call();
  return { value, span: { start, end: systemClock.monotonicNow() } };
}

/** When one attempt's calls ran: the take, the renewal, the second's two tries. */
interface Schedule {
  readonly take: Span;
  readonly renewal: Span;
  readonly whileLive: Span;
  readonly onceOver: Span;
}

/**
 * Whether `schedule` proves the outcomes: the renewal inside the first lease, the first try surely
 * before the renewed lease's end and the second surely after it (the store's time), and — for the
 * second's clock `offset` ms off — its try surely past that end by its own clock (ahead) or surely
 * before it at its second try (behind). The store's and the caller's views then differ in every
 * judged attempt.
 */
export function isTimed(schedule: Schedule, offset: number): boolean {
  const { take, renewal, whileLive, onceOver } = schedule;
  const isStoreTimed =
    renewal.end - take.start < LEASE - GUARD &&
    whileLive.end - renewal.start < LEASE - GUARD &&
    onceOver.start - renewal.end >= LEASE + GUARD;
  const isCallerTimed =
    offset > 0
      ? whileLive.start + offset - renewal.end >= LEASE + GUARD
      : onceOver.end + offset - renewal.start < LEASE - GUARD;
  return isStoreTimed && isCallerTimed;
}

/** One attempt on `root`: its answers and when they came. */
interface Attempt {
  readonly held: ExecutionLease | undefined;
  readonly renewed: Milliseconds | undefined;
  readonly whileLive: ExecutionLease | undefined;
  readonly onceOver: ExecutionLease | undefined;
  readonly schedule: Schedule;
}

async function attemptOn(
  {
    first,
    second,
  }: { readonly first: ExecutionLeaseRepository; readonly second: ExecutionLeaseRepository },
  root: string,
): Promise<Attempt> {
  const take = await timed(() => first.acquire("default", root, LEASE));
  const held = take.value;
  const renewal = await timed(async () => (held ? first.renew(held, LEASE) : undefined));
  await sleep(WHILE_LIVE);
  const whileLive = await timed(() => second.acquire("default", root, LEASE));
  await sleep(ONCE_OVER - WHILE_LIVE);
  const onceOver = await timed(() => second.acquire("default", root, LEASE));
  return {
    held,
    renewed: renewal.value,
    whileLive: whileLive.value,
    onceOver: onceOver.value,
    schedule: {
      take: take.span,
      renewal: renewal.span,
      whileLive: whileLive.span,
      onceOver: onceOver.span,
    },
  };
}

const spanText = ({ start, end }: Span, from: number): string =>
  `${String(Math.round(start - from))}–${String(Math.round(end - from))} ms`;

const scheduleText = (schedule: Schedule): string =>
  `take ${spanText(schedule.take, schedule.take.start)}, renewal ${spanText(schedule.renewal, schedule.take.start)}, tries ${spanText(schedule.whileLive, schedule.take.start)} and ${spanText(schedule.onceOver, schedule.take.start)}`;

const authorityCase = ([label, secondSkew]: readonly [
  string,
  ClockSkew,
]): ContractCase<ExecutionLeaseRepository> => ({
  name: `#533: with the other instance's clock ${label}, the store's time decides — no take of a live lease, the take of an expired one on time`,
  databaseTime: { secondSkew },
  run: async (instances) => {
    const untimed: string[] = [];
    for (let at = 1; at <= ATTEMPTS; at += 1) {
      const attempt = await attemptOn(instances, `root-${String(at)}`);
      if (!isTimed(attempt.schedule, secondSkew.offset)) {
        untimed.push(scheduleText(attempt.schedule));
        continue;
      }
      expectRemaining(attempt.held?.remaining);
      expectRemaining(attempt.renewed);
      expect(attempt.whileLive).toBeUndefined();
      expect(attempt.onceOver).toMatchObject({ holderInstanceId: "instance-2", leaseEpoch: 2 });
      expectRemaining(attempt.onceOver?.remaining);
      expect(attempt.held && (await instances.first.renew(attempt.held, LEASE))).toBeUndefined();
      return;
    }
    throw new Error(
      `#762: no attempt of ${String(ATTEMPTS)} ran on time, so none proves the store's time decides (the runner stalled past a ${String(GUARD)} ms margin): ${untimed.join("; ")}`,
    );
  },
});

/** One case per offset of the second instance's clock (#533). */
export const LEASE_AUTHORITY_CASES: readonly ContractCase<ExecutionLeaseRepository>[] =
  OFFSETS.map(authorityCase);
