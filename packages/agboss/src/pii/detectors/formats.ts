import { PiiKind } from "../kinds.js";
import {
  isGeoValid,
  isIbanValid,
  isIpv4Valid,
  isIsraeliIdValid,
  isLuhnValid,
  isSwiftBicValid,
  isUkNinoValid,
  isUsEinValid,
  isUsItinValid,
  isUsSsnValid,
} from "./validators.js";

/**
 * The format detectors (#120 AC3): one pattern per kind with a format, the match checked by its
 * validator. A pattern with a `value` group marks only that part (`password: <value>`). Kinds
 * without a format (names, street addresses, …) are found only by a model (`detectWithModel`).
 */
export interface FormatDetector {
  readonly kind: PiiKind;
  /** Global, with indices (`gd`). */
  readonly pattern: RegExp;
  /** The match is that kind only when it passes (check digits, issuance rules). */
  readonly isValid?: (match: string) => boolean;
  /** Where the match ends once what is not of the kind is cut off (#729); the match's end when absent. */
  readonly endOf?: (text: string, start: number, end: number) => number;
}

const BOUNDED = (source: string): RegExp => new RegExp(`(?<![\\w-])(?:${source})(?![\\w-])`, "gd");

/**
 * Where an e-mail address found by its broad pattern ends (#729): a file named after an address
 * (`anna@acme.com.pdf`, `anna@acme.com.mp4`) loses its extension, nothing else. The cut is made only
 * when the last label — with the letters and digits glued to it — is a common file extension that is
 * no top-level domain, and what is left is still a whole address; otherwise the match stays as it
 * is, so an address is never left partly unmasked (fail-closed).
 */

/** File extensions that are no top-level domain; one that is (`.md`, `.zip`, `.mov`, `.py`) is not here. */
const FILE_EXTENSIONS: ReadonlySet<string> = new Set(
  (
    "pdf csv tsv txt json xml yaml yml html htm doc docx xls xlsx ppt pptx odt rtf png jpg jpeg " +
    "gif svg webp bmp tif tiff heic wav mp3 mp4 m4a eml msg vcf ics gz tar rar log bak tmp exe"
  ).split(" "),
);

/** An address that ends at its top-level domain. */
const WHOLE_ADDRESS = /@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/u;

/** Letters and digits glued right after a match: the rest of a label it split (`mp` + `4`). */
const GLUED = /^[A-Za-z0-9]*/u;

function emailEndOf(text: string, start: number, end: number): number {
  const found = text.slice(start, end);
  const lastDot = found.lastIndexOf(".");
  const glued = GLUED.exec(text.slice(end))?.[0] ?? "";
  const label = `${found.slice(lastDot + 1)}${glued}`.toLowerCase();
  const head = found.slice(0, lastDot);
  return FILE_EXTENSIONS.has(label) && WHOLE_ADDRESS.test(head) ? start + lastDot : end;
}

/** In order of specificity: of two matches of one span the first kind wins (a card before a phone). */
export const FORMAT_DETECTORS: readonly FormatDetector[] = [
  {
    kind: PiiKind.Email,
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/dg,
    endOf: emailEndOf,
  },
  { kind: PiiKind.UsSsn, pattern: BOUNDED("\\d{3}-\\d{2}-\\d{4}"), isValid: isUsSsnValid },
  { kind: PiiKind.UsItin, pattern: BOUNDED("9\\d{2}-\\d{2}-\\d{4}"), isValid: isUsItinValid },
  {
    kind: PiiKind.UkNino,
    pattern: BOUNDED("[A-Z]{2} ?\\d{2} ?\\d{2} ?\\d{2} ?[A-D]"),
    isValid: isUkNinoValid,
  },
  { kind: PiiKind.IsraeliId, pattern: BOUNDED("\\d{9}"), isValid: isIsraeliIdValid },
  {
    kind: PiiKind.CardNumber,
    pattern: BOUNDED("\\d{4}(?:[ -]?\\d{4}){2}[ -]?\\d{1,7}"),
    isValid: isLuhnValid,
  },
  {
    kind: PiiKind.Iban,
    pattern: BOUNDED("[A-Z]{2}\\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?"),
    isValid: isIbanValid,
  },
  {
    kind: PiiKind.SwiftBic,
    pattern: BOUNDED("[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?"),
    isValid: isSwiftBicValid,
  },
  { kind: PiiKind.UsEin, pattern: BOUNDED("\\d{2}-\\d{7}"), isValid: isUsEinValid },
  {
    kind: PiiKind.IpAddress,
    pattern: BOUNDED("(?:\\d{1,3}\\.){3}\\d{1,3}|(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}"),
    isValid: (match) => match.includes(":") || isIpv4Valid(match),
  },
  { kind: PiiKind.MacAddress, pattern: BOUNDED("(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}") },
  {
    kind: PiiKind.GeoCoordinates,
    pattern: BOUNDED("-?\\d{1,2}\\.\\d{4,},\\s*-?\\d{1,3}\\.\\d{4,}"),
    isValid: isGeoValid,
  },
  {
    kind: PiiKind.Phone,
    pattern:
      /(?<![\w+])(?:\+\d{1,3}[ .-]?)?(?:\(\d{1,4}\)[ .-]?)?\d{2,4}(?:[ .-]?\d{2,4}){2,3}(?!\w)/dg,
    isValid: (match) => match.replace(/\D/g, "").length >= 9,
  },
  {
    kind: PiiKind.PostalCode,
    pattern: BOUNDED("\\d{5}-\\d{4}|[A-Z]{1,2}\\d[A-Z\\d]? \\d[A-Z]{2}"),
  },
  {
    kind: PiiKind.ApiKey,
    pattern: BOUNDED(
      "sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}",
    ),
  },
  { kind: PiiKind.Jwt, pattern: BOUNDED("eyJ[A-Za-z0-9_-]+\\.eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+") },
  {
    kind: PiiKind.PrivateKey,
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/dg,
  },
  {
    kind: PiiKind.Password,
    pattern: /\b(?:password|passwd|pwd)\b\s*[:=]\s*(?<value>\S+)/dgi,
  },
];
