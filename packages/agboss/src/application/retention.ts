import { EXECUTION_LEASE } from "../app/lease-fence.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import {
  DEFAULT_FENCED_EFFECT_RETENTION,
  DEFAULT_OUTBOUND_CALL_RETENTION,
} from "../infrastructure/fenced-effect-settings.js";
import { DEFAULT_IDEMPOTENCY_RETENTION } from "../mesh/mesh-defaults.js";
import { hours, minutes, type Milliseconds } from "../units/index.js";
import { shownValueOf } from "../core/shown-value.js";

/**
 * `@Application({ retention })` (#834): how long each kind of row the application keeps stays
 * after it is done with, every one removed by the recovery sweep on the `Clock` — the one place a
 * retention is set. Sizes and timeouts stay with their feature (`fencedEffects.maxResultSize`,
 * `outboundCalls.attemptTimeout`). Each is a positive duration (`[application.retention-invalid]`);
 * the fencing ones — `fencedEffects`, `outboundCalls`, `costLedgerEntries` — above the lease's 30 s,
 * so a late zombie or a retried write is still refused, never let through.
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
  /**
   * A fenced effect's stored result and its scope's mark (#500, `FencedEffectRepository`) after it
   * was stored. Above the lease, so a late zombie is still refused. Default `hours(24)`.
   */
  readonly fencedEffects?: Milliseconds;
  /**
   * A `Completed` or `Failed` outbound call after it ended (#505, `OutboundCalls`); a `Pending` one
   * is never removed. Above the lease: an intent outlives the holder that may still complete it.
   * Default `hours(168)` — reconciliation may come days later.
   */
  readonly outboundCalls?: Milliseconds;
  /**
   * A trusted mesh request's answer, kept for a repeat of its idempotency key (#398 PR 2,
   * `MeshRequestRepository`). Default `minutes(30)`.
   */
  readonly meshAnswers?: Milliseconds;
  /**
   * A finished A2A task after its last status change (#807) — and with it the ids of its messages:
   * a message resent within it gets the same task, never a second execution. An unfinished task is
   * never removed. Default `hours(24)`.
   */
  readonly a2aTasks?: Milliseconds;
  /**
   * The files of an A2A task (#859, `A2AFileRepository`) after the task is over — never while it is
   * not: a paused, `INPUT_REQUIRED` task keeps them however long it waits. At most `a2aTasks`: a
   * file outliving its task is read by no one. Default `a2aTasks`.
   */
  readonly a2aFiles?: Milliseconds;
  /**
   * A direct A2A message's reply (#860, `A2AReply.Message`, `A2ADirectMessageRepository`) after it
   * was accepted — and with it its `messageId`: a resend within it gets the same reply, the skill
   * never runs twice; after it the id is free. Published on the Agent Card as the mesh extension's
   * `messageIdempotencyRetention`. Above the lease. Default `minutes(15)`.
   */
  readonly a2aMessages?: Milliseconds;
}

/** The retentions an application runs with: each set one, else its default (`executionRecords` stays unset). */
export interface ApplicationRetention {
  readonly pauseRecords: Milliseconds;
  /** Unset: no root execution is kept. */
  readonly executionRecords?: Milliseconds;
  readonly auditLog: Milliseconds;
  readonly costLedgerEntries: Milliseconds;
  readonly fencedEffects: Milliseconds;
  readonly outboundCalls: Milliseconds;
  readonly meshAnswers: Milliseconds;
  readonly a2aTasks: Milliseconds;
  readonly a2aFiles: Milliseconds;
  readonly a2aMessages: Milliseconds;
}

/** The defaults of every retention but `executionRecords` (unset = nothing kept). */
export const DEFAULT_RETENTION: Readonly<
  Omit<ApplicationRetention, "executionRecords" | "a2aFiles">
