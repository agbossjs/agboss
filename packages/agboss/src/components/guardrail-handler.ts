import type { FileContent } from "../files/file-bytes.js";
import type { GuardrailSide } from "./policy-decorators.js";

/**
 * A code guardrail (#383): `@InputGuardrail` / `@OutputGuardrail({ decidedBy: DecidedBy.Code })`
 * decides by its class's `check(content)` instead of a model — no model call, cost 0. The content is
 * what the guarded model reads (or what the agent answered), already masked by the element's PII
 * policies; `GuardrailVerdict.blocked(refusal?)` fails the execution with the same
 * `GuardrailBlockedError` and the refusal as a model guardrail's hit.
 */

/** What a code guardrail decided on one content: built only with `passed()` / `blocked()`. */
export class GuardrailVerdict {
  /** Nominal: a plain `{ isBlocked }` object is not a verdict. */
  declare private readonly built: true;

  /** Whether the guardrail blocks the content. */
  readonly isBlocked: boolean;

  /**
   * The text sent instead when this call blocked, set by `blocked(refusal)`: it lives on the verdict
   * of this call, never on the shared class instance, so concurrent executions never mix it up.
   */
  readonly refusal?: string;

  private constructor(isBlocked: boolean, refusal?: string) {
    this.isBlocked = isBlocked;
    if (refusal !== undefined) this.refusal = refusal;
    Object.freeze(this);
  }

  /** The content passes: the execution goes on. */
  static passed(): GuardrailVerdict {
    return new GuardrailVerdict(false);
  }

  /**
   * The content is blocked: the execution fails with `GuardrailBlockedError` and the refusal — this
   * call's `refusal`, else the decorator's `refusal`, else the class's `refusal(content)`. With none
   * of the three the guardrail fails closed (`GuardFailedError`).
   */
  static blocked(refusal?: string): GuardrailVerdict {
    return new GuardrailVerdict(true, refusal);
  }
}

/** Whether a value is a verdict built by `GuardrailVerdict.passed()` / `.blocked()`. */
export const isGuardrailVerdict = (value: unknown): value is GuardrailVerdict =>
  value instanceof GuardrailVerdict;

/**
 * What a guardrail reads (#899 §8): the masked text — the text of the files that are text (a
 * transcription, a CSV) appended to it — and every file in every view the model got: an original as
 * the file, a transcription as a `text/plain` file of the masked text. `files` is `[]` when none.
 */
export interface GuardrailContent {
  readonly text: string;
  readonly files: readonly FileContent[];
  /** The agent or router whose model it guards (or whose answer it checks). */
  readonly component: string;
  /** Whether it checks what comes into the model, or what an agent answers. */
  readonly side: GuardrailSide;
}

/** What a code guardrail's class has: `check(content)`, one method for text and files. */
export interface GuardrailHandler {
  /** Checks one content: `GuardrailVerdict.passed()` or `GuardrailVerdict.blocked(refusal?)`. */
  readonly check: (content: GuardrailContent) => Promise<GuardrailVerdict> | GuardrailVerdict;
}
