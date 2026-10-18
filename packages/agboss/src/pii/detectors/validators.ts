/**
 * Check digits and issuance rules of the formats the detectors find (#120 AC3): a string of the
 * right shape that fails its check is not that kind (a random 16-digit number is not a card).
 */

/** The digits of a value, separators dropped. */
export const digitsOf = (value: string): string => value.replace(/\D/g, "");

/** Luhn (cards): every second digit from the right doubled, the sum a multiple of 10. */
export function isLuhnValid(value: string): boolean {
  const digits = digitsOf(value);
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    const digit = Number(digits[digits.length - 1 - index]);
    const doubled = index % 2 === 1 ? digit * 2 : digit;
    sum += doubled > 9 ? doubled - 9 : doubled;
  }
  return sum % 10 === 0;
}

/** IBAN: the country and check digits moved to the end, letters as numbers, mod 97 = 1. */
export function isIbanValid(value: string): boolean {
  const compact = value.replace(/\s/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)) return false;
  const moved = `${compact.slice(4)}${compact.slice(0, 4)}`;
  let remainder = 0;
  for (const char of moved) {
    const code = char.charCodeAt(0);
    const part = code >= 65 ? String(code - 55) : char;
    for (const digit of part) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

/** Israeli ID (Teudat Zehut): nine digits, weights 1, 2, 1, 2, …, digit sums, a multiple of 10. */
export function isIsraeliIdValid(value: string): boolean {
  const digits = digitsOf(value);
  if (digits.length !== 9 || /^0+$/.test(digits)) return false;
  let sum = 0;
  for (let index = 0; index < 9; index += 1) {
    const product = Number(digits[index]) * ((index % 2) + 1);
    sum += product > 9 ? product - 9 : product;
  }
  return sum % 10 === 0;
}

/** US SSN issuance rules: area not 000, 666 or 9xx; group not 00; serial not 0000. */
export function isUsSsnValid(value: string): boolean {
  const digits = digitsOf(value);
  if (digits.length !== 9) return false;
  const area = Number(digits.slice(0, 3));
  const group = digits.slice(3, 5);
  const serial = digits.slice(5);
  return area !== 0 && area !== 666 && area < 900 && group !== "00" && serial !== "0000";
}

/** US ITIN: 9xx, the group 50–65, 70–88, 90–92 or 94–99. */
export function isUsItinValid(value: string): boolean {
  const digits = digitsOf(value);
  if (digits.length !== 9 || !digits.startsWith("9")) return false;
  const group = Number(digits.slice(3, 5));
  return (
    (group >= 50 && group <= 65) ||
    (group >= 70 && group <= 88) ||
    (group >= 90 && group <= 92) ||
    group >= 94
  );
}

const NINO_INVALID_PREFIXES = new Set(["BG", "GB", "KN", "NK", "NT", "TN", "ZZ"]);

/** UK National Insurance number: prefix rules (no D, F, I, Q, U, V; second letter not O). */
export function isUkNinoValid(value: string): boolean {
  const compact = value.replace(/\s/g, "").toUpperCase();
  const match = /^([A-CEGHJ-PR-TW-Z])([A-CEGHJ-NPR-TW-Z])\d{6}[A-D]$/.exec(compact);
  if (match === null) return false;
  return !NINO_INVALID_PREFIXES.has(`${match[1] ?? ""}${match[2] ?? ""}`);
}

/** The IRS campus prefixes of an EIN (07, 08, 09, 17, 18, 19, 28, 29, 49, 69, 70, 78, 79, 89 unused). */
const EIN_UNUSED_PREFIXES = new Set(["00", "07", "08", "09", "17", "18", "19", "28", "29", "49"]);
const EIN_UNUSED_HIGH = new Set(["69", "70", "78", "79", "89", "96", "97"]);

/** US EIN: NN-NNNNNNN with an issued prefix. */
export function isUsEinValid(value: string): boolean {
  const digits = digitsOf(value);
  if (digits.length !== 9) return false;
  const prefix = digits.slice(0, 2);
  return !EIN_UNUSED_PREFIXES.has(prefix) && !EIN_UNUSED_HIGH.has(prefix);
}

/** IPv4: four octets 0–255. */
export const isIpv4Valid = (value: string): boolean =>
  value.split(".").every((octet) => octet.length <= 3 && Number(octet) <= 255);

/** Coordinates: latitude within ±90, longitude within ±180. */
export function isGeoValid(value: string): boolean {
  const [latitude, longitude] = value.split(/\s*,\s*/).map(Number);
  return (
    latitude !== undefined &&
    longitude !== undefined &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180
  );
}

const COUNTRIES = new Set(
  (
    "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR " +
    "BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ " +
    "EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW " +
    "GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY " +
    "KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV " +
    "MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY " +
    "QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG " +
    "TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW"
  ).split(" "),
);

/** SWIFT / BIC: 4 letters (bank), an ISO country, 2 location characters, an optional branch. */
export const isSwiftBicValid = (value: string): boolean => COUNTRIES.has(value.slice(4, 6));