> = Object.freeze({
  pauseRecords: hours(24),
  auditLog: hours(24),
  // a pass retries a lost write at its next read of the counters, seconds later: only a pass
  // asleep for a day meets the refusal
  costLedgerEntries: hours(24),
  fencedEffects: DEFAULT_FENCED_EFFECT_RETENTION,
  outboundCalls: DEFAULT_OUTBOUND_CALL_RETENTION,
  meshAnswers: DEFAULT_IDEMPOTENCY_RETENTION as Milliseconds,
  a2aTasks: hours(24),
  a2aMessages: minutes(15),
});

/** Every field of `RetentionOptions`: a key outside them is a typo, never a silent default. */
const RETENTION_FIELDS: readonly (keyof RetentionOptions)[] = [
  "pauseRecords",
  "executionRecords",
  "auditLog",
  "costLedgerEntries",
  "fencedEffects",
  "outboundCalls",
  "meshAnswers",
  "a2aTasks",
  "a2aFiles",
  "a2aMessages",
];

/**
 * The retentions of rows a fenced write relies on: removed sooner than the lease (30 s), a mark,
 * an intent or a ledger entry would let a zombie's late write — or a retried one — through; a
 * direct message's row (#860) would go while its reply is still being made, and a resend run again.
 */
const ABOVE_THE_LEASE: ReadonlySet<keyof RetentionOptions> = new Set([
  "fencedEffects",
  "outboundCalls",
  "costLedgerEntries",
  "a2aMessages",
]);

/** #859: how long an A2A task's files are kept once it is over — by default as long as the task. */
const fileRetentionOf = (given: RetentionOptions): Milliseconds =>
  given.a2aFiles ?? given.a2aTasks ?? DEFAULT_RETENTION.a2aTasks;

/** The A2A retentions (#807, #859, #860) with their defaults. */
const a2aRetentionOf = (
  given: RetentionOptions,
): Pick<ApplicationRetention, "a2aTasks" | "a2aFiles" | "a2aMessages"> => ({
  a2aTasks: given.a2aTasks ?? DEFAULT_RETENTION.a2aTasks,
  a2aFiles: fileRetentionOf(given),
  a2aMessages: given.a2aMessages ?? DEFAULT_RETENTION.a2aMessages,
});

/** `@Application({ retention })` with the defaults filled in. */
export function retentionOf(options: RetentionOptions | undefined): ApplicationRetention {
  const given = options ?? {};
  return {
    pauseRecords: given.pauseRecords ?? DEFAULT_RETENTION.pauseRecords,
    ...(given.executionRecords === undefined ? {} : { executionRecords: given.executionRecords }),
    auditLog: given.auditLog ?? DEFAULT_RETENTION.auditLog,
    costLedgerEntries: given.costLedgerEntries ?? DEFAULT_RETENTION.costLedgerEntries,
    fencedEffects: given.fencedEffects ?? DEFAULT_RETENTION.fencedEffects,
    outboundCalls: given.outboundCalls ?? DEFAULT_RETENTION.outboundCalls,
    meshAnswers: given.meshAnswers ?? DEFAULT_RETENTION.meshAnswers,
    ...a2aRetentionOf(given),
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

const HINT = "@Application({ retention: { fencedEffects: hours(24), meshAnswers: minutes(30) } })";

/** A retention renamed before 0.1.1 (#889): refused naming its new name, never a silent default. */
const RENAMED: Readonly<Record<string, string>> = {
  leaseEvents: "the audit log's rows are kept for retention.auditLog",
};

/** Why a field `retentionViolations` does not know is refused: renamed, or a typo. */
const unknownFieldProblem = (field: string): string =>
  Object.hasOwn(RENAMED, field)
    ? `.${field} is renamed: ${RENAMED[field] ?? ""}`
    : `.${field} is not a retention (${RETENTION_FIELDS.join(", ")})`;

/**
 * `@Application({ retention })` (#834): an object of the known fields only (a typo is not a silent
 * default), each a positive, finite duration — the fencing ones above the lease.
 */
export function retentionViolations(application: string, options: unknown): RuleViolation[] {
  if (options === undefined) return [];
  const fail = (text: string): RuleViolation =>
    violation("application.retention-invalid", `its retention${text} — ${HINT}`, [application]);
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
      return problem === undefined ? [] : [fail(`.${field} ${problem}`)];
    }),
    ...fileRetentionViolations(given, fail),
  ];
}

