/** ISO 4217 currency codes in use (2026), including funds and precious metals codes. */
const CURRENCIES = `
AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BOV BRL BSD BTN BWP BYN
BZD CAD CDF CHE CHF CHW CLF CLP CNY COP COU CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP
GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF
KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MXV MYR
MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK
SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD USN UYI UYU
UYW UZS VED VES VND VUV WST XAF XAG XAU XBA XBB XBC XBD XCD XCG XDR XOF XPD XPF XPT XSU XTS XUA XXX
YER ZAR ZMW ZWG`;

/** ISO 3166-1 alpha-2 country codes (officially assigned). */
const COUNTRIES = `
AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV
BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES
ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE
IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY
MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU
NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM
SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE
VG VI VN VU WF WS YE YT ZA ZM ZW`;

const setOf = (codes: string): ReadonlySet<string> => new Set(codes.trim().split(/\s+/));

export const CURRENCY_CODES = setOf(CURRENCIES);
export const COUNTRY_CODES = setOf(COUNTRIES);

/** IANA time zones known to the runtime, plus `UTC` (which `Intl` lists only as `Etc/UTC` or not at all). */
export const TIME_ZONES: ReadonlySet<string> = new Set([
  ...Intl.supportedValuesOf("timeZone"),
  "UTC",
]);

const unitsOf = (digits: number, codes: string): [string, number][] =>
  codes
    .split(/\s+/)
    .filter(Boolean)
    .map((code) => [code, digits]);

/**
 * ISO 4217 minor units: how many digits follow the point in each currency's amounts. Every
 * currency of `CURRENCY_CODES` not named here has 2; funds and metals have none (`undefined`).
 */
const MINOR_UNITS: ReadonlyMap<string, number> = new Map([
  ...unitsOf(0, "BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX UYI VND VUV XAF XOF XPF"),
  ...unitsOf(3, "BHD IQD JOD KWD LYD OMR TND"),
  ...unitsOf(4, "CLF UYW"),
]);

/** Currencies that are no money: precious metals, SDR, test and fund codes have no minor unit. */
const NO_MINOR_UNIT: ReadonlySet<string> = new Set(
  "XAG XAU XBA XBB XBC XBD XDR XPD XPT XSU XTS XUA XXX".split(" "),
);

/** The digits after the point in a currency's amounts (ISO 4217); none for a code that is no money. */
export const minorUnitsOf = (currency: string): number | undefined =>
  NO_MINOR_UNIT.has(currency) ? undefined : (MINOR_UNITS.get(currency) ?? 2);
