/**
 * #1366: the cost ledger contract's pruning cases (`cost-ledger-pruning.cases.ts`, #771, #817, #869)
 * judge a ledger by what it counts and refuses: each passes on the sound in-memory ledger shared by
 * two instances and FAILS (with an assertion, never a crash) on a ledger that breaks the rule the
 * case names: a read that answers wrong, a refusal with another code or without the expired ids or
 * the mark, a held entry counted again on a second save (also one saved while the prune is still on
 * its way), an instance that loses its saves, a prune that takes a cutoff that is no Date. Also: the
 * racing case starts exactly the saves it names.
 */
import { describe, expect, it } from "vitest";
import {
  CostLedgerRepository,
  InMemoryCostLedgerRepository,
  type BudgetAccount,
  type CostCounter,
  type LedgerEntry,
} from "../../../../src/infrastructure/cost-ledger.repository.js";
import { BudgetScope } from "../../../../src/budgets/budget.js";
import type { Usd } from "../../../../src/units/index.js";
import type { ContractCase } from "../../../../src/testing/contracts/define.js";
import { pruningCases } from "../../../../src/testing/contracts/cost-ledger-pruning.cases.js";

type Who = "first" | "second";
type Case = ContractCase<CostLedgerRepository>;

const JUNK: CostCounter = {
  budget: "junk",
  scope: BudgetScope.Tenant,
  key: "junk",
  period: "junk",
};
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));
const numberOf = (entry: LedgerEntry): number => Number(entry.ledgerId.split(":").pop());

type CutoffFault = "swallowInvalid" | "coerceStrings" | "coerceNumbers" | "otherCode";

interface Faults {
  /** The nth read of a counter (from 1) answers half a dollar more. */
  readonly misread?: (n: number) => boolean;
  /** A refusal of the saves from the nth to the last-th (default: all after) is changed to this. */
  readonly refusal?: {
    readonly from: number;
    readonly last?: number;
    readonly to: (error: ExpiredLike) => Error;
  };
  /** A save of an entry the ledger already holds adds it to the counters again. */
  readonly resaveTwice?: (entry: LedgerEntry) => boolean;
  /** Counters named so are never added to. */
  readonly dropCounter?: (counter: CostCounter) => boolean;
  /** The prune takes effect a moment after it is called. */
  readonly slowPrune?: boolean;
  /** This instance's save of these entries is claimed and counts nowhere. */
  readonly lose?: (who: Who, entries: readonly LedgerEntry[]) => boolean;
  /** What a prune does with a cutoff that is no valid Date. */
  readonly cutoff?: CutoffFault;
}

interface ExpiredLike extends Error {
  readonly code: string;
  readonly ledgerIds: readonly string[];
  readonly prunedBefore: Date;
}

const isExpired = (error: unknown): error is ExpiredLike =>
  error instanceof Error && Reflect.get(error, "code") === "cost-ledger.entry-expired";

interface Shared {
  readonly inner: InMemoryCostLedgerRepository;
  readonly known: Set<string>;
  saves: number;
  reads: number;
  deletes: number;
}

class Faulty extends CostLedgerRepository {
  constructor(
    readonly who: Who,
    readonly shared: Shared,
    readonly faults: Faults,
  ) {
    super();
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  async findSpentByCounter(counter: CostCounter): Promise<Usd> {
    this.shared.reads += 1;
    const spent = await this.shared.inner.findSpentByCounter(counter);
    return this.faults.misread?.(this.shared.reads) === true ? ((spent + 0.5) as Usd) : spent;
  }

  /** What a refused save rejects with here: the refusal as the faults change it. */
  #refusalOf(error: unknown, saveNo: number): unknown {
    const changed = this.faults.refusal;
    const inRange =
      changed !== undefined && saveNo >= changed.from && saveNo <= (changed.last ?? saveNo);
    return inRange && isExpired(error) ? changed.to(error) : error;
  }

  async saveAll(counters: readonly CostCounter[], entries: readonly LedgerEntry[]): Promise<void> {
    const { faults, shared, who } = this;
    shared.saves += 1;
    const saveNo = shared.saves;
    if (faults.lose?.(who, entries) === true) {
      await shared.inner.saveAll([JUNK], entries);
      return;
    }
    const held = entries.filter((one) => shared.known.has(one.ledgerId));
    const claimed = counters.length > 0 ? entries.filter((one) => !held.includes(one)) : [];
    for (const one of claimed) shared.known.add(one.ledgerId);
    const used = counters.filter((counter) => faults.dropCounter?.(counter) !== true);
    try {
      await shared.inner.saveAll(used, entries);
    } catch (error) {
      for (const one of claimed) shared.known.delete(one.ledgerId);
      throw this.#refusalOf(error, saveNo);
    }
    if (faults.resaveTwice !== undefined && counters.length > 0)
      for (const one of held.filter(faults.resaveTwice))
        await shared.inner.saveAll(used, [{ ...one, ledgerId: `${one.ledgerId}#again` }]);
  }

