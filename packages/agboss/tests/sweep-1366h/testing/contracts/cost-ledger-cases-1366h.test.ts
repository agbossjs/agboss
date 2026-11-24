/**
 * #1366: the cost ledger contract's own cases (`cost-ledger.contract.ts`) judge a ledger by what it
 * answers: each passes on the sound in-memory ledger shared by two instances and FAILS (with an
 * assertion) on a ledger that breaks the rule the case names — an instance whose save is lost, a
 * counter that is skipped, a duplicate counted, a record that is no entry accepted, a refusal with
 * a wrong index or code, a partial save, a limit that is not the last — and on a ledger that
 * mishandles the names the cases save under (a budget, a key, an empty period).
 */
import { describe, expect, it, vi } from "vitest";
import { BudgetScope } from "../../../../src/budgets/budget.js";
import { CostLedgerEntryInvalidError } from "../../../../src/finops/ledger-mark.js";
import {
  CostLedgerRepository,
  InMemoryCostLedgerRepository,
  type BudgetAccount,
  type CostCounter,
  type LedgerEntry,
  type BudgetLimit,
  type BudgetUsage,
} from "../../../../src/infrastructure/cost-ledger.repository.js";
import type { Usd } from "../../../../src/units/index.js";
import type { ContractCase } from "../../../../src/testing/contracts/define.js";

const captured = vi.hoisted(() => ({ cases: [] as unknown[] }));
vi.mock("../../../../src/testing/contracts/define.js", async (original) => {
  const actual = await original<typeof import("../../../../src/testing/contracts/define.js")>();
  return {
    ...actual,
    registerContract: (
      _name: string,
      _target: unknown,
      groups: readonly { cases: unknown[] }[],
    ) => {
      captured.cases = groups[0]?.cases ?? [];
    },
  };
});

type Who = "first" | "second";
type Case = ContractCase<CostLedgerRepository>;

const JUNK: CostCounter = {
  budget: "junk",
  scope: BudgetScope.Tenant,
  key: "junk",
  period: "junk",
};

/** What a store accepts as an entry (a refusal is raised for the rest). */
type Accepts = (record: unknown) => boolean;

interface Faults {
  /** This save is lost: its ids are claimed, nothing is added to the counters it names. */
  readonly lose?: (who: Who, saveNo: number, ofWho: number) => boolean;
  /** This counter (by position in the save) gets nothing from this instance's save. */
  readonly skipCounter?: (who: Who, index: number) => boolean;
  /** A save without counters still keeps the ids (a later save of one adds nothing). */
  readonly keepsIdsWithoutCounters?: boolean;
  /** An id twice in one save is added twice. */
  readonly batchDuplicateTwice?: boolean;
  /** Counters named so are never added to. */
  readonly dropCounter?: (counter: CostCounter) => boolean;
  /** A lookup reads another counter (the store folds a name). */
  readonly foldCounter?: (counter: CostCounter) => CostCounter;
  /** A lookup of a limit reads another account. */
  readonly foldAccount?: (account: BudgetAccount) => BudgetAccount;
  /** What the store accepts as an entry: the rest is refused (default: only what is sound). */
  readonly accepts?: Accepts;
  /** Validation runs only when the save has (true) or has no (false) counters. */
  readonly validatesOnlyWhen?: "counters" | "noCounters";
  /** What an entry refusal reports: the index and the code. */
  readonly refusal?: (index: number, hasCounters: boolean) => { index: number; code: string };
  /** A refused save still adds the entries before the bad one. */
  readonly partialRefusal?: boolean;
  /** A refused save still claims the ids of the entries before the bad one, adds nothing. */
  readonly claimingRefusal?: boolean;
  /** The limit that is read while nothing was saved is `usd(0)`. */
  readonly zeroLimitBeforeAnySave?: boolean;
  /** The first limit saved stays. */
  readonly firstLimitWins?: boolean;
}

const isSoundEntry: Accepts = (record) => {
  if (typeof record !== "object" || record === null) return false;
  const { ledgerId, madeAt, costUsd } = record as Partial<LedgerEntry>;
  return (
    typeof ledgerId === "string" &&
    ledgerId !== "" &&
    madeAt instanceof Date &&
    !Number.isNaN(madeAt.getTime()) &&
    typeof costUsd === "number" &&
    Number.isFinite(costUsd) &&
    costUsd >= 0
  );
};

interface Shared {
  readonly inner: InMemoryCostLedgerRepository;
  saves: number;
  readonly byWho: Record<Who, number>;
  savedLimit: boolean;
}

