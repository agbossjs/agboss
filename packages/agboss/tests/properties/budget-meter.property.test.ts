/**
 * #685 — the budget meter counts every dollar once, whatever order its ledger round trips finish
 * in. fast-check's scheduler interleaves every read and write of the shared ledger; a tree's pass
 * spends on its own (tallied as made, written at its superstep's end), a child on another instance
 * writes its spend at once and the parent takes it in before its state shows it, another tree of
 * the tenant writes beside them, and the parent reads its counters at any moment. At every check
 * the meter's count of each counter lies between what the tree's state holds and what was really
 * spent (never twice, the false stop; never less than the state, the bypass), and once everything
 * is written a fresh read gives exactly the sum of the spend.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BudgetPeriod, BudgetScope } from "../../src/budgets/budget.js";
import { counterOf, meterOf, type BudgetMeter } from "../../src/budgets/execution-budgets.js";
import type { ExecutionBudgetRecord } from "../../src/budgets/execution-budgets.js";
import { recordToolCost, type UsageRecord } from "../../src/finops/usage.js";
import {
  InMemoryCostLedgerRepository,
  type CostCounter,
} from "../../src/infrastructure/cost-ledger.repository.js";
import { systemClock } from "../../src/infrastructure/clock.js";
import { BudgetExceededError } from "../../src/index.js";
import type { Usd } from "../../src/units/index.js";
import { seededProperties } from "../helpers/property-seed.js";

const seed = seededProperties("budget-meter.property.test.ts");

/** A ledger whose every round trip finishes when the scheduler says. */
class ScheduledLedger extends InMemoryCostLedgerRepository {
  constructor(private readonly scheduler: fc.Scheduler) {
    super();
  }

  /** What the counter holds, read past the scheduler: after the moves. */
  writtenOf(counter: CostCounter): Promise<Usd> {
    return super.findSpentByCounter(counter);
  }

  override async findSpentByCounter(counter: CostCounter): Promise<Usd> {
    await this.scheduler.schedule(Promise.resolve(), "read");
    return super.findSpentByCounter(counter);
  }

  override async saveAll(
    counters: readonly CostCounter[],
    records: readonly UsageRecord[],
  ): Promise<void> {
    await this.scheduler.schedule(Promise.resolve(), "write");
    await super.saveAll(counters, records);
  }
}

/** Every counter at a zero limit: a check always throws, naming what the first one holds. */
const budgetOf = (scope: BudgetScope): ExecutionBudgetRecord =>
  scope === BudgetScope.Execution
    ? { budget: { name: "execution" }, scope, key: "execution-1", maxSpend: 0 }
    : { budget: { name: "tenant" }, scope, period: BudgetPeriod.Day, key: "acme", maxSpend: 0 };

/** What the meter counts for its one budget when the tree's state holds `stateSpent`. */
function countedBy(meter: BudgetMeter, stateSpent: number): number {
  try {
    meter.check(stateSpent, []);
  } catch (error) {
    if (error instanceof BudgetExceededError) return error.spent;
    throw error;
  }
  throw new Error("a zero limit always throws");
}

type Move =
  | { readonly kind: "own"; readonly cents: number }
  | { readonly kind: "remote"; readonly cents: number }
  | { readonly kind: "other"; readonly cents: number }
  | { readonly kind: "refresh" };

const cents = fc.integer({ min: 1, max: 5000 });
const moveArbitrary: fc.Arbitrary<Move> = fc.oneof(
  fc.record({ kind: fc.constant("own" as const), cents }),
  fc.record({ kind: fc.constant("remote" as const), cents }),
  fc.record({ kind: fc.constant("other" as const), cents }),
  fc.constant({ kind: "refresh" as const }),
);

/** One tree's pass and its world: what was spent, what its state holds, its checks. */
class World {
  readonly ledger: ScheduledLedger;
  readonly parent: BudgetMeter;
  spent = 0;
  stateSpent = 0;
  readonly counts: {
    readonly counted: number;
    readonly floor: number;
    readonly ceiling: number;
  }[] = [];

