import { hours, type Milliseconds } from "../units/index.js";

/**
 * What the application keeps and masks for its idempotent effects (#500, #505, #1317): the
 * retention of stored rows, as the recovery sweep reads it (#834: `@Application({ retention })`),
 * and whether a call's request is stored only masked. Everything per call — the largest result and
 * payload, the bound of an attempt — is an option of `Idempotency.runOnce` / `sendOnce` itself.
 */

/** The default retention of a stored result and a scope's mark: a day. */
export const DEFAULT_FENCED_EFFECT_RETENTION: Milliseconds = hours(24);

/** The default retention of an ended outbound call: a week — reconciliation may come days later. */
export const DEFAULT_OUTBOUND_CALL_RETENTION: Milliseconds = hours(168);

/**
 * The retention of idempotent effects' rows: a DI token of the application's container, read by the
 * assembly's sweep sources.
 */
export class FencedEffectSettings {
  /** How long stored results and marks are kept, then removed by the recovery sweep on the `Clock`. */
  readonly retention: Milliseconds;

  constructor(options: { readonly retention?: Milliseconds } = {}) {
    this.retention = options.retention ?? DEFAULT_FENCED_EFFECT_RETENTION;
    Object.freeze(this);
  }
}

/** What `OutboundCallSettings` is built from: the retention and whether a request is stored only masked. */
export interface OutboundCallSettingsOptions {
  /** How long a `Completed` or `Failed` intent is kept after it ended; a `Pending` one is never removed. */
  readonly retention?: Milliseconds;
  /**
   * Whether a request is stored only masked: `true` where the application or one of its workflows
   * lists PII policies (the assembly says so). A JavaScript caller that leaves it out, or gives no
   * boolean, gets `true` — the step with no mask then refuses its call rather than store it raw.
   */
  readonly requiresMask: boolean;
}

/** The outbound-call settings of the application, as `Idempotency` reads them: a DI token of its container. */
export class OutboundCallSettings {
  /** How long ended intents are kept. */
  readonly retention: Milliseconds;
  /** Whether a request is stored only masked (set by the assembly). */
  readonly requiresMask: boolean;

  // none given: masked (fail closed) — and no required parameter, so the assembly's DI check takes
  // this token as one needing no decorator
  constructor(options: OutboundCallSettingsOptions = { requiresMask: true }) {
    // a JavaScript caller's options without a boolean `requiresMask` fail closed too
    const given: Partial<OutboundCallSettingsOptions> = options;
    this.retention = given.retention ?? DEFAULT_OUTBOUND_CALL_RETENTION;
    this.requiresMask = given.requiresMask !== false;
    Object.freeze(this);
  }
}
