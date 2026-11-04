import { jsonSchemaOf } from "../dto/schema.js";
import type { DtoClass } from "../dto/types.js";
import type { AssembledReplyInterpreter } from "./discovery.js";
import type { ModelReading } from "./reply-reader.js";

/**
 * A reply's currency against the call's (#688): an approval while the reply names a currency the
 * approved call's fields do not — "yes, up to €900" on a call in US dollars —
 * would need converting, a guess no model may make on the approver's behalf. The framework sees it
 * in the texts themselves, whatever the model answered, and reads the reply as not understood.
 */

/** A currency and the ways a reply or a field's name and description name it. */
interface Currency {
  readonly code: string;
  readonly names: RegExp;
}

/**
 * Another country's dollars, read before US dollars (#688, security review): `C$900` or "900
 * Canadian dollars" is not `$900`. Each match is taken out of the text before the US dollar's signs
 * and words are looked for.
 */
const OTHER_DOLLARS: readonly Currency[] = [
  {
    code: "CAD",
    names: /\bCA?\$|\bcanadian dollars?\b|канадск\p{L}* доллар|d[oó]lar(?:es)? canadienses?/giu,
  },
  {
    code: "AUD",
    names:
      /\bAU?\$|\baustralian dollars?\b|австралийск\p{L}* доллар|d[oó]lar(?:es)? australianos?/giu,
  },
  { code: "NZD", names: /\bNZ\$|\bnew zealand dollars?\b|новозеландск\p{L}* доллар/giu },
  { code: "HKD", names: /\bHK\$|\bhong kong dollars?\b|гонконгск\p{L}* доллар/giu },
  { code: "SGD", names: /\bS\$|\bsingapore dollars?\b|сингапурск\p{L}* доллар/giu },
  { code: "MXN", names: /\bMX\$|\bmexican pesos?\b/giu },
  { code: "TWD", names: /\bNT\$|\btaiwan(?:ese)? dollars?\b/giu },
];

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

/** The codes of ISO 4217's current currencies: any of them in a reply, in capitals, names one. */
const ISO_4217: ReadonlySet<string> = new Set(
  `AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD
CAD CDF CHF CLP CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF
GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP
LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB
PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL
THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VES VND VUV WST XAF XCD XOF XPF YER ZAR ZMW ZWL`.split(
    /\s+/u,
  ),
);

/** A code in capitals, as a word of its own (`900 CAD`, `SEK 900`). */
const CODE_WORD = /\b[A-Z]{3}\b/gu;

/** A field named for its currency, `amountUsd` or `amount_usd`: the code as its last word. */
const CODE_SUFFIX = /(?:[a-z0-9]([A-Z][a-z]{2})|_([a-z]{3}))$/u;

/** The currencies a text names: other dollars first, their signs then taken out, codes in capitals. */
function currenciesIn(text: string): ReadonlySet<string> {
  const found = new Set<string>();
  let rest = text;
  for (const { code, names } of OTHER_DOLLARS)
    rest = rest.replace(names, () => {
      found.add(code);
      return " ";
    });
  for (const { code, names } of CURRENCIES) if (names.test(rest)) found.add(code);
  for (const [word] of text.matchAll(CODE_WORD)) if (ISO_4217.has(word)) found.add(word);
  return found;
}

/** What an approved call's fields say of themselves: their names and descriptions. */
function fieldTextsOf(approves: DtoClass): string {
  const schema = jsonSchemaOf(approves) as {
    readonly properties?: Readonly<Record<string, { readonly description?: string }>>;
  };
  return Object.entries(schema.properties ?? {})
    .map(([name, field]) => {
      const [, camel, snake] = CODE_SUFFIX.exec(name) ?? [];
      const suffix = (camel ?? snake ?? "").toUpperCase();
      const code = ISO_4217.has(suffix) ? `${suffix} ` : "";
      return `${code}${field.description ?? ""}`;
    })
    .join("\n");
}

/**
 * Why an approval cannot be read: the reply names a currency the call's fields do not (when they
 * name one); `undefined` when nothing needs converting.
 */
export function currencyMismatchOf(reply: string, approves: DtoClass): string | undefined {
  const inReply = currenciesIn(reply);
  if (inReply.size === 0) return undefined;
  const ofCall = currenciesIn(fieldTextsOf(approves));
  if (ofCall.size === 0) return undefined;
  const foreign = [...inReply].filter((code) => !ofCall.has(code));
  if (foreign.length === 0) return undefined;
  return `the reply names ${foreign.join(", ")} and the call is in ${[...ofCall].join(", ")}: converting it would be a guess`;
}

/**
 * An approval in a currency the call is not in is no answer (#688): converting it would be a guess,
 * whatever the model made of it — with a correction or without one ("yes, in CAD" on a call in US
 * dollars approves no call in US dollars). A refusal stays a refusal.
 */
export function withinCurrency(
  reading: ModelReading,
  interpreter: AssembledReplyInterpreter,
  reply: string,
): ModelReading {
  if (reading.kind !== "answered" || interpreter.approves === undefined) return reading;
  const answer = reading.answer as { readonly approved?: unknown };
  if (answer.approved !== true) return reading;
  const mismatch = currencyMismatchOf(reply, interpreter.approves);
  if (mismatch === undefined) return reading;
  return {
    kind: "declined",
    reason: `the reply does not answer the question: ${mismatch}`,
    usage: reading.usage,
  };
}
