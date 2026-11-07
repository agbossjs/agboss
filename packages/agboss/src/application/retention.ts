import { EXECUTION_LEASE } from "../app/lease-fence.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import {
  DEFAULT_FENCED_EFFECT_RETENTION,
  DEFAULT_OUTBOUND_CALL_RETENTION,
} from "../infrastructure/fenced-effect-settings.js";
import { DEFAULT_IDEMPOTENCY_RETENTION } from "../mesh/mesh-defaults.js";
import { hours, type Milliseconds } from "../units/index.js";

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
   * A row of the lease log after it happened (#501): every takeover of a tree's lease and every
   * step handed over, written to the `ExecutionLeaseEventRepository` whatever `executionRecords`
   * says, read by `app.leaseEventsOf`. Default `hours(24)`.
   */
  readonly leaseEvents?: Milliseconds;
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
}

/** The retentions an application runs with: each set one, else its default (`executionRecords` stays unset). */
export interface ApplicationRetention {
  readonly pauseRecords: Milliseconds;
  /** Unset: no root execution is kept. */
  readonly executionRecords?: Milliseconds;
  readonly leaseEvents: Milliseconds;
  readonly costLedgerEntries: Milliseconds;
  readonly fencedEffects: Milliseconds;
  readonly outboundCalls: Milliseconds;
  readonly meshAnswers: Milliseconds;
  readonly a2aTasks: Milliseconds;
}

/** The defaults of every retention but `executionRecords` (unset = nothing kept). */
export const DEFAULT_RETENTION: Readonly<Omit<ApplicationRetention, "executionRecords">> =
  Object.freeze({
    pauseRecords: hours(24),
    leaseEvents: hours(24),
    // a pass retries a lost write at its next read of the counters, seconds later: only a pass
    // asleep for a day meets the refusal
    costLedgerEntries: hours(24),
    fencedEffects: DEFAULT_FENCED_EFFECT_RETENTION,
    outboundCalls: DEFAULT_OUTBOUND_CALL_RETENTION,
    meshAnswers: DEFAULT_IDEMPOTENCY_RETENTION as Milliseconds,
    a2aTasks: hours(24),
  });

/** Every field of `RetentionOptions`: a key outside them is a typo, never a silent default. */
const RETENTION_FIELDS: readonly (keyof RetentionOptions)[] = [
  "pauseRecords",
  "executionRecords",
  "leaseEvents",
  "costLedgerEntries",
  "fencedEffects",
  "outboundCalls",
  "meshAnswers",
  "a2aTasks",
];

/**
 * The retentions of rows a fenced write relies on: removed sooner than the lease (30 s), a mark,
 * an intent or a ledger entry would let a zombie's late write — or a retried one — through.
 */
const ABOVE_THE_LEASE: ReadonlySet<keyof RetentionOptions> = new Set([
  "fencedEffects",
  "outboundCalls",
  "costLedgerEntries",
]);

/** `@Application({ retention })` with the defaults filled in. */
export function retentionOf(options: RetentionOptions | undefined): ApplicationRetention {
  const given = options ?? {};
  return {
    pauseRecords: given.pauseRecords ?? DEFAULT_RETENTION.pauseRecords,
    ...(given.executionRecords === undefined ? {} : { executionRecords: given.executionRecords }),
    leaseEvents: given.leaseEvents ?? DEFAULT_RETENTION.leaseEvents,
    costLedgerEntries: given.costLedgerEntries ?? DEFAULT_RETENTION.costLedgerEntries,
    fencedEffects: given.fencedEffects ?? DEFAULT_RETENTION.fencedEffects,
    outboundCalls: given.outboundCalls ?? DEFAULT_RETENTION.outboundCalls,
    meshAnswers: given.meshAnswers ?? DEFAULT_RETENTION.meshAnswers,
    a2aTasks: given.a2aTasks ?? DEFAULT_RETENTION.a2aTasks,
  };
}

/** What is wrong with one retention, or `undefined`. */
function retentionProblem(field: keyof RetentionOptions, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return `is ${String(value)}, not a positive duration`;
  if (ABOVE_THE_LEASE.has(field) && value <= EXECUTION_LEASE)
    return `is ${String(value)} ms, not above the lease's ${String(EXECUTION_LEASE)} ms`;
  return undefined;
}

const HINT = "@Application({ retention: { fencedEffects: hours(24), meshAnswers: minutes(30) } })";

/**
 * `@Application({ retention })` (#834): an object of the known fields only (a typo is not a silent
 * default), each a positive, finite duration — the fencing ones above the lease.
 */
export function retentionViolations(application: string, options: unknown): RuleViolation[] {
  if (options === undefined) return [];
  const fail = (text: string): RuleViolation =>
    violation("application.retention-invalid", `its retention${text} — ${HINT}`, [application]);
  if (typeof options !== "object" || options === null || Array.isArray(options))
    return [fail(` is ${String(options)}, not an object of retentions`)];
  const known = new Set<string>(RETENTION_FIELDS);
  const given = options as Readonly<Record<string, unknown>>;
  return [
    ...Object.keys(given)
      .filter((field) => !known.has(field))
      .map((field) => fail(`.${field} is not a retention (${RETENTION_FIELDS.join(", ")})`)),
    ...RETENTION_FIELDS.flatMap((field) => {
      const problem = retentionProblem(field, given[field]);
      return problem === undefined ? [] : [fail(`.${field} ${problem}`)];
    }),
  ];
}
