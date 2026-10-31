import type { Class } from "../components/injection.js";
import { AGBossError, type ErrorDetails } from "./errors.js";

/**
 * An error as the flow keeps it in its state: plain JSON, so it survives a serialising checkpointer
 * (a resumed run still routes on it). `code` is the code of the error's class; `lineage` the codes
 * of its class and every class above it (`step.action`, `step`, `agboss`); `cause` the same for the
 * error it wraps.
 */
export interface ErrorRecord {
  readonly name: string;
  readonly code: string;
  /** The codes of the error's class and its parent classes, nearest first (Error excluded). */
  readonly lineage: readonly string[];
  readonly message: string;
  readonly details?: ErrorDetails;
  readonly cause?: ErrorRecord;
}

const staticCodeOf = (cls: unknown): string | undefined =>
  typeof cls === "function" && "code" in cls && typeof cls.code === "string" ? cls.code : undefined;

/**
 * The code a class is caught by: its `static code` (every framework error has one; a user error
 * class may declare one), else its class name. `undefined` for `Error`: it catches everything.
 */
export function codeOfErrorClass(cls: Class): string | undefined {
  if (cls === Error) return undefined;
  return staticCodeOf(cls) ?? cls.name;
}

const codeOfConstructor = (constructor: unknown): string =>
  staticCodeOf(constructor) ?? (typeof constructor === "function" ? constructor.name : "Error");

const parentOf = (prototype: object): object | null => Reflect.getPrototypeOf(prototype);

/** The codes of an error's class and its parents up to `Error` (repeats of an inherited code once). */
function lineageOf(error: Error): readonly string[] {
  const codes: string[] = [];
  for (
    let prototype = parentOf(error);
    prototype !== null && prototype !== Error.prototype && prototype !== Object.prototype;
    prototype = parentOf(prototype)
  ) {
    const code = codeOfConstructor(Reflect.get(prototype, "constructor"));
    if (codes.at(-1) !== code) codes.push(code);
  }
  return codes.length === 0 ? ["Error"] : codes;
}

const detailsOf = (error: Error): ErrorDetails | undefined =>
  "details" in error && typeof error.details === "object" && error.details !== null
    ? Object.fromEntries(Object.entries(error.details))
    : undefined;

/**
 * How deep a record's cause chain goes (#598): the same depth wherever a record is made — on the
 * instance that saw the error and from a durable record on another — so both route it alike.
 */
export const MAX_ERROR_CAUSES = 32;

/**
 * A failure rebuilt from its durable record on another instance or after a takeover (#598): a
 * child's claimed failure, an undo's mark, a remote child's queue row. Its record is the original's
 * (its class line by code, its causes; no details), so `.onError` routes it as the original was
 * routed — the same side path on every holder. `instanceof` the original's class does not hold.
 */
export class RecordedError extends Error {
  readonly record: ErrorRecord;
  /** The original's own `code` when it was a framework error (`AGBossError`'s line). */
  readonly code?: string;

  constructor(record: ErrorRecord) {
    const cause = record.cause === undefined ? undefined : new RecordedError(record.cause);
    super(record.message, cause === undefined ? undefined : { cause });
    this.name = record.name;
    this.record = record;
    if (record.lineage.includes(AGBossError.code)) this.code = record.code;
  }
}

/** A record cut to `depth` causes below it. */
function cutTo(record: ErrorRecord, depth: number): ErrorRecord {
  const { cause, ...rest } = record;
  return cause === undefined || depth <= 0 ? rest : { ...rest, cause: cutTo(cause, depth - 1) };
}

/** The record of `thrown` at `depth` in its chain; `seen` stops a cause chain that loops. */
function recordAt(thrown: unknown, depth: number, seen: Set<unknown>): ErrorRecord {
  if (thrown instanceof RecordedError) return cutTo(thrown.record, MAX_ERROR_CAUSES - depth);
  if (!(thrown instanceof Error)) {
    return { name: "Error", code: "Error", lineage: ["Error"], message: String(thrown) };
  }
  seen.add(thrown);
  const details = detailsOf(thrown);
  const lineage = lineageOf(thrown);
  const { cause } = thrown;
  const hasCause = cause !== undefined && depth < MAX_ERROR_CAUSES && !seen.has(cause);
  return {
    name: thrown.name,
    code: lineage[0] ?? "Error",
    lineage,
    message: thrown.message,
    ...(details === undefined ? {} : { details }),
    ...(hasCause ? { cause: recordAt(cause, depth + 1, seen) } : {}),
  };
}

