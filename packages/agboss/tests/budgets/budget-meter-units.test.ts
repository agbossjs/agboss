/**
 * #633 (money shard) — the budget meter on its own (`BudgetMeter`, #261 PR 5, #338, #685): what it
 * counts in a check, what it may still spend, a child's spend recorded on another instance taken in
 * once — never counted from the ledger and the state both, never subtracted twice —, and the
 * ledger's round trips: none for nothing to write or read.
 */
import { describe, expect, it } from "vitest";
import { Budget, BudgetScope, type BudgetHandler } from "../../src/budgets/budget.js";
import { DeadlineExceededError } from "../../src/budgets/execution-deadline.js";
import {
  BudgetMeter,
  budgetsOfExecution,
  counterOf,
  NO_BUDGET_CHECK,
  type ExecutionBudgetRecord,
} from "../../src/budgets/execution-budgets.js";
import { LedgerState } from "../../src/finops/ledger-mark.js";
import { recordToolCost, type UsageRecord } from "../../src/finops/usage.js";
import { ledgerEntryOf } from "../helpers.js";
import { BudgetExceededError } from "../../src/graph/limits.js";
import {
  InMemoryCostLedgerRepository,
  type CostCounter,
  type LedgerEntry,
} from "../../src/infrastructure/cost-ledger.repository.js";
import { VirtualClock } from "../../src/testing/index.js";
import { seconds, usd, type Usd } from "../../src/units/index.js";

const NOW = new Date("2026-10-20T12:00:00.000Z");

const budget = (name: string, maxSpend: number): ExecutionBudgetRecord => ({
  budget: { name },
  scope: BudgetScope.Execution,
  key: "execution-1",
  maxSpend,
});

/** A model call's spend made on this instance. */
const here = (costUsd: number, caller = "clerk-agent"): UsageRecord => ({
  ...recordToolCost(caller, costUsd),
});

/** A remote child's spend, written to the ledger by its own instance (#333 PR 3). */
const elsewhere = (costUsd: number, caller = "child-agent"): UsageRecord => ({
  ...recordToolCost(caller, costUsd),
  ledger: { state: LedgerState.RecordedElsewhere },
});

/** A ledger that counts its round trips. */
class CountedLedger extends InMemoryCostLedgerRepository {
  reads = 0;
  readonly writes: (readonly CostCounter[])[] = [];

  override findSpentByCounter(counter: CostCounter): Promise<Usd> {
    this.reads += 1;
    return super.findSpentByCounter(counter);
  }

  override saveAll(counters: readonly CostCounter[], records: readonly LedgerEntry[]) {
    this.writes.push(counters);
    return super.saveAll(counters, records);
  }
}

function meterOn(
  records: readonly ExecutionBudgetRecord[],
  spentBefore = 0,
  deadline?: { readonly at: string; readonly deadline: ReturnType<typeof seconds> },
) {
  const ledger = new CountedLedger();
  const clock = new VirtualClock(NOW);
  const meter = new BudgetMeter(records, ledger, clock, spentBefore, deadline);
  return { ledger, meter, clock };
}