  /** What the inner ledger is asked to prune at: a coerced cutoff, or none when the prune is swallowed. */
  #cutoffOf(cutoff: Date): Date | "swallowed" {
    const { cutoff: fault } = this.faults;
    const valid = cutoff instanceof Date && !Number.isNaN(cutoff.getTime());
    if (!valid && fault === "swallowInvalid") return "swallowed";
    const coerced =
      (fault === "coerceStrings" && typeof cutoff === "string") ||
      (fault === "coerceNumbers" && typeof cutoff === "number");
    if (!coerced) return cutoff;
    const date = new Date(cutoff);
    return Number.isNaN(date.getTime()) ? cutoff : date;
  }

  async deleteByMadeAtBefore(cutoff: Date): Promise<void> {
    const { faults, shared } = this;
    shared.deletes += 1;
    if (faults.slowPrune === true) await tick();
    const asked = this.#cutoffOf(cutoff);
    if (asked === "swallowed") return;
    try {
      await shared.inner.deleteByMadeAtBefore(asked);
    } catch (error) {
      if (faults.cutoff === "otherCode")
        throw Object.assign(new Error("refused"), { code: "other" });
      throw error;
    }
  }

  findMaxSpendByAccount(account: BudgetAccount): Promise<Usd | undefined> {
    return this.shared.inner.findMaxSpendByAccount(account);
  }

  saveMaxSpend(account: BudgetAccount, maxSpend: Usd): Promise<void> {
    return this.shared.inner.saveMaxSpend(account, maxSpend);
  }
}

const pairOf = (faults: Faults = {}) => {
  const shared: Shared = {
    inner: new InMemoryCostLedgerRepository(),
    known: new Set(),
    saves: 0,
    reads: 0,
    deletes: 0,
  };
  return {
    shared,
    first: new Faulty("first", shared, faults),
    second: new Faulty("second", shared, faults),
  };
};

const caseNamed = (start: string): Case => {
  const found = pruningCases().find((one) => one.name.startsWith(start));
  if (found === undefined) throw new Error(`no case ${start}`);
  return found;
};

async function outcomeOf(one: Case, faults: Faults): Promise<"pass" | "assertion" | "crash"> {
  try {
    await one.run(pairOf(faults) as never);
    return "pass";
  } catch (error) {
    return error instanceof Error && error.name === "AssertionError" ? "assertion" : "crash";
  }
}

const RETRIED = "#771: a write retried";
const MARK = "#771: the pruning mark";
const RACING = "#771: saves racing";
const MILLIS = "#817: the mark and the dates";
const CUTOFF = "#817, #869";
const REMOVES = "#771: a prune removes";

/** How many counters each case reads (by the start of its name): every one of them is judged. */
const READS: readonly (readonly [string, number])[] = [
  [REMOVES, 3],
  [RETRIED, 3],
  [MARK, 1],
  [RACING, 4],
  [MILLIS, 1],
  [CUTOFF, 1],
];

const withCode = (error: ExpiredLike, code: string): Error =>
  Object.assign(new Error("refused"), {
    code,
    ledgerIds: error.ledgerIds,
    prunedBefore: error.prunedBefore,
  });
const REFUSALS: readonly (readonly [string, (error: ExpiredLike) => Error])[] = [
  ["another code", (error) => withCode(error, "cost-ledger.other")],
  ["no expired ids", (error) => Object.assign(withCode(error, error.code), { ledgerIds: [] })],
  [
    "the epoch as the mark",
    (error) => Object.assign(withCode(error, error.code), { prunedBefore: new Date(0) }),
  ],
];

