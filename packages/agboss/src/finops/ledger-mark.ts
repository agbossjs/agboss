import { StoreError } from "../core/error-families/store-errors.js";
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
   * Recorded by another instance — a call of a child that ran there (`ChildPlacement.AnyWorker`)
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

/** The fields of 0.1.0's mark (`isRecordedElsewhere`, `ledgerId`, `madeAt`) a record carries. */
function legacyFieldsOf(record: object): string[] {
  return ["isRecordedElsewhere", "ledgerId", "madeAt"].filter(
    (field) => Reflect.get(record, field) !== undefined,
  );
}

/**
 * Where the ledger holds `record` (#817): its `ledger`, read back as kept — a checkpoint's date
 * as a `Date`. `undefined`: not in the ledger yet. A record that carries a field of 0.1.0's mark
 * (`isRecordedElsewhere`, `ledgerId`, `madeAt`) is refused with `StoreError.UnreadableRecord` (field
 * names only, no value): read as "not in the ledger" its spend would be written or counted again.
 */
export function ledgerMarkOf(record: object): LedgerMark | undefined {
  const legacy = legacyFieldsOf(record);
  if (legacy.length > 0)
    throw new StoreError.UnreadableRecord({
      record: "usage record",
      ids: "",
      fields: legacy.join(", "),
    });
  const ledger: unknown = Reflect.get(record, "ledger");
  return ledger === undefined ? undefined : markOf(ledger);
}

/** The record's ledger id when a pass wrote it (`LedgerState.Written`), else `undefined`. */
export function writtenLedgerIdOf(record: object): string | undefined {
  const mark = ledgerMarkOf(record);
  return mark?.state === LedgerState.Written ? mark.ledgerId : undefined;
}

/** The ledger ids of the records a pass wrote (`LedgerState.Written`), in order; a record of no id names none. */
export function writtenLedgerIdsOf(records: readonly object[]): string[] {
  return records.map(writtenLedgerIdOf).filter((ledgerId) => ledgerId !== undefined);
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