const thrown = (run: () => void): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe("#633: a check counts what the meter recorded and tallied", () => {
  it("$0.50 recorded and $0.20 tallied: a $0.70 budget is exhausted, though the caller saw none", async () => {
    const { meter } = meterOn([budget("execution-budget", 0.7)], 1);
    await meter.record([here(0.5)]);
    meter.tally([here(0.2)]);

    const error = thrown(() => {
      meter.check(0, ["clerk-agent"]);
    });

    expect(error).toBeInstanceOf(BudgetExceededError);
    expect((error as BudgetExceededError).spentUsd).toBeCloseTo(1.7);
  });

  it("a tally of nothing new never stops a pass already over its budget", async () => {
    const { meter, ledger } = meterOn([budget("execution-budget", 1)]);
    await ledger.saveAll([counterOf(budget("execution-budget", 1), NOW)], [ledgerEntryOf(here(1))]);
    await meter.refresh();

    meter.tally([]);
    meter.tally([elsewhere(5)]);

    expect(meter.exhausted.aborted).toBe(false);
  });

  it("a tally that exhausts: the abort's error names the tally's path, [] by default", () => {
    const first = meterOn([budget("execution-budget", 1)]);
    const second = meterOn([budget("execution-budget", 1)]);

    first.meter.tally([here(1)]);
    second.meter.tally([here(1)], ["writer-agent"]);

    expect((first.meter.exhausted.reason as BudgetExceededError).path).toEqual([]);
    expect((second.meter.exhausted.reason as BudgetExceededError).path).toEqual(["writer-agent"]);
  });

  it("a deadline passed: the error carries the check's path, spend and usage", () => {
    const at = "2026-10-20T11:59:59.000Z";
    const { meter } = meterOn([budget("execution-budget", 100)], 0, { at, deadline: seconds(5) });
    const usage = [here(0.25)];

    const error = thrown(() => {
      meter.check(0.25, ["clerk-agent"], usage);
    });

    expect(error).toBeInstanceOf(DeadlineExceededError);
    expect(error).toMatchObject({ path: ["clerk-agent"], spentUsd: 0.25, usage });
  });

  it("no budgets: nothing is tallied, taken in or recorded — a deadline's error carries the caller's spend only", async () => {
    const at = "2026-10-20T11:59:59.000Z";
    const { meter } = meterOn([], 0, { at, deadline: seconds(5) });
    meter.tally([here(3)]);
    await meter.takeRecordedElsewhere([elsewhere(3)]);
    await meter.record([here(3), elsewhere(5)]);

    const error = thrown(() => {
      meter.check(0.25, []);
    });

    expect(error).toMatchObject({ spentUsd: 0.25 });
    expect(meter.exhausted.aborted).toBe(false);
  });
});

describe("#633: what the execution may still spend", () => {
  it("remaining: the least any budget has left after what the meter knows of", async () => {
    const { meter } = meterOn([budget("wide-budget", 10), budget("narrow-budget", 3)], 1);
    await meter.record([here(0.5)]);
    meter.tally([here(0.25)]);

    expect(meter.remaining()).toBeCloseTo(2.25);
  });

  it("budgetUsd: the least left at the last read, plus what was spent before the pass", async () => {
    const { meter, ledger } = meterOn([budget("execution-budget", 3)], 1);
    const counter = counterOf(budget("execution-budget", 3), NOW);
    await ledger.saveAll([counter], [ledgerEntryOf(here(1))]);
    await meter.refresh();

    expect(meter.budgetUsd()).toBeCloseTo(3);
  });

  it("no budgets: both Infinity", () => {
    const { meter } = meterOn([]);

    expect([meter.remaining(), meter.budgetUsd()]).toEqual([Infinity, Infinity]);
  });
});

