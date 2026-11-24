import { z } from "zod";
import { KEY_TEXT_RULE_TEXT, keyTextRuleOf } from "../core/errors.js";
import { COUNTRY_CODES, CURRENCY_CODES, TIME_ZONES } from "./codes.js";
import type { FieldSettings, ScalarKind } from "./types.js";

/** A date-time with no offset: `2026-10-01T09:00` or `2026-10-01T09:00:00.5`. */
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;
const PHONE_E164 = /^\+[1-9]\d{1,14}$/;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

const dateTime = (): z.ZodType<string> =>
  z.iso.datetime({
    offset: true,
    error: (issue) =>
      typeof issue.input === "string" && LOCAL_DATE_TIME.test(issue.input)
        ? "dto.date-time-without-offset: a date-time needs an offset or Z, e.g. 2026-10-01T09:00:00+03:00"
        : "not an ISO 8601 date-time, e.g. 2026-10-01T09:00:00+03:00",
  });

const decimalString = (scale: number | undefined): z.ZodType<string> => {
  const fraction = scale === undefined ? "\\d+" : `\\d{1,${String(scale)}}`;
  return z
    .string()
    .regex(
      new RegExp(`^-?\\d+(\\.${fraction})?$`),
      scale === undefined
        ? "not a decimal number, e.g. 19.99"
        : `not a decimal number with at most ${String(scale)} digits after the point`,
    );
};

const listed = (codes: ReadonlySet<string>, pattern: RegExp, what: string): z.ZodType<string> =>
  z
    .string()
    .regex(pattern, { message: `not ${what}`, abort: true })
    .refine((code) => codes.has(code), `not ${what}`);

const text = (settings: FieldSettings): z.ZodType<string> => {
  let schema = z.string();
  if (settings.minLength !== undefined) schema = schema.min(settings.minLength);
  if (settings.maxLength !== undefined) schema = schema.max(settings.maxLength);
  if (settings.pattern !== undefined) schema = schema.regex(settings.pattern);
  return schema;
};

/** The safe identifier syntax of a `@KeyText` (#1292): ASCII letters, digits and `. _ : -`; no space, `/`, `?`, `%`, `#` or look-alike letter. */
const KEY_TEXT_SYNTAX = /^[a-zA-Z0-9._:-]+$/;

/** A key's text (#538, #1292): the framework's rules AND the ASCII identifier syntax, so a valid value is always usable as a key, a URL segment or a log key; the rule is named, never the text. */
const keyText = (settings: FieldSettings): z.ZodType<string> =>
  text(settings).superRefine((value, ctx) => {
    const rule = keyTextRuleOf(value);
    if (rule !== undefined) {
      ctx.addIssue({ code: "custom", message: KEY_TEXT_RULE_TEXT[rule] });
      return;
    }
    if (!KEY_TEXT_SYNTAX.test(value))
      ctx.addIssue({
        code: "custom",
        message: "it must use only the characters a-z, A-Z, 0-9, '.', '_', ':' and '-'",
      });
  });

const number = (settings: FieldSettings, isInteger: boolean): z.ZodType<number> => {
  let schema = isInteger ? z.number().int() : z.number();
  if (settings.min !== undefined) schema = schema.min(settings.min);
  if (settings.max !== undefined) schema = schema.max(settings.max);
  return schema;
};

/** The runtime check of a plain-value field: type, format and limits. */
export const scalarSchemas: Readonly<Record<ScalarKind, (settings: FieldSettings) => z.ZodType>> = {
  text,
  integer: (settings) => number(settings, true),
  decimal: (settings) => number(settings, false),
  flag: () => z.boolean(),
  email: () => z.email(),
  url: () => z.url(),
  uuid: () => z.uuid(),
  date: () => z.iso.date(),
  "date-time": dateTime,
  duration: () => z.iso.duration(),
  "decimal-string": (settings) => decimalString(settings.scale),
  "currency-code": () =>
    listed(CURRENCY_CODES, /^[A-Z]{3}$/, "an ISO 4217 currency code, e.g. USD"),
  "country-code": () =>
    listed(COUNTRY_CODES, /^[A-Z]{2}$/, "an ISO 3166-1 alpha-2 country code, e.g. IL"),
  "phone-number": () =>
    z.string().regex(PHONE_E164, "not a phone number in E.164, e.g. +972521234567"),
  "media-type": () => z.string().regex(MEDIA_TYPE, "not a media type, e.g. application/pdf"),
  "key-text": keyText,
  "time-zone": () =>
    z.string().refine((zone) => TIME_ZONES.has(zone), "not an IANA time zone, e.g. Asia/Jerusalem"),
};
