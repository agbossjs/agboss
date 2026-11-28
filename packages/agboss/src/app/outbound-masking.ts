/**
 * Whether the application stores a call's request only masked (#505, #795, #1317): `true` where the
 * application or one of its workflows lists PII policies — the assembly says so. A DI token of the
 * application's container, read by `Idempotency.sendOnce`: a step with no mask then refuses its
 * call (`OutboundCallError.Unmasked`) rather than store the request raw.
 */
export class OutboundMasking {
  /** Whether a request is stored only masked. */
  readonly requiresMask: boolean;

  // none given: masked (fail closed) — and no required parameter, so the assembly's DI check takes
  // this token as one needing no decorator
  constructor(
    options: { readonly requiresMask: boolean } = {} as { readonly requiresMask: boolean },
  ) {
    // only an explicit `false` lets a request be stored unmasked: none given, or a JavaScript caller's
    // options without a boolean `requiresMask`, fail closed
    const given: unknown = options.requiresMask;
    this.requiresMask = given !== false;
    Object.freeze(this);
  }
}
