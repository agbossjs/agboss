import { isDate } from "node:util/types";
import { AGBossError } from "../core/errors.js";

/**
 * Where the ledger holds a usage record (#333 PR 3, #727, #771; one state, #817): the budgets'
 * bookkeeping, never part of its cost.
 */

/** Where the ledger holds a record's cost. */
export enum LedgerState {
  /** A pass wrote it to the ledger as it was made: an entry under its `ledgerId`, counted once. */
  Written = "written",
  /**
   * Recorded by another instance — a call of a child that ran there (`ChildPlacement.AnyInstance`)
   * and that its pass wrote at its step's end —: in the ledger already, under no id the parent
   * knows; counted once by what it is.
   */
  RecordedElsewhere = "recorded-elsewhere",
}

/** A record's cost in the ledger: an entry under its id, made at `madeAt` (the `Clock`). */
export interface WrittenLedgerMark {
  readonly state: LedgerState.Written;
  /** The entry's identity in the ledger: an id of the pass that made the spend. */
  readonly ledgerId: string;
  /** When the spend was made: its entry's date, what the ledger prunes by (#771). */
  readonly madeAt: Date;
}

/** A record's cost recorded by another instance (no id this pass knows). */
export interface RecordedElsewhereLedgerMark {
  readonly state: LedgerState.RecordedElsewhere;
}

/** Where the ledger holds a record (`UsageRecord.ledger`); absent: not in the ledger yet. */
export type LedgerMark = WrittenLedgerMark | RecordedElsewhereLedgerMark;

/**
 * A spend's identity across passes (`UsageRecord.ledgerKey`, #810): a charge a step makes again
 * after a takeover — an A2A call's price and its run report's excess, replayed from the accept an
 * earlier pass recorded — is written to the ledger under `id` and dated `madeAt`, so the ledger
 * adds it once whichever pass writes it first. A spend without one gets an id of the pass that
 * made it (#727): made again by another pass, it is billed again.
 */
export interface LedgerKey {
  /** The entry's id in the ledger: derived from what makes the spend one (a call's messageId). */
  readonly id: string;
  /** When the spend was first made (the `Clock`): its entry's date, what the ledger prunes by. */
  readonly madeAt: Date;
}

/** The fields a record kept before #817 (0.1.0, and `main` before 0.1.1) marks the ledger with. */
interface LegacyMarks {
  readonly isRecordedElsewhere?: unknown;
  readonly ledgerId?: unknown;
  readonly madeAt?: unknown;
}

/** What a record of any version carries: the mark, or the fields of before. */
interface Marked extends LegacyMarks {
  readonly ledger?: unknown;
}

/**
 * A mark's date as a `Date` (#817): a `Date`, or the ISO text a checkpoint keeps it as (JSON) — only
 * text a `Date` writes (`toISOString()`), never a lenient parse. Anything else fails closed.
 */
function dateOf(madeAt: unknown, ledgerId: string): Date {
  const date = isDate(madeAt) ? madeAt : isIsoText(madeAt) ? new Date(String(madeAt)) : undefined;
  if (date === undefined || Number.isNaN(date.getTime()))
    throw new TypeError(`the ledger entry ${ledgerId} has no valid madeAt: ${String(madeAt)}`);
  return date;
}