/** One instance of the ledger: the sound in-memory store on the shared state, with the faults. */
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

  findUsageByCounter(counter: CostCounter): Promise<BudgetUsage> {
    return this.shared.inner.findUsageByCounter(this.faults.foldCounter?.(counter) ?? counter);
  }

  /** Refuses (or lets pass) what is no entry; true when the save goes on. */
  async #checked(
    counters: readonly CostCounter[],
    entries: readonly LedgerEntry[],
  ): Promise<boolean> {
    const { faults, shared } = this;
    const hasCounters = counters.length > 0;
    const validates =
      faults.validatesOnlyWhen === undefined ||
      (faults.validatesOnlyWhen === "counters") === hasCounters;
    if (!validates) return !entries.some((record) => !isSoundEntry(record));
    const accepts = faults.accepts ?? isSoundEntry;
    const index = entries.findIndex((record) => !accepts(record));
    if (index === -1) return true;
    const said = faults.refusal?.(index, hasCounters) ?? { index, code: "" };
    if (faults.partialRefusal === true)
      await shared.inner.saveAll(counters, entries.slice(0, index));
    if (faults.claimingRefusal === true)
      await shared.inner.saveAll([JUNK], entries.slice(0, index));
    throw said.code === ""
      ? new CostLedgerEntryInvalidError({ index: said.index, reason: "no entry" })
      : Object.assign(new Error("refused"), { code: said.code, index: said.index });
  }

  async saveAll(counters: readonly CostCounter[], entries: readonly LedgerEntry[]): Promise<void> {
    const { faults, shared, who } = this;
    shared.saves += 1;
    shared.byWho[who] += 1;
    const lost = faults.lose?.(who, shared.saves, shared.byWho[who]) === true;
    if (!(await this.#checked(counters, entries))) return;
    if (lost) return shared.inner.saveAll([JUNK], entries);
    if (counters.length === 0) {
      if (faults.keepsIdsWithoutCounters === true) await shared.inner.saveAll([JUNK], entries);
      return;
    }
    const used = counters.filter(
      (counter, index) =>
        faults.skipCounter?.(who, index) !== true && faults.dropCounter?.(counter) !== true,
    );
    await shared.inner.saveAll(used, entries);
    if (faults.batchDuplicateTwice === true) await this.#addDuplicates(used, entries);
  }

  async #addDuplicates(
    used: readonly CostCounter[],
    entries: readonly LedgerEntry[],
  ): Promise<void> {
    const seen = new Set<string>();
    for (const one of entries) {
      if (seen.has(one.ledgerId))
        await this.shared.inner.saveAll(used, [{ ...one, ledgerId: `${one.ledgerId}#again` }]);
      seen.add(one.ledgerId);
    }
  }

  deleteByMadeAtBefore(cutoff: Date): Promise<void> {
    return this.shared.inner.deleteByMadeAtBefore(cutoff);
  }

  findLimitByAccount(account: BudgetAccount): Promise<BudgetLimit | undefined> {
    const { faults, shared } = this;
    if (faults.zeroLimitBeforeAnySave === true && !shared.savedLimit)
      return Promise.resolve({ maxSpend: 0 as Usd });
    return shared.inner.findLimitByAccount(faults.foldAccount?.(account) ?? account);
  }

  async saveLimit(account: BudgetAccount, limit: BudgetLimit): Promise<void> {
    if (this.faults.firstLimitWins === true && this.shared.savedLimit) return;
    this.shared.savedLimit = true;
    await this.shared.inner.saveLimit(account, limit);
  }
}

const pairOf = (faults: Faults = {}) => {
  const shared: Shared = {
    inner: new InMemoryCostLedgerRepository(),
    saves: 0,
    byWho: { first: 0, second: 0 },
    savedLimit: false,
  };
  return {
    first: new Faulty("first", shared, faults),
    second: new Faulty("second", shared, faults),
  };
};

const caseNamed = (start: string): Case => {
  const found = (captured.cases as Case[]).find((one) => one.name.startsWith(start));
  if (found === undefined) throw new Error(`no case ${start}`);
  return found;
};

/** How the named case ends on a store with `faults`: pass, an assertion, or a crash. */
async function outcomeOf(start: string, faults: Faults): Promise<"pass" | "assertion" | "crash"> {
  try {
    await caseNamed(start).run(pairOf(faults) as never);
    return "pass";
  } catch (error) {
    return error instanceof Error && error.name === "AssertionError" ? "assertion" : "crash";
  }
}

const SHARED = "each call's cost is added";
const PERIOD = "a new period starts from zero";
const CONCURRENT = "concurrent saves of two instances lose nothing";
const SEVERAL = "concurrent saves of two instances to several counters";
const ONCE = "an entry with a ledgerId counts once";
const NO_COUNTERS = "a save with no counters adds nothing";
const RACING = "concurrent saves count one entry once";
const REFUSED = "#817: what is no ledger entry";
const MAX = "keeps the last maxSpend()";