describe("#1366: the cost ledger contract's pruning cases", () => {
  it("every case passes on the sound ledger shared by two instances", async () => {
    for (const one of pruningCases()) expect(await outcomeOf(one, {}), one.name).toBe("pass");
  });

  it("every read of a counter in every case is judged: a ledger that misreads any one of them fails the case", async () => {
    for (const one of pruningCases()) {
      const pair = pairOf();
      await one.run(pair as never);
      expect(pair.shared.reads, one.name).toBe(
        READS.find(([start]) => one.name.startsWith(start))?.[1],
      );
      for (let n = 1; n <= pair.shared.reads; n += 1)
        expect(
          await outcomeOf(one, { misread: (at) => at === n }),
          `${one.name} read ${String(n)}`,
        ).toBe("assertion");
    }
  });

  for (const [title, to] of REFUSALS)
    it(`every case but the racing one fails (an assertion) on a ledger whose refusal carries ${title}`, async () => {
      for (const one of pruningCases().filter((each) => !each.name.startsWith(RACING)))
        expect(await outcomeOf(one, { refusal: { from: 1, to } }), one.name).toBe("assertion");
    });

  it("the racing case fails when every refusal has another code", async () => {
    const to = (error: ExpiredLike): Error => withCode(error, "cost-ledger.other");
    expect(await outcomeOf(caseNamed(RACING), { refusal: { from: 1, to } })).toBe("assertion");
  });

  it("the racing case passes on a ledger that holds what its slow prune has not yet taken: the saves are the entries it names", async () => {
    expect(await outcomeOf(caseNamed(RACING), { slowPrune: true })).toBe("pass");
  });

  it("the racing case fails when only the refusals after its own saves have another code", async () => {
    const to = (error: ExpiredLike): Error => withCode(error, "cost-ledger.other");
    expect(await outcomeOf(caseNamed(RACING), { refusal: { from: 21, to } })).toBe("assertion");
  });

  it("the racing case starts exactly twenty racing saves, one prune and twenty saves after it", async () => {
    const pair = pairOf();
    await caseNamed(RACING).run(pair as never);
    expect(pair.shared.saves).toBe(40);
    expect(pair.shared.deletes).toBe(1);
  });

  for (const start of [REMOVES, RETRIED, MARK, MILLIS])
    it(`"${start}" fails (an assertion) on a ledger that counts a held entry again`, async () => {
      expect(await outcomeOf(caseNamed(start), { resaveTwice: () => true })).toBe("assertion");
    });

  it("the racing case fails on a ledger that counts a held entry again while its prune is on its way", async () => {
    expect(await outcomeOf(caseNamed(RACING), { resaveTwice: () => true, slowPrune: true })).toBe(
      "assertion",
    );
  });

  it("the racing case fails when only the refusals of its racing saves after the prune have another code", async () => {
    const to = (error: ExpiredLike): Error => withCode(error, "cost-ledger.other");
    expect(await outcomeOf(caseNamed(RACING), { refusal: { from: 11, last: 20, to } })).toBe(
      "assertion",
    );
  });

  it("the racing case fails on a ledger that counts an entry again but the first one, while its prune is on its way", async () => {
    const resaveTwice = (one: LedgerEntry): boolean => numberOf(one) > 0;
    expect(await outcomeOf(caseNamed(RACING), { resaveTwice, slowPrune: true })).toBe("assertion");
  });

  it("the racing case fails on a ledger that does not count an execution budget, key or period", async () => {
    const budget = (counter: CostCounter): boolean => counter.budget === "execution-budget";
    const key = (counter: CostCounter): boolean => counter.key === "run-1";
    const period = (counter: CostCounter): boolean => counter.period === "";
    for (const dropCounter of [budget, key, period])
      expect(await outcomeOf(caseNamed(RACING), { dropCounter })).toBe("assertion");
  });

  it("the racing case fails on a ledger where the first instance loses the even entries but the first it saves", async () => {
    const lose = (who: Who, entries: readonly LedgerEntry[]): boolean =>
      who === "first" && entries.some((one) => numberOf(one) > 0 && numberOf(one) % 2 === 0);
    expect(await outcomeOf(caseNamed(RACING), { lose })).toBe("assertion");
  });

  it("the racing case fails on a ledger where the first instance loses the even entries it saves", async () => {
    const lose = (who: Who, entries: readonly LedgerEntry[]): boolean =>
      who === "first" && entries.some((one) => numberOf(one) % 2 === 0);
    expect(await outcomeOf(caseNamed(RACING), { lose })).toBe("assertion");
  });

  it("the racing case fails on a ledger where the second instance loses the odd entries it saves", async () => {
    const lose = (who: Who, entries: readonly LedgerEntry[]): boolean =>
      who === "second" && entries.some((one) => numberOf(one) % 2 === 1);
    expect(await outcomeOf(caseNamed(RACING), { lose })).toBe("assertion");
  });

  for (const cutoff of ["swallowInvalid", "coerceStrings", "coerceNumbers", "otherCode"] as const)
    it(`the invalid cutoff case fails (an assertion) on a ledger where a prune ${cutoff}`, async () => {
      expect(await outcomeOf(caseNamed(CUTOFF), { cutoff })).toBe("assertion");
    });
});