/** #859: `a2aFiles` above `a2aTasks` (as given or by default) keeps files no task reads. */
function fileRetentionViolations(
  given: Readonly<Record<string, unknown>>,
  fail: (text: string) => RuleViolation,
): RuleViolation[] {
  const files = given.a2aFiles;
  const tasks = given.a2aTasks ?? DEFAULT_RETENTION.a2aTasks;
  if (typeof files !== "number" || typeof tasks !== "number" || files <= tasks) return [];
  return [
    fail(
      `.a2aFiles is ${String(files)} ms, above a2aTasks' ${String(tasks)} ms — a file outliving its task is read by no one`,
    ),
  ];
}

/** An object literal (or one without a prototype): a `Map` or a class instance keeps no retentions. */
const isPlainObject = (value: unknown): value is object =>
  typeof value === "object" &&
  value !== null &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null);

/** A retention option of before #834, where it was and where it is now. */
interface MovedRetention {
  /** The option holding it (`fencedEffects`), or none for one of `@Application` itself. */
  readonly within?: string;
  readonly key: string;
  readonly now: keyof RetentionOptions;
}

const MOVED: readonly MovedRetention[] = [
  { key: "pauseRecordRetention", now: "pauseRecords" },
  { key: "executionRecordRetention", now: "executionRecords" },
  { key: "leaseEventRetention", now: "auditLog" },
  { key: "ledgerEntryRetention", now: "costLedgerEntries" },
  { within: "fencedEffects", key: "retention", now: "fencedEffects" },
  { within: "outboundCalls", key: "retention", now: "outboundCalls" },
  { within: "mesh", key: "idempotencyRetention", now: "meshAnswers" },
  { within: "a2a", key: "taskRetention", now: "a2aTasks" },
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
  // an `a2a` without its retention is gone too: the option held nothing else
  const a2a = given.a2a;
  const isBareA2A =
    a2a !== undefined && !(typeof a2a === "object" && a2a !== null && "taskRetention" in a2a);
  if (!isBareA2A) return found;
  const gone =
    "its a2a option is gone — how long A2A tasks are kept is @Application({ retention: { a2aTasks } })";
  return [...found, violation("application.retention-invalid", gone, [application])];
}

/** How long the sweep keeps each kind of rows (`@Application({ retention })`, #834). */
/** The assembled application's retention fields, by the names the sweep reads. */
export interface AssembledRetentions {
  readonly pauseRecordRetention: Milliseconds;
  readonly executionRecordRetention?: Milliseconds;
  readonly auditLogRetention: Milliseconds;
  readonly a2aTaskRetention: Milliseconds;
  readonly a2aFileRetention: Milliseconds;
  /** How long a direct A2A message's reply is kept (`retention.a2aMessages`, #860). */
  readonly a2aMessageRetention: Milliseconds;
  readonly ledgerEntryRetention: Milliseconds;
  readonly meshAnswerRetention: Milliseconds;
}

export const assembledRetentionsOf = (retention: ApplicationRetention): AssembledRetentions => ({
  pauseRecordRetention: retention.pauseRecords,
  ...(retention.executionRecords === undefined
    ? {}
    : { executionRecordRetention: retention.executionRecords }),
  auditLogRetention: retention.auditLog,
  a2aTaskRetention: retention.a2aTasks,
  a2aFileRetention: retention.a2aFiles,
  a2aMessageRetention: retention.a2aMessages,
  ledgerEntryRetention: retention.costLedgerEntries,
  meshAnswerRetention: retention.meshAnswers,
});
