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
 * A mark's date as a `Date`: a checkpoint keeps it as its ISO text (JSON), a record of before
 * #817 as ISO text too, one of before #771 has none — dated at the epoch, the oldest.
 */
function dateOf(madeAt: unknown, ledgerId: string): Date {
  const date =
    madeAt === undefined
      ? new Date(0)
      : madeAt instanceof Date
        ? madeAt
        : typeof madeAt === "string"
          ? new Date(madeAt)
          : new Date(Number.NaN);
  if (Number.isNaN(date.getTime()))
    throw new TypeError(`the ledger entry ${ledgerId} has no valid madeAt: ${String(madeAt)}`);
  return date;
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
 * Where the ledger holds `record` (#817): its `ledger`, read back as kept — a checkpoint's date
 * as a `Date` — or, for a record kept before 0.1.1, its `isRecordedElsewhere` (with a `ledgerId`:
 * written, dated by its `madeAt`; without: recorded elsewhere), so a state kept before an upgrade is
 * never written or counted again. `undefined`: not in the ledger yet.
 */
export function ledgerMarkOf(record: object): LedgerMark | undefined {
  const marked: Marked = record;
  if (marked.ledger !== undefined) return markOf(marked.ledger);
  if (marked.isRecordedElsewhere !== true) return undefined;
  const { ledgerId } = marked;
  if (typeof ledgerId === "string" && ledgerId !== "")
    return { state: LedgerState.Written, ledgerId, madeAt: dateOf(marked.madeAt, ledgerId) };
  return { state: LedgerState.RecordedElsewhere };
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
