import { isDate } from "node:util/types";

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

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

/**
 * A mark's date as a `Date` (#817): a `Date`, or the ISO text a checkpoint keeps it as (JSON) — only
 * text a `Date` writes (`toISOString()`), never a lenient parse. Anything else fails closed.
 */
function dateOf(madeAt: unknown, ledgerId: string): Date {
  const date = isDate(madeAt)
    ? madeAt
    : typeof madeAt === "string" && isIsoText(madeAt)
      ? new Date(madeAt)
      : undefined;
  if (date === undefined || Number.isNaN(date.getTime()))
    throw new TypeError(`the ledger entry ${ledgerId} has no valid madeAt: ${String(madeAt)}`);
  return date;
}

/** Whether `text` is a date as `Date#toISOString()` writes it. */
function isIsoText(text: string): boolean {
  const date = new Date(text);
  return !Number.isNaN(date.getTime()) && date.toISOString() === text;
}

/** The mark as kept (`ledger`): checked, never guessed — an unknown one fails closed. */
function markOf(ledger: unknown): LedgerMark {
  if (isObject(ledger)) {
    if (ledger.state === LedgerState.RecordedElsewhere) return { state: ledger.state };
    const { ledgerId } = ledger;
    if (ledger.state === LedgerState.Written && typeof ledgerId === "string" && ledgerId !== "")
      return { state: ledger.state, ledgerId, madeAt: dateOf(ledger.madeAt, ledgerId) };
  }
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

/** A record as a cost report shows it: without where the ledger holds it (of any version). */
export function withoutLedgerMarks<T extends object>(record: T): T {
  if (!MARK_FIELDS.some((field) => field in record)) return record;
  const copy = { ...record };
  for (const field of MARK_FIELDS) Reflect.deleteProperty(copy, field);
  return copy;
}

/**
 * `record` with its mark as this version keeps it (#817): `ledger` read back — its date a `Date`
 * again after a checkpoint's JSON — and the fields of before 0.1.1 read into it; a record without
 * a mark of any version as it is. What a restored state's usage is made of.
 */
export function withLedgerMarkRead<T extends object>(record: T): T {
  const mark = ledgerMarkOf(record);
  if (mark === undefined) return withoutLedgerMarks(record);
  return { ...withoutLedgerMarks(record), ledger: mark };
}