  constructor(
    scheduler: fc.Scheduler,
    readonly scope: BudgetScope,
  ) {
    this.ledger = new ScheduledLedger(scheduler);
    this.parent = this.meter();
  }

  meter(record = budgetOf(this.scope)): BudgetMeter {
    return meterOf({ ledger: this.ledger, clock: systemClock }, [record], 0);
  }

  /** A check now: the count between the state's spend and the real spend. */
  look(): void {
    const counted = countedBy(this.parent, this.stateSpent);
    this.counts.push({ counted, floor: this.stateSpent, ceiling: this.spent });
  }

  /** The pass's own call: tallied as made, written at its superstep's end. */
  async own(record: UsageRecord): Promise<void> {
    this.spent += record.costUsd;
    this.parent.tally([record]);
    this.stateSpent += record.costUsd;
    this.look();
    await this.parent.record([record]);
    this.look();
  }

  /** A child's call on another instance: written there at once, taken in by the parent, recorded. */
  async remote(record: UsageRecord): Promise<void> {
    const worker = this.meter({ ...budgetOf(this.scope), maxSpend: Number.POSITIVE_INFINITY });
    await worker.record([record]);
    this.spent += record.costUsd;
    this.look();
    const elsewhere = { ...record, isRecordedElsewhere: true };
    await this.parent.takeRecordedElsewhere([elsewhere]);
    this.stateSpent += record.costUsd;
    this.look();
    await this.parent.record([elsewhere]);
    this.look();
  }

  /** Another tree of the tenant: its spend counts in the tenant's counter, not the execution's. */
  async other(record: UsageRecord): Promise<void> {
    const tenant = { ...budgetOf(BudgetScope.Tenant), maxSpend: Number.POSITIVE_INFINITY };
    const elsewhere = meterOf({ ledger: this.ledger, clock: systemClock }, [tenant], 0);
    await elsewhere.record([record]);
    if (this.scope === BudgetScope.Tenant) this.spent += record.costUsd;
    this.look();
  }

  async refresh(): Promise<void> {
    await this.parent.refresh();
    this.look();
  }

  play(move: Move): Promise<void> {
    if (move.kind === "refresh") return this.refresh();
    const record = recordToolCost("paid-api", move.cents / 100);
    if (move.kind === "own") return this.own(record);
    if (move.kind === "remote") return this.remote(record);
    return this.other(record);
  }
}

const countsOnce = (scope: BudgetScope) =>
  fc.asyncProperty(
    fc.scheduler(),
    fc.array(moveArbitrary, { minLength: 1, maxLength: 12 }),
    async (scheduler, moves) => {
      const world = new World(scheduler, scope);
      // the moves at once, then a read once all is written: every round trip in the scheduler's order
      const played = Promise.all(moves.map((move) => world.play(move))).then(() => world.refresh());
      await scheduler.waitFor(played);
      for (const { counted, floor, ceiling } of world.counts) {
        // a dollar counted twice is a false stop; one below the state's spend a bypass
        expect(counted).toBeLessThanOrEqual(ceiling + 1e-9);
        expect(counted).toBeGreaterThanOrEqual(floor - 1e-9);
      }
      expect(world.counts.at(-1)?.counted).toBeCloseTo(world.spent, 9);
      const written = await world.ledger.writtenOf(counterOf(budgetOf(scope), systemClock.now()));
      expect(written).toBeCloseTo(world.spent, 9);
    },
  );

describe(`#685: the meter counts every dollar once (seed ${String(seed)})`, () => {
  it("the execution's counter, in any order of the ledger's round trips", async () => {
    await fc.assert(countsOnce(BudgetScope.Execution), { numRuns: 300 });
  });

  it("the tenant's counter, beside the tenant's other trees", async () => {
    await fc.assert(countsOnce(BudgetScope.Tenant), { numRuns: 300 });
  });
});