/** Whether `value` is a date as `Date#toISOString()` writes it. */
function isIsoText(value: unknown): boolean {
  const date = new Date(String(value));
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

/** The mark as kept (`ledger`): checked, never guessed — an unknown one fails closed. */
function markOf(ledger: unknown): LedgerMark {
  // a primitive (or null) has none of the fields: refused below
  const fields: object = new Object(ledger);
  const state: unknown = Reflect.get(fields, "state");
  const ledgerId: unknown = Reflect.get(fields, "ledgerId");
  if (state === LedgerState.RecordedElsewhere) return { state };
  if (state === LedgerState.Written && typeof ledgerId === "string" && ledgerId !== "")
    return { state, ledgerId, madeAt: dateOf(Reflect.get(fields, "madeAt"), ledgerId) };
  throw new TypeError(
    `a usage record's ledger mark is not one this version reads: ${JSON.stringify(ledger)}`,
  );
}

/**
 * The mark of a record kept before 0.1.1 (`isRecordedElsewhere`, #333; `ledgerId`, #727; ISO
 * `madeAt`, #771 — none before it: dated at the epoch, the oldest). A field there but of another
 * kind fails closed: read as "not in the ledger" it would be written again, read as recorded
 * elsewhere without its id it would be counted again.
 */
function legacyMarkOf(marked: LegacyMarks): LedgerMark | undefined {
  const { isRecordedElsewhere, ledgerId, madeAt } = marked;
  assertLegacyKinds(isRecordedElsewhere, ledgerId);
  if (isRecordedElsewhere !== true) return undefined;
  if (ledgerId === undefined) return { state: LedgerState.RecordedElsewhere };
  const date = madeAt === undefined ? new Date(0) : dateOf(madeAt, ledgerId);
  return { state: LedgerState.Written, ledgerId, madeAt: date };
}

/** Throws `TypeError` unless the fields of before are each absent or of their kind. */
function assertLegacyKinds(
  isRecordedElsewhere: unknown,
  ledgerId: unknown,
): asserts ledgerId is string | undefined {
  if (isRecordedElsewhere !== undefined && typeof isRecordedElsewhere !== "boolean")
    throw new TypeError(
      `a usage record's isRecordedElsewhere is no boolean: ${JSON.stringify(isRecordedElsewhere)}`,
    );
  if (ledgerId !== undefined && (typeof ledgerId !== "string" || ledgerId === ""))
    throw new TypeError(`a usage record's ledgerId is no id: ${JSON.stringify(ledgerId)}`);
}

/**
 * Where the ledger holds `record` (#817): its `ledger`, read back as kept — a checkpoint's date
 * as a `Date` — or, for a record kept before 0.1.1, its `isRecordedElsewhere` (with a `ledgerId`:
 * written, dated by its `madeAt`; without: recorded elsewhere), so a state kept before an upgrade is
 * never written or counted again. `undefined`: not in the ledger yet.
 */
export function ledgerMarkOf(record: object): LedgerMark | undefined {
  const marked: Marked = record;
  return marked.ledger === undefined ? legacyMarkOf(marked) : markOf(marked.ledger);
}

/** The record's ledger id when a pass wrote it (`LedgerState.Written`), else `undefined`. */
export function writtenLedgerIdOf(record: object): string | undefined {
  const mark = ledgerMarkOf(record);
  return mark?.state === LedgerState.Written ? mark.ledgerId : undefined;
}

const MARK_FIELDS = ["ledger", "isRecordedElsewhere", "ledgerId", "madeAt"] as const;

/** The fields of where the ledger holds a record, and the spend's identity across passes (#810). */
const REPORT_HIDDEN = [...MARK_FIELDS, "ledgerKey"] as const;

/** `record` without `fields` (the same record when it has none of them). */
function without<T extends object>(record: T, fields: readonly string[]): T {
  if (!fields.some((field) => field in record)) return record;
  const copy = { ...record };
  for (const field of fields) Reflect.deleteProperty(copy, field);
  return copy;
}

/**
 * A record as a cost report shows it: without where the ledger holds it (of any version) and
 * without its identity across passes — the budgets' bookkeeping, not its cost.
 */
export function withoutLedgerMarks<T extends object>(record: T): T {
  return without(record, REPORT_HIDDEN);
}

/**
 * A spend's identity across passes as kept (`ledgerKey`, #810): its date a `Date` again after a
 * checkpoint's JSON; one this version cannot read fails closed — never a new id, which would count
 * a charge made again after a takeover twice.
 */
function ledgerKeyOf(ledgerKey: unknown): LedgerKey {
  // a primitive (or null) has none of the fields: refused below
  const fields: object = new Object(ledgerKey);
  const id: unknown = Reflect.get(fields, "id");
  if (typeof id === "string" && id !== "")
    return { id, madeAt: dateOf(Reflect.get(fields, "madeAt"), id) };
  throw new TypeError(
    `a usage record's ledgerKey is not one this version reads: ${JSON.stringify(ledgerKey)}`,
  );
}

/**
 * `record` with its mark as this version keeps it (#817): `ledger` read back — its date a `Date`
 * again after a checkpoint's JSON — and the fields of before 0.1.1 read into it; its `ledgerKey`
 * (#810) read back the same way; a record without either as it is. What a restored state's usage
 * is made of.
 */
export function withLedgerMarkRead<T extends object>(record: T): T {
  const mark = ledgerMarkOf(record);
  const read: T =
    mark === undefined
      ? without(record, MARK_FIELDS)
      : { ...without(record, MARK_FIELDS), ledger: mark };
  if (!("ledgerKey" in record) || record.ledgerKey === undefined) return read;
  return { ...read, ledgerKey: ledgerKeyOf(record.ledgerKey) };
}

/** Why `assertLedgerEntries` refused a save (#817): the entry's place in the save and what is wrong. */
export interface CostLedgerEntryInvalidErrorOptions {
  /** The entry's index in the save. */
  readonly index: number;
  /** What it lacks: `ledgerId`, `madeAt` or `costUsd`, and why. */
  readonly reason: string;
  readonly cause?: unknown;
}

/**
 * A save handed something that is no `LedgerEntry` (#817): a record without a `ledgerId`, a valid
 * `madeAt` `Date` or a finite, non-negative `costUsd` — what a JS caller (or a cast) can pass. The
 * save adds nothing: spend without an identity could be counted on every retry.
 */
export class CostLedgerEntryInvalidError extends AGBossError {
  static override readonly code = "cost-ledger.entry-invalid" as const;
  declare readonly code: typeof CostLedgerEntryInvalidError.code;
  override name = "CostLedgerEntryInvalidError";
  readonly index: number;
  readonly reason: string;

  constructor(options: CostLedgerEntryInvalidErrorOptions) {
    super(
      `the ledger was handed no ledger entry at index ${String(options.index)}: ${options.reason} — the save added nothing; save only LedgerEntry values (an id, a madeAt Date, a costUsd in Usd)`,
      { cause: options.cause },
    );
    this.index = options.index;
    this.reason = options.reason;
  }
}

/** What a prune's invalid cutoff knows (#906). */
export interface CostLedgerCutoffInvalidErrorOptions {
  /** What is wrong with the cutoff: `the cutoff is no valid Date: <what it got>`. */
  readonly reason: string;
  readonly cause?: unknown;
}

/**
 * A prune handed a cutoff that is no valid `Date` (#817, #869): one compares false with every entry
 * and would lower the pruning mark, so it is refused — nothing pruned, the mark where it was. What
 * a JS caller (or a cast) can pass; every store refuses it with this code (`assertLedgerCutoff`).
 */
export class CostLedgerCutoffInvalidError extends AGBossError {
  static override readonly code = "cost-ledger.cutoff-invalid" as const;
  declare readonly code: typeof CostLedgerCutoffInvalidError.code;
  override name = "CostLedgerCutoffInvalidError";
  /** What is wrong with the cutoff: `the cutoff is no valid Date: <what it got>`. */
  readonly reason: string;

  constructor(options: CostLedgerCutoffInvalidErrorOptions) {
    const { reason, cause } = options;
    super(
      `the ledger was handed no valid Date as its prune's cutoff: ${reason} — nothing was pruned and the pruning mark stays where it was; prune with a valid Date`,
      { cause },
    );
    this.reason = reason;
  }
}

/** What a save refused (#771): the entries it does not hold dated before its pruning mark. */
export interface CostLedgerEntryExpiredErrorOptions {
  /** The refused entries' `ledgerId`s. */
  readonly ledgerIds: readonly string[];
  /** The store's pruning mark when it refused them. */
  readonly prunedBefore: Date;
  readonly cause?: unknown;
}

/**
 * A save of an entry the ledger may have pruned (#771): dated before the store's pruning mark and
 * not held, so it may have been counted and removed since — counting it again could count it twice.
 * The save adds nothing; the pass's reads fail with it from then on (its spend is never counted
 * twice, and never read beside spend it cannot place). Only a write retried longer after its spend
 * was made than `@Application({ retention: { costLedgerEntries } })` meets it — a pass that slept that long.
 */
export class CostLedgerEntryExpiredError extends AGBossError {
  static override readonly code = "cost-ledger.entry-expired" as const;
  declare readonly code: typeof CostLedgerEntryExpiredError.code;
  override name = "CostLedgerEntryExpiredError";
  readonly ledgerIds: readonly string[];
  readonly prunedBefore: Date;

  constructor(options: CostLedgerEntryExpiredErrorOptions) {
    super(
      `the ledger may have pruned the entries ${options.ledgerIds.join(", ")}: made before its pruning mark ${options.prunedBefore.toISOString()} and not held, counting them again could count them twice — the save added nothing; keep entries longer with @Application({ retention: { costLedgerEntries } })`,
      { cause: options.cause },
    );
    this.ledgerIds = options.ledgerIds;
    this.prunedBefore = options.prunedBefore;
  }
}
