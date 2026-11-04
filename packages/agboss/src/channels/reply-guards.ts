import type { AssembledReplyInterpreter } from "./discovery.js";
import { withinCurrency } from "./reply-currency.js";
import type { ModelReading, ReplyInterpreterInput } from "./reply-reader.js";
import { correctionRefusalOf } from "./reply-tools.js";

/**
 * What no model's reading of an approval may give, whichever model read it — a chat model's answer
 * tool or a decision model's yes (#688, security review): a correction that raises the call, adds a
 * field or changes a value's kind, and an approval in a currency the call is not in. Both are not
 * understood. A question role's answer (#659) is its own DTO: nothing to guard.
 */
export function guardedReading(
  reading: ModelReading,
  interpreter: AssembledReplyInterpreter,
  input: ReplyInterpreterInput,
): ModelReading {
  if (reading.kind !== "answered" || interpreter.approves === undefined) return reading;
  const refusal = correctionRefusalOf(reading.answer, input.ask);
  if (refusal !== undefined) {
    const reason = `the reply does not answer the question: ${refusal} — a raise or a new field is decided, never read from a reply`;
    return { kind: "declined", reason, usage: reading.usage };
  }
  return withinCurrency(reading, interpreter, input.reply);
}
