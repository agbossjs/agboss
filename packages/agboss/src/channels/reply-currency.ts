import { jsonSchemaOf } from "../dto/schema.js";
import type { DtoClass } from "../dto/types.js";
import { AMBIGUOUS_CURRENCY, currencySignalsOf, ISO_4217_CODES } from "./currency-signals.js";
import type { AssembledReplyInterpreter } from "./discovery.js";
import type { ModelReading } from "./reply-reader.js";

/**
 * A reply's currency against the call's (#688, security review): an approval may stand only in the
 * call's own currency — "yes, up to €900", "500cad", "five hundred euros" on a call in US dollars
 * would need converting, a guess no model may make on the approver's behalf. Fail closed by
 * construction, two checks, both on every approval (a chat model's answer and a decision model's
 * yes alike):
 * - the text: if the reply holds any currency signal (`currency-signals.ts`) that is not the call's
 *   currency — or names no one currency for sure — it is not understood, wherever the signal stands;
 * - the model's `currency` (the answer tool's required field): only the call's currency, or
 *   `unspecified` when the reply names no currency at all. A decision model, or an answer in the
 *   DTO's own shape, names none: `unspecified`.
 * A false "not understood" asks the person again; a false approval spends money. A call whose fields
 * name no currency has nothing to compare: the checks do not apply.
 */

/** The model's word for a reply that names no currency. */
export const UNSPECIFIED_CURRENCY = "unspecified";

/** What the answer tool's `currency` may be: an ISO 4217 code, or `unspecified`. */
export const CURRENCY_CHOICES: readonly string[] = [UNSPECIFIED_CURRENCY, ...ISO_4217_CODES];

/** A field named for its currency, `amountUsd` or `amount_usd`: the code as its last word. */
const CODE_SUFFIX = /(?:[a-z0-9]([A-Z][a-z]{2})|_([a-z]{3}))$/u;

/** The currencies an approved call's fields name — by their names and descriptions — for sure. */
export function callCurrenciesOf(approves: DtoClass): ReadonlySet<string> {
  const schema = jsonSchemaOf(approves) as {
    readonly properties?: Readonly<Record<string, { readonly description?: string }>>;
  };
  const found = new Set<string>();
  for (const [name, field] of Object.entries(schema.properties ?? {})) {
    const [, camel, snake] = CODE_SUFFIX.exec(name) ?? [];
    const suffix = (camel ?? snake ?? "").toUpperCase();
    if (ISO_4217_CODES.includes(suffix)) found.add(suffix);
    for (const signal of currencySignalsOf(field.description ?? "", { codesInCapitalsOnly: true }))
      if (signal !== AMBIGUOUS_CURRENCY) found.add(signal);
  }
  return found;
}

const named = (codes: Iterable<string>): string =>
  [...new Set(codes)]
    .map((code) => (code === AMBIGUOUS_CURRENCY ? "a currency it cannot tell" : code))
    .join(", ");

/**
 * Why an approval cannot be read in the call's currency; `undefined` when it can. `currency` is the
 * model's own word for the reply's currency (`unspecified` when it gave none).
 */
export function currencyMismatchOf(
  reply: string,
  approves: DtoClass,
  currency: string = UNSPECIFIED_CURRENCY,
): string | undefined {
  const ofCall = callCurrenciesOf(approves);
  if (ofCall.size === 0) return undefined;
  const call = named(ofCall);
  const signals = currencySignalsOf(reply);
  const foreign = signals.filter((signal) => !ofCall.has(signal));
  if (foreign.length > 0)
    return `the reply names ${named(foreign)} and the call is in ${call}: converting it would be a guess`;
  if (currency === UNSPECIFIED_CURRENCY)
    return signals.length === 0
      ? undefined
      : `the reply names ${named(signals)} but the reading names no currency: the call is in ${call}`;
  return ofCall.has(currency)
    ? undefined
    : `the reading's currency is ${currency} and the call is in ${call}: converting it would be a guess`;
}

/**
 * An approval in a currency the call is not in is no answer (#688), with a correction or without
 * ("yes, in CAD" approves no call in US dollars). A refusal stays a refusal.
 */
export function withinCurrency(
  reading: ModelReading,
  interpreter: AssembledReplyInterpreter,
  reply: string,
): ModelReading {
  if (reading.kind !== "answered" || interpreter.approves === undefined) return reading;
  const answer = reading.answer as { readonly approved?: unknown };
  if (answer.approved !== true) return reading;
  const mismatch = currencyMismatchOf(reply, interpreter.approves, reading.currency);
  if (mismatch === undefined) return reading;
  return {
    kind: "declined",
    reason: `the reply does not answer the question: ${mismatch}`,
    usage: reading.usage,
  };
}