describe("#685: a child's spend recorded elsewhere counts once", () => {
  /** A meter whose ledger already holds the child's spend its instance wrote. */
  async function withChildSpend(maxSpend: number, child: readonly UsageRecord[]) {
    const parts = meterOn([budget("execution-budget", maxSpend)]);
    const counter = counterOf(budget("execution-budget", maxSpend), NOW);
    await parts.ledger.saveAll(
      [counter],
      child.map((record) => ledgerEntryOf(record)),
    );
    return parts;
  }

  it("taken in before the state shows it: a read holds it once, not twice", async () => {
    const child = [elsewhere(0.3)];
    const { meter } = await withChildSpend(0.5, child);

    await meter.takeRecordedElsewhere(child);
    const atTakeIn = thrown(() => {
      meter.check(0.3, []);
    });
    await meter.refresh();

    expect(atTakeIn).toBeUndefined();
    expect(() => {
      meter.check(0.3, []);
    }).not.toThrow();
    expect(meter.remaining()).toBeCloseTo(0.2);
  });

  it("taken in, then reaching record with the state: counted once — never subtracted twice", async () => {
    const child = [elsewhere(0.3)];
    const { meter } = await withChildSpend(0.3, child);

    await meter.takeRecordedElsewhere(child);
    await meter.record(child);
    await meter.refresh();

    expect(() => {
      meter.check(0.3, []);
    }).toThrow(BudgetExceededError);
    // what the execution may spend in all: the budget, its own $0.30 in it once
    expect(meter.budgetUsd()).toBeCloseTo(0.3);
  });

  it("two taken in, recorded one superstep at a time: the second is not taken in again", async () => {
    const [first, second] = [elsewhere(0.2, "child-a"), elsewhere(0.2, "child-b")];
    const { meter } = await withChildSpend(0.4, [first, second]);

    await meter.takeRecordedElsewhere([first, second]);
    await meter.record([first]);
    await meter.record([second]);
    await meter.refresh();

    expect(() => {
      meter.check(0.4, []);
    }).toThrow(BudgetExceededError);
    expect(meter.budgetUsd()).toBeCloseTo(0.4);
  });

  it("reaching record without a take-in first: taken in there, so a later read holds it once", async () => {
    const child = [elsewhere(0.3)];
    const { meter } = await withChildSpend(0.5, child);

    await meter.record(child);
    await meter.refresh();

    expect(() => {
      meter.check(0.3, []);
    }).not.toThrow();
  });

  it("own spend among the records: never taken in as written elsewhere", async () => {
    const { meter, ledger } = meterOn([budget("execution-budget", 1)]);

    await meter.takeRecordedElsewhere([here(0.4)]);

    expect(ledger.reads).toBe(0);
    expect(meter.remaining()).toBe(1);
  });
});

describe("#633: the meter's round trips", () => {
  it("tally: what this pass spent written at once to every counter, then read; its kept records recorded write nothing more (#727)", async () => {
    const { meter, ledger } = meterOn([budget("one-budget", 1), budget("two-budget", 1)]);
    const kept = meter.tally([here(0.25, "first-agent"), here(0.25, "second-agent")]);

    await meter.settled();
    const readAfterWrite = ledger.reads;
    await meter.record(kept);

    expect(ledger.writes.map((counters) => counters.map((each) => each.budget))).toEqual([
      ["one-budget", "two-budget"],
    ]);
    expect(readAfterWrite).toBe(2);
    expect(ledger.reads).toBe(2);
    expect(meter.remaining()).toBeCloseTo(0.5);
  });

  it("only spend recorded elsewhere: nothing written", async () => {
    const { meter, ledger } = meterOn([budget("execution-budget", 1)]);

    await meter.record([elsewhere(0.2)]);

    expect(ledger.writes).toEqual([]);
  });

  it("no budgets: nothing written or read, whatever is recorded or taken in", async () => {
    const { meter, ledger } = meterOn([]);

    await meter.record([here(1), elsewhere(1)]);
    await meter.takeRecordedElsewhere([elsewhere(1)]);

    expect({ writes: ledger.writes, reads: ledger.reads }).toEqual({ writes: [], reads: 0 });
  });
});

@Budget({ name: "other-workflow-execution-budget", scope: BudgetScope.Execution, workflow: Object })
class OtherWorkflowBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}

@Budget({ name: "default-execution-budget", scope: BudgetScope.Execution })
class DefaultExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}

/** A class listed among the budgets without `@Budget`. */
class NotABudget {
  readonly name = "not-a-budget";
}

describe("#633: an execution's budgets", () => {
  it("another workflow's execution budget is not the default; a class without @Budget is none", () => {
    const ThisWorkflow = class {
      readonly name = "this-workflow";
    };

    const chosen = budgetsOfExecution(
      [NotABudget, OtherWorkflowBudget, DefaultExecutionBudget],
      ThisWorkflow,
    );

    expect(chosen.map((each) => each.meta.name)).toEqual(["default-execution-budget"]);
  });

  it("NO_BUDGET_CHECK checks and tallies nothing", () => {
    NO_BUDGET_CHECK.tally([here(1_000)]);

    expect(() => {
      NO_BUDGET_CHECK.check(1_000, []);
    }).not.toThrow();
    expect(NO_BUDGET_CHECK.exhausted.aborted).toBe(false);
  });
});
