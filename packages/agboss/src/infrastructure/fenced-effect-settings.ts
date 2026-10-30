import { EXECUTION_LEASE } from "../app/lease-fence.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import { hours, kilobytes, minutes, type Bytes, type Milliseconds } from "../units/index.js";

/** `@Application({ fencedEffects })` (#500): the largest result and how long rows are kept. */
export interface FencedEffectsOptions {
  /** The largest stored result, in UTF-8 bytes of its JSON (default `kilobytes(64)`). */
  readonly maxResultSize?: Bytes;
  /**
   * How long a stored result and a scope's mark are kept (default `hours(24)`), then removed by
   * the recovery sweep on the `Clock` — above the lease's 30 s, so a late zombie is still refused.
   */
  readonly retention?: Milliseconds;
}

/** The default largest result: 64 KB — a receipt, not a document. */
export const DEFAULT_FENCED_EFFECT_RESULT_SIZE: Bytes = kilobytes(64);

/** The default retention: a day. */
export const DEFAULT_FENCED_EFFECT_RETENTION: Milliseconds = hours(24);

/**
 * The application's fenced-effect settings, as a fenced-effect store reads them (#500): a DI token
 * of the application's container — `@Injectable({ deps: [SqliteConnection, Clock,
 * FencedEffectSettings] })` for a store of your own.
 */
export class FencedEffectSettings {
  /** The largest stored result, in UTF-8 bytes of its JSON. */
  readonly maxResultSize: Bytes;
  /** How long stored results and marks are kept. */
  readonly retention: Milliseconds;

  constructor(options: FencedEffectsOptions = {}) {
    this.maxResultSize = options.maxResultSize ?? DEFAULT_FENCED_EFFECT_RESULT_SIZE;
    this.retention = options.retention ?? DEFAULT_FENCED_EFFECT_RETENTION;
    Object.freeze(this);
  }
}

/**
 * `@Application({ fencedEffects })` (#500): a positive `maxResultSize`, and a `retention` above the
 * lease (30 s) — a mark removed sooner would let a zombie's late write through.
 */
export function fencedEffectsViolations(
  application: string,
  options: FencedEffectsOptions | undefined,
): RuleViolation[] {
  const { maxResultSize, retention } = options ?? {};
  return sizeAndRetentionProblems(["maxResultSize", maxResultSize], retention).map((problem) =>
    violation(
      "application.fenced-effects-invalid",
      `its fencedEffects.${problem} — @Application({ fencedEffects: { maxResultSize: kilobytes(64), retention: hours(24) } })`,
      [application],
    ),
  );
}

/**
 * What is wrong with a size and a retention of rows a fenced write keeps (#500, #505): a size that
 * is not positive, a retention not above the lease (30 s) — removed sooner, a mark or an intent
 * would let a zombie's late write through.
 */
function sizeAndRetentionProblems(
  [field, size]: readonly [string, Bytes | undefined],
  retention: Milliseconds | undefined,
): string[] {
  const problems: string[] = [];
  if (size !== undefined && !(size > 0))
    problems.push(`${field} is ${String(size)} bytes, not a positive size`);
  if (retention !== undefined && !(retention > EXECUTION_LEASE))
    problems.push(
      `retention is ${String(retention)} ms, not above the lease's ${String(EXECUTION_LEASE)} ms`,
    );
  return problems;
}

/** `@Application({ outboundCalls })` (#505): the largest request and result, how long ended intents are kept. */
export interface OutboundCallsOptions {
  /** The largest request and the largest result, each in UTF-8 bytes of its JSON (default `kilobytes(64)`). */
  readonly maxPayloadSize?: Bytes;
  /**
   * How long a `Completed` or `Failed` intent is kept after it ended (default `hours(168)`, a
   * week), then removed by the recovery sweep on the `Clock`; a `Pending` one is never removed.
   */
  readonly retention?: Milliseconds;
  /**
   * How long a holder keeps its lease for an attempt still in flight once its pass ended (default
   * `minutes(2)`; #508): then it stops renewing without releasing — the lease expires, and only a
   * takeover lets another instance reconcile the call. Bounded by the shutdown timeout too.
   */
  readonly attemptTimeout?: Milliseconds;
}

/** The default bound of a holder's wait for an attempt in flight: 2 minutes. */
export const DEFAULT_OUTBOUND_CALL_ATTEMPT_TIMEOUT: Milliseconds = minutes(2);

/** The default largest request or result of an outbound call: 64 KB. */
export const DEFAULT_OUTBOUND_CALL_PAYLOAD_SIZE: Bytes = kilobytes(64);

/** The default retention of an ended outbound call: a week — reconciliation may come days later. */
export const DEFAULT_OUTBOUND_CALL_RETENTION: Milliseconds = hours(168);

/**
 * The application's outbound-call settings (#505), as `OutboundCalls` and an outbound-call store
 * read them: a DI token of the application's container.
 */
export class OutboundCallSettings {
  /** The largest request or result, in UTF-8 bytes of its JSON. */
  readonly maxPayloadSize: Bytes;
  /** How long ended intents are kept. */
  readonly retention: Milliseconds;
  /** How long a holder keeps its lease for an attempt still in flight. */
  readonly attemptTimeout: Milliseconds;
  /**
   * Whether a request is stored only masked (set by the assembly): the application or one of its
   * workflows lists PII policies, so a step with no mask refuses its call rather than store it raw.
   */
  readonly requiresMask: boolean;

  constructor(options: OutboundCallsOptions = {}, requiresMask = false) {
    this.maxPayloadSize = options.maxPayloadSize ?? DEFAULT_OUTBOUND_CALL_PAYLOAD_SIZE;
    this.retention = options.retention ?? DEFAULT_OUTBOUND_CALL_RETENTION;
    this.attemptTimeout = options.attemptTimeout ?? DEFAULT_OUTBOUND_CALL_ATTEMPT_TIMEOUT;
    this.requiresMask = requiresMask;
    Object.freeze(this);
  }
}

/**
 * `@Application({ outboundCalls })` (#505): a positive `maxPayloadSize`, a `retention` above the
 * lease (30 s) — an intent must outlive the holder that may still complete it — and a positive
 * `attemptTimeout` (#508).
 */
export function outboundCallsViolations(
  application: string,
  options: OutboundCallsOptions | undefined,
): RuleViolation[] {
  const { maxPayloadSize, retention, attemptTimeout } = options ?? {};
  const isTimeoutValid =
    attemptTimeout === undefined || (Number.isFinite(attemptTimeout) && attemptTimeout > 0);
  const timeout = isTimeoutValid
    ? []
    : [`attemptTimeout is ${String(attemptTimeout)} ms, not a positive duration`];
  const problems = [
    ...sizeAndRetentionProblems(["maxPayloadSize", maxPayloadSize], retention),
    ...timeout,
  ];
  return problems.map((problem) =>
    violation(
      "application.outbound-calls-invalid",
      `its outboundCalls.${problem} — @Application({ outboundCalls: { maxPayloadSize: kilobytes(64), retention: hours(168) } })`,
      [application],
    ),
  );
}