/**
 * The record of a thrown value, its causes included (a non-`Error` reads as a plain `Error`; a
 * chain that loops ends at its first repeat, one past `MAX_ERROR_CAUSES` is cut there); a
 * `RecordedError`'s is the record it was rebuilt from.
 */
export function errorRecordOf(thrown: unknown): ErrorRecord {
  return recordAt(thrown, 0, new Set());
}

/** How closely a handler's code matches a record: its distance in the class line and cause depth. */
export interface ErrorMatch {
  /** 0 = the error's own class, 1 = its parent, … */
  readonly distance: number;
  /** 0 = the error itself, 1 = its cause, … */
  readonly depth: number;
}

/** Where `code` matches the record or one of its causes, the closest class first; none = no match. */
export function errorMatchOf(
  record: ErrorRecord,
  code: string | undefined,
  depth = 0,
): ErrorMatch | undefined {
  const own = code === undefined ? -1 : record.lineage.indexOf(code);
  const here = own >= 0 ? { distance: own, depth } : undefined;
  const deeper =
    record.cause === undefined ? undefined : errorMatchOf(record.cause, code, depth + 1);
  if (here === undefined) return deeper;
  return deeper !== undefined && deeper.distance < here.distance ? deeper : here;
}

/** Whether a record (or one of its causes) is of the code, or of a class under it. */
export function recordMatches(record: ErrorRecord, code: string | undefined): boolean {
  return code === undefined || errorMatchOf(record, code) !== undefined;
}

/**
 * An error as a durable store keeps it (#598): its record — name, code, class line, message and
 * causes, the `details` left out — as JSON, written where a failure crosses a takeover or an
 * instance (a child's claimed failure, an undo's mark, a remote child's queue row) and rebuilt there
 * as a `RecordedError`, whose record routes it as the original was routed. A value that is no such
 * record (written before #598, or broken) is `undefined`: the caller's older rule applies, the same
 * on every instance.
 */

/** JSON, as the stores keep it. */
export type DurableJson =
  | string
  | number
  | boolean
  | null
  | readonly DurableJson[]
  | { readonly [field: string]: DurableJson };

/** A durable error record: an `ErrorRecord` without its details. */
export type DurableErrorRecord = Readonly<Record<string, DurableJson>>;

/** The durable form of a record. */
export function durableRecordOf(record: ErrorRecord): DurableErrorRecord {
  const { name, code, lineage, message, cause } = record;
  return {
    name,
    code,
    lineage: [...lineage],
    message,
    ...(cause === undefined ? {} : { cause: durableRecordOf(cause) }),
  };
}

/** The durable form of a thrown value's record (`errorRecordOf`). */
export const durableErrorOf = (thrown: unknown): DurableErrorRecord =>
  durableRecordOf(errorRecordOf(thrown));

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isLineage = (value: unknown): value is readonly string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((code: unknown) => typeof code === "string");

/** The record a durable value holds, its causes up to `MAX_ERROR_CAUSES` deep; else `undefined`. */
function durableRecordAt(value: unknown, depth: number): ErrorRecord | undefined {
  if (!isObject(value)) return undefined;
  const { name, code, lineage, message, cause } = value;
  if (typeof name !== "string" || typeof code !== "string" || typeof message !== "string")
    return undefined;
  if (!isLineage(lineage)) return undefined;
  const record = { name, code, lineage: [...lineage], message };
  if (cause === undefined || depth >= MAX_ERROR_CAUSES) return record;
  const inner = durableRecordAt(cause, depth + 1);
  return inner === undefined ? undefined : { ...record, cause: inner };
}

/** The record a store's value holds (its boundary: checked, never cast); `undefined` when none. */
export const errorRecordFromDurable = (value: unknown): ErrorRecord | undefined =>
  durableRecordAt(value, 0);

/** The failure a store's value holds, rebuilt; `undefined` when it holds no record. */
export function recordedErrorOf(value: unknown): RecordedError | undefined {
  const record = errorRecordFromDurable(value);
  return record === undefined ? undefined : new RecordedError(record);
}
