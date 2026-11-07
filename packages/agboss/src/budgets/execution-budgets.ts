import type { Clock } from "../infrastructure/clock.js";
import { unrecordedOf } from "../finops/record-stream.js";
import { totalCost, type UsageRecord } from "../finops/usage.js";
import type { BudgetExceededError } from "../graph/limits.js";
import type { CostLedgerRepository } from "../infrastructure/cost-ledger.repository.js";
import { counterKeyOf } from "../infrastructure/cost-ledger.repository.js";
import { checkDeadline, type ExecutionDeadline } from "./execution-deadline.js";
import {
  budgetExceededErrorOf,
  counterOf,
  isRecordedHere,
  isSpendExhausted,
  LedgerIds,
} from "./budget-check.js";
import type { BudgetCheck, CounterSnapshot, ExecutionBudgetRecord } from "./budget-check.js";

export * from "./budget-check.js";
export { settledSaverOf } from "../app/leased-checkpointer.js";

/**
 * Budgets at run time (#261 PR 5): which budgets an execution has — its own workflow's execution
 * budget (else the default one), every tenant budget and every application budget —, their
 * `maxSpend()` read once, at its start, and kept for the whole execution (in its state, so a resume
 * or a recovery keeps them), the ledger checked before the first step (any exhausted → the
 * execution is rejected) and every model call's cost counted in all of them, the first exhausted
 * stopping the execution with `BudgetExceededError`. Nothing is reserved: parallel executions of one
 * tenant may overrun a little on a race, and a budget may be exceeded by at most the calls in flight
 * when it was exhausted (#338: the pass's live tally aborts them), plus (#664) the spend of the steps
 * it never holds back (the undos, automatic or a side path's; the actions of the side path that took
 * a limit, step by step) and, across instances (#727, #732), what the steps spend that passed their
 * check before that spend was in the ledger — one write after it was made, a step that read the
 * counters before then being one in flight.
 */

/**
 * The budgets of one pass of an execution (its run, a resume, a recovery): their counters read
 * before each step (`refresh`, so the spend of the tenant's other executions counts),
 * checked before each step and model call (`check`), each call's cost added to every one of them
 * (`record`). A counter's value now = what it held at the last read + what the execution spent
 * since that the read does not hold.
 *
 * The live tally (#338): the pass's spend is also counted as it is made (`tally` — an agent's
 * model calls, guardrails and judges, a tool's or a step's service spend, an arbiter's decision),
 * before it reaches the state; what is not tallied (a router's decision) is written when its step
 * ends. A check takes the larger of the caller's view (its state's spend) and the meter's (what it
 * recorded plus the tally not in the ledger yet), so a branch of a parallel launch sees its
 * siblings' spend while they run. A tally that exhausts a budget aborts `exhausted`
 * with that `BudgetExceededError`: every branch of the pass's launches watches it, so their
 * in-flight calls stop at once. One meter per pass and tree on this instance (the lease gives one
 * mover); other instances see the spend through the ledger only.
 *
 * Written as it is made (#727, #732): a tally is written to the ledger at once — so the tree's
 * steps on other instances (its children on any instance, their siblings, the parent of one) see it
 * at their next read of the counters — and the state keeps the record marked as in the ledger
 * (`isRecordedElsewhere`) with its `ledgerId`. The pass writes a checkpoint only once every tally
 * before it is written (`settled`, `SettledSpendCheckpointSaver`), and queues a child on any
 * instance only then, so a durable state never holds a mark its ledger lacks. A record with a
 * `ledgerId` counts once by that id: this pass's own, or taken in once — a child's from another
 * instance, a takeover's restored writes —, never written again; a check does not count one that an
 * earlier pass wrote twice (it is in every read of this pass). The id is the pass's own
 * (`LedgerIds`): spend a step makes again after a crash or a takeover was billed again and counts
 * again; the ledger adds an entry once (`CostLedgerRepository.saveAll`), so a write retried after its
 * answer was lost counts once. Each entry is dated by its `madeAt` (#771): the ledger prunes
 * entries made longer ago than `@Application({ retention: { costLedgerEntries } })` and refuses a write of one
 * it may have pruned (`CostLedgerEntryExpiredError`, the pass's reads fail with it), so a retry that
 * late is never counted twice — and one within it counts once.
 */
export class BudgetMeter implements BudgetCheck {
  /** What this pass wrote to the ledger, and what it took in as written there elsewhere. */
  #recorded = 0;
  #snapshot: CounterSnapshot = { values: new Map(), recorded: 0 };
  /** The pass's spend tallied as it was made and not in the ledger yet (its write pending). */
  #tallied: UsageRecord[] = [];
  /** The `ledgerId`s this pass gave, took in, or found counted before it (#727). */
  readonly #ids: LedgerIds;
  /** Tallied spend whose write failed: written again before the next write or checkpoint. */
  #unwritten: UsageRecord[] = [];
  /** The meter's reads and writes, one at a time. */
  #turns: Promise<unknown> = Promise.resolve();
  readonly #exhausted = new AbortController();

