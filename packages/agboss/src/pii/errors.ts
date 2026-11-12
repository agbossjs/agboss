import { PaidStepError } from "../graph/errors.js";
import type { UsageRecord } from "../finops/usage.js";

/** What a PII refusal takes (#906): the kind, the text to send instead and the spend. */
export interface PiiRefusedErrorOptions {
  /** The kind that matched (`card-number`), or a project detector's label. */
  readonly kind: string;
  /** The text to send instead. */
  readonly refusal: string;
  readonly usage?: readonly UsageRecord[];
  readonly cause?: unknown;
}

/**
 * A `blockWithRefusal` rule matched an incoming message or an answer (#120 AC5): the execution
 * fails and `refusal` is what goes out to the sender instead. In tool arguments or a tool result
 * the same rule rejects only that call.
 */
export class PiiRefusedError extends PaidStepError {
  static override readonly code = "pii.refused" as const;
  declare readonly code: typeof PiiRefusedError.code;
  override name = "PiiRefusedError";
  /** The kind that matched (`card-number`), or a project detector's label. */
  readonly kind: string;
  /** The text to send instead. */
  readonly refusal: string;

  constructor(options: PiiRefusedErrorOptions) {
    const { kind, refusal, usage = [], cause } = options;
    super({
      message: `PII of kind ${kind} refused the message: ${refusal}`,
      usage,
      cause,
      details: { kind, refusal },
    });
    this.kind = kind;
    this.refusal = refusal;
  }
}
