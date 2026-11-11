import { AGBossError } from "../core/errors.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import { hours, kilobytes, minutes, type Bytes, type Milliseconds } from "../units/index.js";

/**
 * `@Application({ fencedEffects })` (#500): the largest result (how long rows are kept is
 * `@Application({ retention: { fencedEffects } })`, #834).
 */
export interface FencedEffectOptions {
  /** The largest stored result, in UTF-8 bytes of its JSON (default `kilobytes(64)`). */
  readonly maxResultSize?: Bytes;
}

/**
 * What `FencedEffectSettings` is built from: the application's `fencedEffects` and its
 * `retention.fencedEffects` (a store's test builds one with either).
 */
export interface FencedEffectSettingsOptions extends FencedEffectOptions {
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

  constructor(options: FencedEffectSettingsOptions = {}) {
    this.maxResultSize = options.maxResultSize ?? DEFAULT_FENCED_EFFECT_RESULT_SIZE;
    this.retention = options.retention ?? DEFAULT_FENCED_EFFECT_RETENTION;
    Object.freeze(this);
  }
}

/** `@Application({ fencedEffects })` (#500): a positive `maxResultSize`. */
export function fencedEffectsViolations(
  application: string,
  options: FencedEffectOptions | undefined,
): RuleViolation[] {
  return sizeProblems("maxResultSize", options?.maxResultSize).map((problem) =>
    violation(
      "application.fenced-effects-invalid",
      `its fencedEffects.${problem} — @Application({ fencedEffects: { maxResultSize: kilobytes(64) } })`,
      [application],
    ),
  );
}

/** What is wrong with a size of what a fenced write keeps (#500, #505): one that is not positive. */
function sizeProblems(field: string, size: Bytes | undefined): string[] {
  return size === undefined || size > 0
    ? []
    : [`${field} is ${String(size)} bytes, not a positive size`];
}

/**
 * `@Application({ outboundCalls })` (#505): the largest request and result, and the bound of an
 * attempt (how long ended intents are kept is `@Application({ retention: { outboundCalls } })`, #834).
 */
export interface OutboundCallOptions {
  /** The largest request and the largest result, each in UTF-8 bytes of its JSON (default `kilobytes(64)`). */
  readonly maxPayloadSize?: Bytes;
  /**
   * The bound of an attempt in flight, from the moment it started (default `minutes(2)`; #508):
   * until then its holder releases its lease only once the attempt settled, and yields it under none.
   * Past it — or the instance's stop, or a lost lease — the holder stops renewing without releasing:
   * the lease expires within its 30 s, so another instance sees the call in flight for
   * `attemptTimeout` plus up to the lease's TTL, then closes the lease and reconciles; a hung attempt
   * no longer holds a yield back either (a reclaim moves its token on). **A send still hung past this
   * bound can coincide with a reconcile and a resend; the provider must deduplicate on
   * `call.idempotencyKey` (G1).** Its late answer is fenced, never stored.
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
 * What `OutboundCallSettings` is built from (#795): the application's `outboundCalls`, its
 * `retention.outboundCalls` and whether a request is stored only masked — always said, never a
 * silent `false`.
 */
export interface OutboundCallSettingsOptions extends OutboundCallOptions {
  /**
   * How long a `Completed` or `Failed` intent is kept after it ended (default `hours(168)`, a
   * week), then removed by the recovery sweep on the `Clock`; a `Pending` one is never removed.
   */
  readonly retention?: Milliseconds;
  /**
   * Whether a request is stored only masked: `true` where the application or one of its workflows
   * lists PII policies (the assembly says so). A JavaScript caller that leaves it out, or gives no
   * boolean, gets `true` — the step with no mask then refuses its call rather than store it raw.
   */
  readonly requiresMask: boolean;
}

/**
 * The application's outbound-call settings (#505), as `OutboundCalls` and an outbound-call store
 * read them: a DI token of the application's container.
 */
export class OutboundCallSettings {
  /** The largest request or result, in UTF-8 bytes of its JSON. */
  readonly maxPayloadSize: Bytes;
  /** How long ended intents are kept. */
  readonly retention: Milliseconds;
  /** The bound of an attempt in flight, from its start: its lease's wait, and its hold on yields. */
  readonly attemptTimeout: Milliseconds;
  /**
   * Whether a request is stored only masked (set by the assembly): the application or one of its
   * workflows lists PII policies, so a step with no mask refuses its call rather than store it raw.
   */
  readonly requiresMask: boolean;

  // none given: masked (fail closed), the defaults for the rest — and no required parameter, so the
  // assembly's DI check takes this token as one needing no decorator (as `FencedEffectSettings`)
  constructor(options: OutboundCallSettingsOptions = { requiresMask: true }) {
    // a JavaScript caller's options without a boolean `requiresMask` fail closed too
    const given: Partial<OutboundCallSettingsOptions> = options;
    this.maxPayloadSize = given.maxPayloadSize ?? DEFAULT_OUTBOUND_CALL_PAYLOAD_SIZE;
    this.retention = given.retention ?? DEFAULT_OUTBOUND_CALL_RETENTION;
    this.attemptTimeout = given.attemptTimeout ?? DEFAULT_OUTBOUND_CALL_ATTEMPT_TIMEOUT;
    this.requiresMask = given.requiresMask !== false;
    Object.freeze(this);
  }
}

/** `@Application({ outboundCalls })` (#505): a positive `maxPayloadSize` and `attemptTimeout` (#508). */
export function outboundCallsViolations(
  application: string,
  options: OutboundCallOptions | undefined,
): RuleViolation[] {
  const { maxPayloadSize, attemptTimeout } = options ?? {};
  const isTimeoutValid =
    attemptTimeout === undefined || (Number.isFinite(attemptTimeout) && attemptTimeout > 0);
  const timeout = isTimeoutValid
    ? []
    : [`attemptTimeout is ${String(attemptTimeout)} ms, not a positive duration`];
  const problems = [...sizeProblems("maxPayloadSize", maxPayloadSize), ...timeout];
  return problems.map((problem) =>
    violation(
      "application.outbound-calls-invalid",
      `its outboundCalls.${problem} — @Application({ outboundCalls: { maxPayloadSize: kilobytes(64), attemptTimeout: minutes(2) } })`,
      [application],
    ),
  );
}

/** What a result too large to store knows: the effect, its size and the limit (UTF-8 bytes). */
export interface FencedEffectResultTooLargeErrorOptions {
  /** The effect's `name` (`effectKeyOf(executionContext, name)`). */
  readonly effect: string;
  readonly size: number;
  readonly maxResultSize: number;
}

/**
 * A fenced effect's result is larger than `@Application({ fencedEffects: { maxResultSize } })`
 * (#500, default 64 KB): its transaction is rolled back — the business rows too — and the step
 * fails with it. Store a reference (an id, a receipt number), not the document.
 */
export class FencedEffectResultTooLargeError extends AGBossError {
  static override readonly code = "fenced-effect.result-too-large" as const;
  override name = "FencedEffectResultTooLargeError";
  readonly effect: string;
  readonly size: number;
  readonly maxResultSize: number;

  constructor(options: FencedEffectResultTooLargeErrorOptions) {
    super(
      `the result of fenced effect "${options.effect}" is ${String(options.size)} bytes, above its maxResultSize of ${String(options.maxResultSize)} bytes: nothing was written — store a reference to it, or raise @Application({ fencedEffects: { maxResultSize } })`,
    );
    this.effect = options.effect;
    this.size = options.size;
    this.maxResultSize = options.maxResultSize;
  }
}
