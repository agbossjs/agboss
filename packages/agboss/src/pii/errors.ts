import { PaidStepError } from "../graph/errors.js";
import type { UsageRecord } from "../finops/usage.js";

/**
 * A `blockWithRefusal` rule matched an incoming message or an answer (#120 AC5): the execution
 * fails and `refusal` is what goes out to the sender instead. In tool arguments or a tool result
 * the same rule rejects only that call.
 */
export class PiiRefusedError extends PaidStepError {
  static override readonly code: string = "pii.refused";
  override name = "PiiRefusedError";
  /** The kind that matched (`card-number`), or a project detector's label. */
  readonly kind: string;
  /** The text to send instead. */
  readonly refusal: string;

  constructor(kind: string, refusal: string, usage: readonly UsageRecord[] = []) {
    super(`PII of kind ${kind} refused the message: ${refusal}`, usage, undefined, {
      kind,
      refusal,
    });
    this.kind = kind;
    this.refusal = refusal;
  }
}