const dataFolding = {
  budget: (counter: CostCounter): boolean => counter.budget === "execution-budget",
  key: (counter: CostCounter): boolean => counter.key === "run-1",
  emptyPeriod: (counter: CostCounter): boolean => counter.period === "",
};

const BROKEN: readonly (readonly [string, string, Faults])[] = [
  [SHARED, "the second instance's save is lost", { lose: (who) => who === "second" }],
  [
    SHARED,
    "the second counter of a save gets nothing",
    { skipCounter: (_who, index) => index === 1 },
  ],
  [
    SHARED,
    "the first counter of the second instance's save gets nothing",
    { skipCounter: (who, index) => who === "second" && index === 0 },
  ],
  [
    SHARED,
    "any other tenant key reads the first tenant's counter",
    {
      foldCounter: (c) =>
        ["acme", "desk-application", ""].includes(c.key) ? c : { ...c, key: "acme" },
    },
  ],
  [PERIOD, "an execution budget is not counted", { dropCounter: dataFolding.budget }],
  [PERIOD, "an execution key is not counted", { dropCounter: dataFolding.key }],
  [
    PERIOD,
    "any other period reads the first period",
    { foldCounter: (c) => (c.period === "" ? c : { ...c, period: "2026-10-18" }) },
  ],
  [CONCURRENT, "the second instance's saves are lost", { lose: (who) => who === "second" }],
  [CONCURRENT, "the first instance's saves are lost", { lose: (who) => who === "first" }],
  [
    CONCURRENT,
    "the first instance keeps only its first save",
    { lose: (who, _n, ofWho) => who === "first" && ofWho > 1 },
  ],
  [
    CONCURRENT,
    "the first save, made by the first instance, is lost",
    { lose: (who, saveNo) => who === "first" && saveNo === 1 },
  ],
  [SEVERAL, "the second instance's saves are lost", { lose: (who) => who === "second" }],
  [SEVERAL, "the first instance's saves are lost", { lose: (who) => who === "first" }],
  [
    SEVERAL,
    "the first instance keeps only its first save",
    { lose: (who, _n, ofWho) => who === "first" && ofWho > 1 },
  ],
  [
    SEVERAL,
    "the first save, made by the first instance, is lost",
    { lose: (who, saveNo) => who === "first" && saveNo === 1 },
  ],
  [SEVERAL, "an execution budget is not counted", { dropCounter: dataFolding.budget }],
  [SEVERAL, "an execution key is not counted", { dropCounter: dataFolding.key }],
  [SEVERAL, "an empty period is not counted", { dropCounter: dataFolding.emptyPeriod }],
  [ONCE, "an id twice in one save is added twice", { batchDuplicateTwice: true }],
  [
    ONCE,
    "the second counter of the second instance's save gets nothing",
    {
      skipCounter: (who, index) => who === "second" && index === 1,
    },
  ],
  [
    ONCE,
    "the first counter of the second instance's save gets nothing",
    {
      skipCounter: (who, index) => who === "second" && index === 0,
    },
  ],
  [NO_COUNTERS, "a save without counters keeps the ids", { keepsIdsWithoutCounters: true }],
  [RACING, "the second instance's saves are lost", { lose: (who) => who === "second" }],
  [RACING, "the first instance's saves are lost", { lose: (who) => who === "first" }],
  [
    RACING,
    "the first instance's third save is lost, the id claimed",
    { lose: (who, _n, ofWho) => who === "first" && ofWho === 3 },
  ],
  [
    RACING,
    "the first save, made by the first instance, is lost, the id claimed",
    { lose: (who, saveNo) => who === "first" && saveNo === 1 },
  ],
  [RACING, "an execution budget is not counted", { dropCounter: dataFolding.budget }],
  [RACING, "an execution key is not counted", { dropCounter: dataFolding.key }],
  [RACING, "an empty period is not counted", { dropCounter: dataFolding.emptyPeriod }],
  [MAX, "a limit read before any was saved is zero", { zeroLimitBeforeAnySave: true }],
  [MAX, "the first limit stays", { firstLimitWins: true }],
  [
    MAX,
    "any other key reads the first account's limit",
    { foldAccount: (a) => (a.key === "" ? a : { ...a, key: "acme" }) },
  ],
];

const isWhat =
  (what: (record: unknown) => boolean): Accepts =>
  (record) =>
    isSoundEntry(record) || what(record);
