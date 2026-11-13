import { recordField } from "./metadata.js";
import type {
  DecimalStringLimits,
  DtoClass,
  ElementSpec,
  FieldDecorator,
  FieldFactory,
  FieldKind,
  FieldOptions,
  FieldSettings,
  ListLimits,
  NumberLimits,
  OneOfValues,
  OptionalField,
  RequiredField,
  ScalarKind,
  TextLimits,
} from "./types.js";

/** The decorator that records one field; `(initial) => initial` leaves the value alone. */
function field<T>(
  kind: FieldKind,
  settings: FieldSettings,
  element?: ElementSpec,
): FieldDecorator<T> {
  return (_value, context) => {
    recordField(context.metadata, {
      name: String(context.name),
      kind,
      optional: "optional" in settings && settings.optional === true,
      settings,
      ...(element === undefined ? {} : { element }),
      isPrivate: context.private,
    });
    return (initial) => initial;
  };
}

/** Factories of plain values, so `@ListOf(Text)` knows what its elements are. */
const scalarFactories = new WeakMap<object, ScalarKind>();

function scalar<T, TLimits extends object = object>(kind: ScalarKind): FieldFactory<T, TLimits> {
  const factory = (options: FieldSettings = {}): FieldDecorator<T> => field<T>(kind, options);
  scalarFactories.set(factory, kind);
  // one implementation behind both call signatures: `optional` only changes the field's type
  return factory as FieldFactory<T, TLimits>;
}

/** Text; own formats with `pattern` (say the format in `prompt` too). */
export const Text = scalar<string, TextLimits>("text");
/** A whole number. */
export const Integer = scalar<number, NumberLimits>("integer");
/** A finite number. */
export const Decimal = scalar<number, NumberLimits>("decimal");
/** true / false. */
export const Flag = scalar<boolean>("flag");
export const Email = scalar<string>("email");
export const Url = scalar<string>("url");
export const Uuid = scalar<string>("uuid");
/** An ISO 8601 calendar date: `2026-10-01`. */
const DateField = scalar<string>("date");
export { DateField as Date };
/** An ISO 8601 date-time with an offset or `Z`: `2026-10-01T09:00:00+03:00`. */
export const DateTime = scalar<string>("date-time");
/** An ISO 8601 duration: `PT30M`. */
export const Duration = scalar<string>("duration");
/** A decimal number as a string, exact: `"19.99"`; at most `scale` digits after the point. */
export const DecimalString = scalar<string, DecimalStringLimits>("decimal-string");
/** An ISO 4217 currency code: `"USD"`. */
export const CurrencyCode = scalar<string>("currency-code");
/** An ISO 3166-1 alpha-2 country code: `"IL"`. */
export const CountryCode = scalar<string>("country-code");
/** A phone number in E.164: `"+972521234567"`. */
export const PhoneNumber = scalar<string>("phone-number");
/** A media (MIME) type `type/subtype`: `"application/pdf"`. */
export const MediaType = scalar<string>("media-type");
/** An IANA time zone: `"Asia/Jerusalem"`. */
export const TimeZone = scalar<string>("time-zone");

export type OneOfOptions<V extends readonly string[]> = OneOfValues<V> & FieldOptions<V[number]>;

/** One of `values`; the field's type must be exactly their union. */
export function OneOf<const V extends readonly [string, ...string[]]>(
  options: OneOfOptions<V> & OptionalField,
): FieldDecorator<V[number] | undefined>;
export function OneOf<const V extends readonly [string, ...string[]]>(
  options: OneOfOptions<V> & RequiredField<V[number]>,
): FieldDecorator<V[number]>;
export function OneOf(options: FieldSettings): FieldDecorator<unknown> {
  return field("one-of", options);
}

/** What a list holds: a DTO class or a plain-value decorator (`Text`, `Integer`, …). */
export type ListItem<T> = DtoClass<T> | ((options: never) => FieldDecorator<T>);

/** A list item is a plain-value factory (registered by `scalar`) or else a DTO class. */
const elementOf = (item: object): ElementSpec => {
  const kind = scalarFactories.get(item);
  // the overloads admit only factories and DTO classes, so anything unregistered is a DTO class
  return kind === undefined
    ? { kind: "dto", dto: item as DtoClass }
    : { kind: "scalar", scalar: kind };
};

export type ListOptions<T> = ListLimits & FieldOptions<T[]>;

/** `@ListOf`: `optional: true` ↔ `name?: T[]`; the last signature is the required one. */
export interface ListOfFactory {
  <T>(item: ListItem<T>, options: ListOptions<T> & OptionalField): FieldDecorator<T[] | undefined>;
  <T>(item: ListItem<T>, options?: ListOptions<T> & RequiredField<T[]>): FieldDecorator<T[]>;
}

const listOf = (item: object, options: FieldSettings = {}): FieldDecorator<unknown> =>
  field("list-of", options, elementOf(item));

/** A list of DTOs (`@ListOf(Job)`) or of plain values (`@ListOf(Text)`). */
// one implementation behind both call signatures: `optional` only changes the field's type
export const ListOf = listOf as ListOfFactory;

/** A DTO inside a DTO. */
export function Nested<T extends object>(
  dto: DtoClass<T>,
  options: FieldOptions<T> & OptionalField,
): FieldDecorator<T | undefined>;
export function Nested<T extends object>(
  dto: DtoClass<T>,
  options?: FieldOptions<T> & RequiredField<T>,
): FieldDecorator<T>;
export function Nested(dto: DtoClass, options: FieldSettings = {}): FieldDecorator<unknown> {
  return field("nested", options, { kind: "dto", dto });
}
