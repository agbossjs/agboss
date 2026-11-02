import { jsonSchemaOf } from "../dto/schema.js";
import type { DtoClass } from "../dto/types.js";
import type { AssembledReplyInterpreter } from "./discovery.js";
import type { ModelReading } from "./reply-reader.js";

/**
 * A reply's currency against the call's (#688): an approval that changes the call while the reply
 * names a currency the approved call's fields do not — "yes, up to €900" on a call in US dollars —
 * would need converting, a guess no model may make on the approver's behalf. The framework sees it
 * in the texts themselves, whatever the model answered, and reads the reply as not understood.
 */

/** A currency and the ways a reply or a field's name and description name it. */
interface Currency {
  readonly code: string;
  readonly names: RegExp;
}

const CURRENCIES: readonly Currency[] = [
  { code: "USD", names: /\$|\busd\b|dollar|dólar|долл|דולר/iu },
  { code: "EUR", names: /€|\beur\b|\beuros?\b|евро|יורו/iu },
  { code: "ILS", names: /₪|\bils\b|\bnis\b|shekel|шекел|שקל|ש"ח/iu },
  { code: "GBP", names: /£|\bgbp\b|\bpounds? sterling\b|\bquid\b|фунт/iu },
  { code: "JPY", names: /¥|\bjpy\b|\byen\b|иен/iu },
  { code: "RUB", names: /₽|\brub\b|\brubles?\b|\broubles?\b|рубл/iu },
  { code: "INR", names: /₹|\binr\b|\brupees?\b|рупи/iu },
  { code: "CHF", names: /\bchf\b|\bswiss francs?\b|франк/iu },
];

/** A field named for its currency, `amountUsd` or `amount_usd`: the code as its last word. */
const CODE_SUFFIX =
  /(?:[a-z0-9](Usd|Eur|Ils|Gbp|Jpy|Rub|Inr|Chf)|_(usd|eur|ils|gbp|jpy|rub|inr|chf))$/u;

/** The currencies a text names. */
const currenciesIn = (text: string): ReadonlySet<string> =>
  new Set(CURRENCIES.filter((currency) => currency.names.test(text)).map((c) => c.code));

/** What an approved call's fields say of themselves: their names and descriptions. */
function fieldTextsOf(approves: DtoClass): string {
  const schema = jsonSchemaOf(approves) as {
    readonly properties?: Readonly<Record<string, { readonly description?: string }>>;
  };
  return Object.entries(schema.properties ?? {})
    .map(([name, field]) => {
      const [, camel, snake] = CODE_SUFFIX.exec(name) ?? [];
      const code = (camel ?? snake ?? "").toUpperCase();
      return `${code === "" ? "" : `${code} `}${field.description ?? ""}`;
    })
    .join("\n");
}

/**
 * Why a change of the call cannot be read: the reply names a currency the call's fields do not
 * (when they name one); `undefined` when nothing needs converting.
 */
export function currencyMismatchOf(reply: string, approves: DtoClass): string | undefined {
  const inReply = currenciesIn(reply);
  if (inReply.size === 0) return undefined;
  const ofCall = currenciesIn(fieldTextsOf(approves));
  if (ofCall.size === 0) return undefined;
  const foreign = [...inReply].filter((code) => !ofCall.has(code));
  if (foreign.length === 0) return undefined;
  return `the reply's limit is in ${foreign.join(", ")} and the call's in ${[...ofCall].join(", ")}: converting it would be a guess`;
}

/**
 * A change of the call in a currency the call is not in is no answer (#688): converting it would be
 * a guess, whatever the model made of it.
 */
export function withinCurrency(
  reading: ModelReading,
  interpreter: AssembledReplyInterpreter,
  reply: string,
): ModelReading {
  if (reading.kind !== "answered" || interpreter.approves === undefined) return reading;
  const answer = reading.answer as {
    readonly approved?: unknown;
    readonly overrideArguments?: unknown;
  };
  if (answer.approved !== true || answer.overrideArguments === undefined) return reading;
  const mismatch = currencyMismatchOf(reply, interpreter.approves);
  if (mismatch === undefined) return reading;
  return {
    kind: "declined",
    reason: `the reply does not answer the question: ${mismatch}`,
    usage: reading.usage,
  };
}