const get = (record: unknown, key: string): unknown =>
  typeof record === "object" && record !== null ? Reflect.get(record, key) : undefined;

const REFUSING: readonly (readonly [string, Faults])[] = [
  ["accepts any record", { accepts: () => true }],
  [
    "accepts a record without a ledgerId",
    {
      accepts: isWhat(
        (r) =>
          typeof r === "object" &&
          r !== null &&
          get(r, "ledgerId") === undefined &&
          get(r, "madeAt") instanceof Date &&
          typeof get(r, "costUsd") === "number" &&
          Number.isFinite(get(r, "costUsd")) &&
          Number(get(r, "costUsd")) >= 0,
      ),
    },
  ],
  [
    "accepts an empty ledgerId",
    {
      accepts: isWhat(
        (r) =>
          get(r, "ledgerId") === "" &&
          get(r, "madeAt") instanceof Date &&
          !Number.isNaN((get(r, "madeAt") as Date).getTime()) &&
          typeof get(r, "costUsd") === "number" &&
          Number(get(r, "costUsd")) >= 0,
      ),
    },
  ],
  [
    "accepts a madeAt that is an ISO string",
    {
      accepts: isWhat((r) => {
        const madeAt = get(r, "madeAt");
        return (
          typeof madeAt === "string" &&
          !Number.isNaN(Date.parse(madeAt)) &&
          typeof get(r, "ledgerId") === "string" &&
          get(r, "ledgerId") !== ""
        );
      }),
    },
  ],
  [
    "accepts a madeAt that is a number of ms",
    {
      accepts: isWhat(
        (r) =>
          typeof get(r, "madeAt") === "number" &&
          Number.isFinite(get(r, "madeAt")) &&
          typeof get(r, "ledgerId") === "string" &&
          get(r, "ledgerId") !== "",
      ),
    },
  ],
  [
    "accepts an invalid Date",
    {
      accepts: isWhat(
        (r) =>
          get(r, "madeAt") instanceof Date &&
          typeof get(r, "ledgerId") === "string" &&
          get(r, "ledgerId") !== "" &&
          typeof get(r, "costUsd") === "number" &&
          Number(get(r, "costUsd")) >= 0,
      ),
    },
  ],
  [
    "accepts a cost that is NaN",
    {
      accepts: isWhat(
        (r) =>
          Number.isNaN(get(r, "costUsd")) &&
          get(r, "madeAt") instanceof Date &&
          typeof get(r, "ledgerId") === "string" &&
          get(r, "ledgerId") !== "",
      ),
    },
  ],
  [
    "accepts a negative cost",
    {
      accepts: isWhat(
        (r) =>
          typeof get(r, "costUsd") === "number" &&
          Number(get(r, "costUsd")) < 0 &&
          get(r, "madeAt") instanceof Date &&
          typeof get(r, "ledgerId") === "string" &&
          get(r, "ledgerId") !== "",
      ),
    },
  ],
  ["validates only a save with counters", { validatesOnlyWhen: "counters" }],
  ["validates only a save without counters", { validatesOnlyWhen: "noCounters" }],
  ["reports the index 0", { refusal: () => ({ index: 0, code: "" }) }],
  ["reports the index 1", { refusal: () => ({ index: 1, code: "" }) }],
  [
    "refuses a save with counters under another code",
    { refusal: (index, hasCounters) => ({ index, code: hasCounters ? "other" : "" }) },
  ],
  [
    "refuses a save without counters under another code",
    { refusal: (index, hasCounters) => ({ index, code: hasCounters ? "" : "other" }) },
  ],
  ["adds the entries before the bad one", { partialRefusal: true }],
  ["claims the entries before the bad one, adds nothing", { claimingRefusal: true }],
];

describe("#1366: the cost ledger contract's cases", async () => {
  await import("../../../../src/testing/contracts/cost-ledger.contract.js").then((m) => {
    m.costLedgerContract({
      name: "x",
      instance: () => new InMemoryCostLedgerRepository(),
    });
  });

  it("every case passes on the sound ledger shared by two instances", async () => {
    for (const one of captured.cases as Case[]) {
      if (one.name.startsWith("#771")) continue;
      expect(await outcomeOf(one.name, {}), one.name).toBe("pass");
    }
  });

  for (const [start, title, faults] of BROKEN)
    it(`"${start}" fails (an assertion) on a ledger where ${title}`, async () => {
      expect(await outcomeOf(start, faults)).toBe("assertion");
    });

  for (const [title, faults] of REFUSING)
    it(`the entry refusal case fails (an assertion) on a ledger that ${title}`, async () => {
      expect(await outcomeOf(REFUSED, faults)).toBe("assertion");
    });
});