  /**
   * `spentBefore` is what the execution spent before this pass — already in the ledger (0 for a new
   * execution); `counted` its records, when the pass has them: their `ledgerId`s are never taken in.
   */
  constructor(
    readonly records: readonly ExecutionBudgetRecord[],
    private readonly ledger: CostLedgerRepository,
    private readonly clock: Clock,
    private readonly spentBefore: number,
    /** The execution's deadline (#398 PR 2): checked with the budgets. */
    readonly deadline?: ExecutionDeadline,
    // Stryker disable next-line ArrayDeclaration: a stray string has no ledgerId, so it counts no id
    counted: readonly UsageRecord[] = [],
  ) {
    this.#ids = new LedgerIds(counted);
  }

  /** Aborted, with its `BudgetExceededError` as the reason, when a tally exhausts a budget. */
  get exhausted(): AbortSignal {
    return this.#exhausted.signal;
  }

  /** Runs `work` after the meter's reads and writes before it: never beside one. */
  #inTurn(work: () => Promise<void>): Promise<void> {
    const turn = this.#turns.then(work);
    this.#turns = turn.catch(() => undefined);
    return turn;
  }

  /**
   * Every counter of the execution's budgets in its current period, as the ledger holds it now.
   * Tallied spend whose write failed is written again first (#770): a write whose answer was lost
   * may have landed, and a read that held it while the tally still counts it would count it twice
   * — so a read never runs beside such spend; when it fails again, so does the read.
   */
  async #read(): Promise<ReadonlyMap<string, number>> {
    await this.#writeUnwritten();
    const now = this.clock.now();
    const values = new Map<string, number>();
    for (const record of this.records) {
      const counter = counterOf(record, now);
      values.set(counterKeyOf(counter), await this.ledger.findSpentByCounter(counter));
    }
    return values;
  }

  /** Reads every counter of the execution's budgets in their current period. */
  refresh(): Promise<void> {
    return this.#inTurn(async () => {
      const values = await this.#read();
      this.#snapshot = { values, recorded: this.#recorded };
    });
  }

  /** A budget's spend now, from the last read and the execution's total `executionSpent`. */
  #spentOf(record: ExecutionBudgetRecord, executionSpent: number, now: Date): number {
    const counted = this.#snapshot.values.get(counterKeyOf(counterOf(record, now))) ?? 0;
    return counted + (executionSpent - this.spentBefore - this.#snapshot.recorded);
  }

  /** The execution's total as the meter knows it: before this pass, recorded, tallied. */
  #executionSpent(): number {
    return this.spentBefore + this.#recorded + totalCost(this.#tallied);
  }

  /**
   * The first budget exhausted at `executionSpent`, as its error; `counted` is the part of it the
   * counters do not hold through an earlier pass's writes (`executionSpent` when none).
   */
  #breachOf(
    executionSpent: number,
    path: readonly string[],
    usage: readonly UsageRecord[],
    counted = executionSpent,
  ): BudgetExceededError | undefined {
    const now = this.clock.now();
    for (const record of this.records) {
      const spent = this.#spentOf(record, counted, now);
      if (isSpendExhausted(spent, record.maxSpend))
        return budgetExceededErrorOf(record, spent, path, executionSpent, usage);
    }
    return undefined;
  }

  /**
   * Throws the first exhausted budget's error. `state` is what the execution's state holds — its
   * records, or their total (a state without spend written by an earlier pass).
   */
  check(
    state: number | readonly UsageRecord[],
    path: readonly string[],
    usage: readonly UsageRecord[] = [],
  ): void {
    const stateSpent = typeof state === "number" ? state : totalCost(state);
    const written = typeof state === "number" ? 0 : this.#ids.writtenBefore(state);
    const meterSpent = this.#executionSpent();
    const spent = Math.max(stateSpent, meterSpent);
    checkDeadline(this.deadline, this.clock.now(), { path, spentUsd: spent, usage });
    const breach = this.#breachOf(spent, path, usage, Math.max(stateSpent - written, meterSpent));
    if (breach !== undefined) throw breach;
  }

  /** Adds `records` to every counter (their period). */
  #save(records: readonly UsageRecord[]): Promise<void> {
    const now = this.clock.now();
    const counters = this.records.map((record) => counterOf(record, now));
    return this.ledger.saveAll(counters, records);
  }

  /**
   * Writes tallied spend: in the ledger, out of the tally, with a read after it — an entry an
   * earlier run of its step wrote is not added again (#727), so only a read says what it holds.
   */
  async #write(records: readonly UsageRecord[]): Promise<void> {
    await this.#save(records);
    const values = await this.#read();
    this.#recorded += totalCost(records);
    this.#tallied = [...unrecordedOf(this.#tallied, records)];
    this.#snapshot = { values, recorded: this.#recorded };
  }

  /** Writes the tallied spend whose write failed; throws when it fails again. */
  async #writeUnwritten(): Promise<void> {
    const records = this.#unwritten;
    if (records.length === 0) return;
    this.#unwritten = [];
    await this.#write(records).catch((error: unknown) => {
      this.#unwritten.push(...records);
      throw error;
    });
  }

  tally(records: readonly UsageRecord[], path: readonly string[] = []): readonly UsageRecord[] {
    // spend recorded elsewhere is in the ledger already: counted when it is taken in (#685)
    if (this.records.length === 0 || !records.some(isRecordedHere)) return records;
    // written at once (#727, #732): another instance's check sees it at its next read of the
    // counters; marked with its id, so no pass writes or counts it again
    const own: UsageRecord[] = [];
    const kept = records.map((record) => {
      if (!isRecordedHere(record)) return record;
      const marked = {
        ...record,
        isRecordedElsewhere: true,
        ledgerId: this.#ids.mint(),
        // its entry's date (#771): a write of it retried after the ledger pruned it is refused
        madeAt: this.clock.now().toISOString(),
      };
      own.push(marked);
      return marked;
    });
    this.#tallied.push(...own);
    // a failed write is kept, still counted in the tally: the next write or checkpoint writes it
    void this.#inTurn(() =>
      this.#write(own).catch(() => {
        this.#unwritten.push(...own);
      }),
    );
    // the records are in the tally (and soon in the state): the error carries none of them
    const breach = this.#breachOf(this.#executionSpent(), path, []);
    if (breach !== undefined) this.#exhausted.abort(breach);
    return kept;
  }

  /**
   * Resolves once every spend tallied so far is in the ledger (#727, #732): awaited before a
   * checkpoint write, so a state that holds a record marked as in the ledger is never durable
   * before its write, and before a child is queued for any instance. Rejects when a write failed
   * twice.
   */
  settled(): Promise<void> {
    return this.#inTurn(() => this.#writeUnwritten());
  }

  /** What the execution may still spend now: the least any of its budgets has left. */
  remaining(): number {
    const now = this.clock.now();
    const spent = this.#executionSpent();
    return Math.min(
      ...this.records.map((record) => record.maxSpend - this.#spentOf(record, spent, now)),
      Number.POSITIVE_INFINITY,
    );
  }

  /**
   * What the execution may spend in total at the last read: the least that any of its budgets has
   * left, plus what it spent before this pass (`Infinity` without budgets).
   */
  budgetUsd(): number {
    const now = this.clock.now();
    return (
      Math.min(
        ...this.records.map(
          (record) => record.maxSpend - this.#spentOf(record, this.spentBefore, now),
        ),
        Number.POSITIVE_INFINITY,
      ) + this.spentBefore
    );
  }

  /**
   * Counts spend already in the ledger, with a read that holds it: in one turn, nothing between.
   * Its `ledgerId`s count as this pass's from then on — with `recorded`, never before it.
   */
  async #takeIn(records: readonly UsageRecord[]): Promise<void> {
    if (records.length === 0) return;
    const values = await this.#read();
    this.#recorded += totalCost(records);
    this.#snapshot = { values, recorded: this.#recorded };
    this.#ids.count(records);
  }

  /**
   * Takes in a child's spend that its instance wrote to the ledger as it was made (#333 PR 3,
   * #685), before the parent's state shows it: counted, never written again — once, when its records
   * reach `record` later.
   */
  takeRecordedElsewhere(records: readonly UsageRecord[]): Promise<void> {
    // Stryker disable next-line ConditionalExpression: without budgets a take-in reads no counter and nothing reads what it counts
    if (this.records.length === 0) return Promise.resolve();
    return this.#inTurn(async () => {
      await this.#takeIn(this.#ids.uncounted(records, true));
    });
  }

  /**
   * Adds the calls' cost to every counter (their period); one in the ledger already (recorded
   * elsewhere, or written by a tally) only counts, once (#333, #685, #727). Resolves once every
   * spend tallied before it is in the ledger too.
   */
  record(records: readonly UsageRecord[]): Promise<void> {
    if (this.records.length === 0) return Promise.resolve();
    return this.#inTurn(async () => {
      await this.#writeUnwritten();
      const own = records.filter(isRecordedHere);
      const elsewhere = this.#ids.uncounted(records, false);
      this.#recorded += totalCost(own);
      if (own.length > 0) await this.#save(own);
      await this.#takeIn(elsewhere);
    });
  }
}

/** A pass's budgets over the records the execution keeps. */
export const meterOf = (
  application: { readonly ledger: CostLedgerRepository; readonly clock: Clock },
  records: readonly ExecutionBudgetRecord[],
  spentBefore: number,
  deadline?: ExecutionDeadline,
  // Stryker disable next-line ArrayDeclaration: a stray string has no ledgerId, so it counts no id
  counted: readonly UsageRecord[] = [],
): BudgetMeter =>
  new BudgetMeter(records, application.ledger, application.clock, spentBefore, deadline, counted);
