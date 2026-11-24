import { EXECUTION_LEASE } from "../app/lease-fence.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import { hours, type Milliseconds } from "../units/index.js";
import { shownValueOf } from "../core/shown-value.js";

/**
 * `@Application({ retention })` (#834): how long each kind of row the application keeps stays
 * after it is done with, every one removed by the recovery sweep on the `Clock` — the one place a
 * retention is set. The rows of `Idempotency` are not here: each call names its own `ttl`
 * (#1317), kept as the row's `expires_at`. Sizes and timeouts stay with their call (`maxResultSize`,
 * `timeout`). Each is a positive duration (`[application.retention-invalid]`); the fencing one —
 * `costLedgerEntries` — above the lease's 30 s, so a late zombie or a retried write is still
 * refused, never let through.
 */
export interface RetentionOptions {
  /**
   * A resolved pause record (`Taken`, `Cancelled`) after it was resolved (#267 S107): within it a
   * late answer gets `NotPausedError`, after it `UnknownPauseError`. A pending pause is never
   * removed. Default `hours(24)`.
   */
  readonly pauseRecords?: Milliseconds;
  /**
   * The history of each root execution after it ended (#401) — its `ExecutionHistoryRecord`, masked
   * like its traces, saved in the `ExecutionHistoryRepository` when its tree rests or ends and read
   * by `agboss records export`. On the built-in in-memory store it warns
   * `[application.in-memory-execution-history]`.
   *
   * @defaultValue unset: **nothing is kept** — unlike every other retention, the safe default for
   * personal data.
   */
  readonly executionRecords?: Milliseconds;
  /**
   * A row of the audit log after it happened (#501): every takeover of a tree's lease and every
   * step handed over, written to the `ExecutionAuditLogRepository` whatever `executionRecords`
   * says, read by `app.auditLogOf`. Default `hours(24)`.
   */
  readonly auditLog?: Milliseconds;
  /**
   * An entry of the cost ledger after its spend was made (#771, `CostLedgerRepository`): every
   * tallied spend is an entry under its `ledgerId` so that a write retried after a lost answer
   * counts once; older entries are pruned (the counters never), and a write retried later than this
   * is refused (`CostLedgerEntryExpiredError`), never counted twice. Above the lease. Default
   * `hours(24)`.
   */
  readonly costLedgerEntries?: Milliseconds;
}

/** The retentions an application runs with: each set one, else its default (`executionRecords` stays unset). */
export interface ApplicationRetention {
  readonly pauseRecords: Milliseconds;
  /** Unset: no root execution is kept. */
  readonly executionRecords?: Milliseconds;
  readonly auditLog: Milliseconds;
  readonly costLedgerEntries: Milliseconds;
}

/** The defaults of every retention but `executionRecords` (unset = nothing kept). */
export const DEFAULT_RETENTION: Readonly<Omit<ApplicationRetention, "executionRecords">> =
  Object.freeze({
    pauseRecords: hours(24),
    auditLog: hours(24),
    // a pass retries a lost write at its next read of the counters, seconds later: only a pass
    // asleep for a day meets the refusal
    costLedgerEntries: hours(24),
  });

/** Every field of `RetentionOptions`: a key outside them is a typo, never a silent default. */
const RETENTION_FIELDS: readonly (keyof RetentionOptions)[] = [
  "pauseRecords",
  "executionRecords",
  "auditLog",
  "costLedgerEntries",
];

/**
 * The retentions of rows a fenced write relies on: removed sooner than the lease (30 s), a mark,
 * an intent or a ledger entry would let a zombie's late write — or a retried one — through; a
 * direct message's row (#860) would go while its reply is still being made, and a resend run again.
 */
const ABOVE_THE_LEASE: ReadonlySet<keyof RetentionOptions> = new Set(["costLedgerEntries"]);

/** `@Application({ retention })` with the defaults filled in. */
export function retentionOf(options: RetentionOptions | undefined): ApplicationRetention {
  const given = options ?? {};
  return {
    pauseRecords: given.pauseRecords ?? DEFAULT_RETENTION.pauseRecords,
    ...(given.executionRecords === undefined ? {} : { executionRecords: given.executionRecords }),
    auditLog: given.auditLog ?? DEFAULT_RETENTION.auditLog,
    costLedgerEntries: given.costLedgerEntries ?? DEFAULT_RETENTION.costLedgerEntries,
  };
}

/**
 * The longest retention: a century. Longer, `now − retention` leaves what a `Date` holds and every
 * sweep's removal fails (or, in memory, removes nothing) — "forever" is not a duration.
 */
const MAX_RETENTION = hours(24 * 365 * 100);

