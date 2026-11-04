/**
 * The currency signals of a text (#688, security review): what in it names a currency, read so the
 * guard fails closed by construction. The text is cut into tokens — letters (`\p{L}+`), digits
 * (`\p{N}+`) and every currency symbol (`\p{Sc}`) apart, so `500cad` is `500` and `cad` — and a
 * signal is any currency symbol, any `<letters>$`, any ISO 4217 code in any case, and any currency
 * word of the list below (several languages, country adjectives of other dollars and pesos too).
 * Where a signal stands, how it is spelled and whether an amount is near it does not matter. A
 * signal that is not one currency for sure is `AMBIGUOUS_CURRENCY`: never the call's.
 */

/** A signal that names no one currency for sure (`¥`, "pesos", "pounds", `Z$`): never the call's. */
export const AMBIGUOUS_CURRENCY = "an ambiguous currency";

/** The codes of ISO 4217's current currencies. */
export const ISO_4217_CODES: readonly string[] =
  `AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD
CAD CDF CHF CLP CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF
GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP
LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB
PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL
THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VES VND VUV WST XAF XCD XOF XPF YER ZAR ZMW ZWL`.split(
    /\s+/u,
  );

const ISO_4217: ReadonlySet<string> = new Set(ISO_4217_CODES);

/** The currency symbols with one currency; any other `\p{Sc}` is ambiguous (`¥`, `¢`, …). */
const SYMBOLS: Readonly<Record<string, string>> = {
  $: "USD",
  "€": "EUR",
  "£": "GBP",
  "₪": "ILS",
  "₹": "INR",
  "₽": "RUB",
  "₩": "KRW",
  "฿": "THB",
  "₴": "UAH",
  "₦": "NGN",
  "₺": "TRY",
  "₫": "VND",
  "₱": "PHP",
  "₸": "KZT",
  "₼": "AZN",
  "₾": "GEL",
};

/** `<letters>$`: `US$` is the US dollar, a few prefixes name their dollar or real, any other is ambiguous. */
const DOLLAR_PREFIXES: Readonly<Record<string, string>> = {
  US: "USD",
  C: "CAD",
  CA: "CAD",
  A: "AUD",
  AU: "AUD",
  NZ: "NZD",
  HK: "HKD",
  S: "SGD",
  MX: "MXN",
  NT: "TWD",
  R: "BRL",
};

