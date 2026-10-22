/**
 * A code guardrail (#383): `@InputGuardrail` / `@OutputGuardrail({ decidedBy: DecidedBy.Code })`
 * decides by its class's `check(text)` instead of a model — no model call, cost 0. The text is what
 * the guarded model reads (or what the agent answered), already masked by the element's PII
 * policies; `GuardrailVerdict.blocked()` fails the execution with the same `GuardrailBlockedError`
 * and the guardrail's refusal as a model guardrail's hit.
 */

/** What a code guardrail decided on one text: built only with `passed()` / `blocked()`. */
export class GuardrailVerdict {
  /** Nominal: a plain `{ isBlocked }` object is not a verdict. */
  declare private readonly built: true;

  /** Whether the guardrail blocks the text. */
  readonly isBlocked: boolean;

  private constructor(isBlocked: boolean) {
    this.isBlocked = isBlocked;
    Object.freeze(this);
  }

  /** The text passes: the execution goes on. */
  static passed(): GuardrailVerdict {
    return new GuardrailVerdict(false);
  }

  /** The text is blocked: the execution fails with `GuardrailBlockedError` and the refusal. */
  static blocked(): GuardrailVerdict {
    return new GuardrailVerdict(true);
  }
}

/** Whether a value is a verdict built by `GuardrailVerdict.passed()` / `.blocked()`. */
export const isGuardrailVerdict = (value: unknown): value is GuardrailVerdict =>
  value instanceof GuardrailVerdict;

/** What a code guardrail's class implements: `check(text)` on the masked text. */
export interface GuardrailHandler {
  /** Checks one text: `GuardrailVerdict.passed()` or `GuardrailVerdict.blocked()`. */
  readonly check: (text: string) => Promise<GuardrailVerdict> | GuardrailVerdict;
}