/** What is wrong with one retention, or `undefined`. */
function retentionProblem(field: keyof RetentionOptions, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return `is ${shownValueOf(value)}, not a positive duration`;
  if (value > MAX_RETENTION)
    return `is ${String(value)} ms, above a century (${String(MAX_RETENTION)} ms) — a cutoff a date cannot hold`;
  if (ABOVE_THE_LEASE.has(field) && value <= EXECUTION_LEASE)
    return `is ${String(value)} ms, not above the lease's ${String(EXECUTION_LEASE)} ms`;
  return undefined;
}

/** The fix: the fields named set (#904: a field's problem names that field, nothing unrelated). */
const hintOf = (...fields: readonly string[]): string =>
  `@Application({ retention: { ${fields.map((field) => `${field}: hours(24)`).join(", ")} } })`;

/** A retention renamed before 0.1.1 (#889): refused naming its new name, never a silent default. */
const RENAMED: ReadonlyMap<string, string> = new Map([
  ["leaseEvents", "the audit log's rows are kept for retention.auditLog"],
  ["meshAnswers", "how long a trusted request's answer is kept is @Mesh({ deduplicationTtl })"],
]);

/** Why a field `retentionViolations` does not know is refused: renamed, or a typo. */
const unknownFieldProblem = (field: string): string => {
  const renamed = RENAMED.get(field);
  return renamed === undefined
    ? `.${field} is not a retention (${RETENTION_FIELDS.join(", ")})`
    : `.${field} is renamed: ${renamed}`;
};

/**
 * `@Application({ retention })` (#834): an object of the known fields only (a typo is not a silent
 * default), each a positive, finite duration — the fencing ones above the lease.
 */
export function retentionViolations(application: string, options: unknown): RuleViolation[] {
  if (options === undefined) return [];
  const fail = (text: string, hint = hintOf("pauseRecords", "auditLog")): RuleViolation =>
    violation("application.retention-invalid", `its retention${text} — ${hint}`, [application]);
  if (!isPlainObject(options))
    return [fail(` is ${shownValueOf(options)}, not an object of retentions`)];
  const known = new Set<string>(RETENTION_FIELDS);
  const given = options as Readonly<Record<string, unknown>>;
  return [
    ...Object.keys(given)
      .filter((field) => !known.has(field))
      .map((field) => fail(unknownFieldProblem(field))),
    ...RETENTION_FIELDS.flatMap((field) => {
      const problem = retentionProblem(field, given[field]);
      return problem === undefined ? [] : [fail(`.${field} ${problem}`, hintOf(field))];
    }),
  ];
}

/** An object literal (or one without a prototype): a `Map` or a class instance keeps no retentions. */
export const isPlainObject = (value: unknown): value is object =>
  typeof value === "object" &&
  value !== null &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null);

/** A retention option of before #834, where it was and where it is now. */
interface MovedRetention {
  /** The option holding it (`a2a`), or none for one of `@Application` itself. */
  readonly within?: string;
  readonly key: string;
  readonly now: keyof RetentionOptions;
}

const MOVED: readonly MovedRetention[] = [
  { key: "pauseRecordRetention", now: "pauseRecords" },
  { key: "executionRecordRetention", now: "executionRecords" },
  { key: "leaseEventRetention", now: "auditLog" },
  { key: "ledgerEntryRetention", now: "costLedgerEntries" },
];

/**
 * A retention set where it was before #834 (a JavaScript caller, a cast, an options object not
 * written as a literal): refused naming where it goes now — never dropped for the default, which
 * would keep execution records, intents or mesh answers shorter than asked.
 */
export function movedRetentionViolations(application: string, options: object): RuleViolation[] {
  const given = options as Readonly<Record<string, unknown>>;
  const found = MOVED.flatMap(({ within, key, now }) => {
    const holder = within === undefined ? given : given[within];
    if (typeof holder !== "object" || holder === null || !(key in holder)) return [];
    const where = within === undefined ? key : `${within}.${key}`;
    return [
      violation(
        "application.retention-invalid",
        `its ${where} is gone — @Application({ retention: { ${now} } }) sets it now`,
        [application],
      ),
    ];
  });
  return found;
}

/** How long the sweep keeps each kind of rows (`@Application({ retention })`, #834). */
/** The assembled application's retention fields, by the names the sweep reads. */
export interface AssembledRetentions {
  readonly pauseRecordRetention: Milliseconds;
  readonly executionRecordRetention?: Milliseconds;
  readonly auditLogRetention: Milliseconds;
  readonly ledgerEntryRetention: Milliseconds;
}

export const assembledRetentionsOf = (retention: ApplicationRetention): AssembledRetentions => ({
  pauseRecordRetention: retention.pauseRecords,
  ...(retention.executionRecords === undefined
    ? {}
    : { executionRecordRetention: retention.executionRecords }),
  auditLogRetention: retention.auditLog,
  ledgerEntryRetention: retention.costLedgerEntries,
});