/** Currency words, a token each (lower case): the currency, or ambiguous. */
const WORDS: readonly (readonly [RegExp, string])[] = [
  [/^(?:dollar\p{L}*|d[oó]lar\p{L}*|доллар\p{L}*|דולר\p{L}*)$/u, "USD"],
  [/^(?:euros?|евро|יורו)$/u, "EUR"],
  [/^(?:sterling|quid)$/u, "GBP"],
  [/^(?:yen|иен\p{L}*|йен\p{L}*)$/u, "JPY"],
  [/^(?:yuan|renminbi|rmb|юан\p{L}*)$/u, "CNY"],
  [/^(?:rubles?|roubles?|рубл\p{L}*)$/u, "RUB"],
  [/^(?:shekels?|nis|шекел\p{L}*|שקל\p{L}*)$/u, "ILS"],
  [/^(?:z[lł]oty|z[lł]|злот\p{L}*)$/u, "PLN"],
  [/^(?:forints?)$/u, "HUF"],
  [/^(?:korun[ay]?)$/u, "CZK"],
  [/^(?:won)$/u, "KRW"],
  [/^(?:baht)$/u, "THB"],
  [/^(?:rand)$/u, "ZAR"],
  [/^(?:ringgit)$/u, "MYR"],
  [/^(?:dong)$/u, "VND"],
  [/^(?:rupiah)$/u, "IDR"],
  [/^(?:hryvnias?|гривн\p{L}*)$/u, "UAH"],
  [/^(?:lev|leva)$/u, "BGN"],
  [/^(?:leu|lei)$/u, "RON"],
  [/^(?:naira)$/u, "NGN"],
  [/^(?:cedis?)$/u, "GHS"],
  [/^(?:taka)$/u, "BDT"],
  [/^(?:tenge)$/u, "KZT"],
  [/^(?:lari)$/u, "GEL"],
  [/^(?:kip)$/u, "LAK"],
  [/^(?:riel)$/u, "KHR"],
  [/^(?:kyat)$/u, "MMK"],
  [/^(?:birr)$/u, "ETB"],
  [/^(?:lek)$/u, "ALL"],
  // another country's dollars and pesos: the adjective is the signal
  [/^(?:canadian|canadienses?|канадск\p{L}*)$/u, "CAD"],
  [/^(?:australian|australianos?|австралийск\p{L}*)$/u, "AUD"],
  [/^(?:zealand|новозеландск\p{L}*)$/u, "NZD"],
  [/^(?:hong|kong|гонконгск\p{L}*)$/u, "HKD"],
  [/^(?:singapore|сингапурск\p{L}*)$/u, "SGD"],
  [/^(?:mexican|mexicanos?)$/u, "MXN"],
  [/^(?:taiwan|taiwanese)$/u, "TWD"],
  [
    /^(?:pounds?|фунт\p{L}*|bucks?|pesos?|песо|reais|kron(?:a|or|e|er|ur)|crowns?|крон\p{L}*|dinars?|динар\p{L}*|dirhams?|riyals?|rials?|lir[ae]|liras|лир[аы]?|francs?|франк\p{L}*|rupees?|рупи\p{L}*|cents?|centavos?|c[eé]ntimos?|копе\p{L}*|agorot|אגורות|shillings?|kwacha|manat|som|soles|quetzal(?:es)?|col[oó]n(?:es)?|lempiras?|guaran[ií]es?)$/u,
    AMBIGUOUS_CURRENCY,
  ],
];

/** The Hebrew abbreviation of the shekel, two letters around a gershayim: no token of its own. */
const SHEKEL_ABBREVIATION = /ש["״]ח/u;

/** One token: letters, digits or a currency symbol, where it starts and ends. */
interface Token {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

const tokensOf = (text: string): readonly Token[] =>
  [...text.matchAll(/\p{L}+|\p{N}+|\p{Sc}/gu)].map((match) => ({
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));

/** How a text is read: a reply's codes count in any case, a field description's only in capitals. */
export interface SignalReading {
  readonly codesInCapitalsOnly?: boolean;
}

/** A word's currency: an ISO code in any case, else a listed word; `undefined` when it names none. */
function wordCurrencyOf(word: string, reading: SignalReading): string | undefined {
  const upper = word.toUpperCase();
  const isCode = upper.length === 3 && ISO_4217.has(upper);
  if (isCode && (reading.codesInCapitalsOnly !== true || word === upper)) return upper;
  const lower = word.toLowerCase();
  return WORDS.find(([pattern]) => pattern.test(lower))?.[1];
}

/** A symbol's currency; a `$` right after letters is that place's dollar. */
function symbolCurrencyOf(symbol: Token, before: Token | undefined): string {
  if (symbol.text !== "$") return SYMBOLS[symbol.text] ?? AMBIGUOUS_CURRENCY;
  if (before?.end !== symbol.start || !/^\p{L}+$/u.test(before.text)) return "USD";
  return DOLLAR_PREFIXES[before.text.toUpperCase()] ?? AMBIGUOUS_CURRENCY;
}

/** Every currency signal of `text`, in order: a code each, or `AMBIGUOUS_CURRENCY`. */
export function currencySignalsOf(text: string, reading: SignalReading = {}): readonly string[] {
  const tokens = tokensOf(text);
  const signals: string[] = [];
  for (const [index, token] of tokens.entries()) {
    if (/^\p{Sc}$/u.test(token.text)) signals.push(symbolCurrencyOf(token, tokens[index - 1]));
    else if (/^\p{L}/u.test(token.text)) {
      const currency = wordCurrencyOf(token.text, reading);
      if (currency !== undefined) signals.push(currency);
    }
  }
  if (SHEKEL_ABBREVIATION.test(text)) signals.push("ILS");
  return signals;
}
