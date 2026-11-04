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

/** The codes of ISO 4217's current currencies: any of them in a reply names one (`codesIn`). */
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

/** A code as a word of its own, in any case (`900 CAD`, `sek 900`, `Cad`). */
const CODE_WORD = /\b[A-Za-z]{3}\b/gu;

/**
 * Codes that are also everyday words ("all good", "try it", "the top one", "Ron agrees"): in
 * lower or mixed case they name their currency only beside an amount (`900 try`); in capitals always.
 */
const CODES_THAT_ARE_WORDS: ReadonlySet<string> = new Set([
  "ALL",
  "BAM",
  "BOB",
  "COP",
  "CUP",
  "GEL",
  "MAD",
  "MOP",
  "PEN",
  "RON",
  "SOS",
  "TOP",
  "TRY",
]);

/** Any `<letters>$` but `US$`: a dollar of somewhere else (`R$` the real, `Z$`, `XY$`). */
const PREFIXED_DOLLAR = /\b([A-Za-z]{1,3})\$/gu;

/** The currency of a known `<letters>$` prefix; any other is a currency of its own, unnamed. */
const DOLLAR_PREFIXES: Readonly<Record<string, string>> = { R: "BRL", NT: "TWD", Z: "ZWL" };

/** The signs and words this guard resolves to a currency, taken out before the unresolved are looked for. */
const RESOLVED_SIGNS = /[$€£¥₪₹₽]/u;

/**
 * Currency words the guard cannot pin to one currency (a peso, a franc, a crown, a pound, a dinar…,
 * or a currency it has no table for): beside an amount they make the reply not understood.
 */
const UNRESOLVED_WORD =
  /^(?:pesos?|francs?|kron(?:a|or|e|er|ur)|crowns?|dinars?|rand|won|baht|z[lł]oty|z[lł]|lir[ae]|liras|riyals?|rials?|dirhams?|rupiah|yuan|renminbi|rmb|forint|koruna|lei|leu|lev|leva|reais|real|ringgit|dong|shillings?|pounds?|bucks?|quetzal(?:es)?|col[oó]n(?:es)?|soles|sol|lempiras?|cedis?|naira|kwacha|taka|tenge|manat|lari|som|sum|kip|riel|kyat|birr|kuna|hryvnias?|гривн\p{L}*|юан\p{L}*|злот\p{L}*|крон\p{L}*|песо|динар\p{L}*|лир\p{L}*|реал\p{L}*)$/iu;

/** An amount right before or right after `at … at + length` in `text`. */
const besideAmount = (text: string, at: number, length: number): boolean =>
  /\d\s*$/u.test(text.slice(0, at)) || /^\s*\d/u.test(text.slice(at + length));

/** The other countries' dollars a text names, each match taken out of what is returned. */
function otherDollarsIn(text: string, found: Set<string>): string {
  let rest = text;
  for (const { code, names } of OTHER_DOLLARS)
    rest = rest.replace(names, () => {
      found.add(code);
      return " ";
    });
  return rest.replace(PREFIXED_DOLLAR, (match, prefix: string) => {
    const upper = prefix.toUpperCase();
    if (upper === "US") return match;
    found.add(DOLLAR_PREFIXES[upper] ?? `${upper}$`);
    return " ";
  });
}

/** The ISO 4217 codes a text names: in capitals, or in any case unless an everyday word far from an amount. */
function codesIn(text: string, found: Set<string>): void {
  for (const match of text.matchAll(CODE_WORD)) {
    const [word] = match;
    const code = word.toUpperCase();
    if (!ISO_4217.has(code)) continue;
    const isWord = word !== code && CODES_THAT_ARE_WORDS.has(code);
    if (!isWord || besideAmount(text, match.index, word.length)) found.add(code);
  }
}

/** An amount beside a currency sign or word the guard cannot resolve: `₩900`, `900 pesos`. */
function hasUnresolvedAmount(text: string): boolean {
  for (const match of text.matchAll(/\p{Sc}|\p{L}+/gu)) {
    const [token] = match;
    const isSign = /^\p{Sc}$/u.test(token);
    const unresolved = isSign ? !RESOLVED_SIGNS.test(token) : UNRESOLVED_WORD.test(token);
    if (unresolved && besideAmount(text, match.index, token.length)) return true;
  }
  return false;
}

/** The mark of an amount in a currency the guard cannot tell. */
const UNRESOLVED_CURRENCY = "an unresolved currency";

/** A field named for its currency, `amountUsd` or `amount_usd`: the code as its last word. */
const CODE_SUFFIX = /(?:[a-z0-9]([A-Z][a-z]{2})|_([a-z]{3}))$/u;

/** The currencies a text names: other dollars first (then taken out), signs and words, codes in any case. */
function currenciesIn(text: string): ReadonlySet<string> {
  const found = new Set<string>();
  const rest = otherDollarsIn(text, found);
  let unnamed = rest;
  for (const { code, names } of CURRENCIES)
    unnamed = unnamed.replace(new RegExp(names.source, `${names.flags}g`), () => {
      found.add(code);
      return " ";
    });
  codesIn(text, found);
  if (hasUnresolvedAmount(unnamed)) found.add(UNRESOLVED_CURRENCY);
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
  if (foreign.includes(UNRESOLVED_CURRENCY))
    return `the reply names an amount in a currency the framework cannot tell, and the call is in ${[...ofCall].join(", ")}: converting it would be a guess`;
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
