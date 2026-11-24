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
  NumberLimits,
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

/** Factories of plain values, so `@List(Text)` knows what its elements are. */
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
/** A finite floating-point number (IEEE 754); `DecimalString` is the exact one. */
export const Float = scalar<number, NumberLimits>("decimal");
/** true / false. */
export const Bool = scalar<boolean>("flag");
export const Email = scalar<string>("email");
export const Url = scalar<string>("url");
export const Uuid = scalar<string>("uuid");
/** An ISO 8601 calendar date as text: `2026-10-01`. */
export const IsoDate = scalar<string>("date");
/** An ISO 8601 date-time with an offset or `Z`, as text: `2026-10-01T09:00:00+03:00`. */
export const IsoDateTime = scalar<string>("date-time");
/** An ISO 8601 duration as text: `PT30M`. */
export const IsoDuration = scalar<string>("duration");
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

/** `@Enum`'s options: the field's own (`optional`, `default`, `prompt`, …). */
export type EnumOptions<T extends string> = FieldOptions<T>;

/** The values of `@Enum`: a non-empty list of strings, or a string `enum` object. */
type EnumValues = readonly [string, ...string[]] | Readonly<Record<string, string>>;

const valuesOf = (source: EnumValues): readonly string[] =>
  Array.isArray(source) ? (source as readonly string[]) : Object.values(source);

/**
 * `@Enum(["a", "b"])` or `@Enum(Status)` (a string `enum`): one of the values; the field's type must
 * be exactly their union. `optional: true` ↔ `name?: T`.
 */
export interface EnumFactory {
  <const V extends readonly [string, ...string[]]>(
    values: V,
    options: EnumOptions<V[number]> & OptionalField,
  ): FieldDecorator<V[number] | undefined>;
  <const V extends readonly [string, ...string[]]>(
    values: V,
    options?: EnumOptions<V[number]> & RequiredField<V[number]>,
  ): FieldDecorator<V[number]>;
  <const E extends Readonly<Record<string, string>>>(
    values: E,
    options: EnumOptions<E[keyof E]> & OptionalField,
  ): FieldDecorator<E[keyof E] | undefined>;
  <const E extends Readonly<Record<string, string>>>(
    values: E,
    options?: EnumOptions<E[keyof E]> & RequiredField<E[keyof E]>,
  ): FieldDecorator<E[keyof E]>;
}

const enumField = (values: EnumValues, options: FieldSettings = {}): FieldDecorator<unknown> =>
  field("one-of", { ...options, values: valuesOf(values) });

// one implementation behind all call signatures: `optional` only changes the field's type
export const Enum = enumField as EnumFactory;

/** What a list holds: a DTO class, a plain-value decorator (`Text`, `Integer`, …), or an `@Enum`'s values. */
export type ListItem<T> = DtoClass<T> | ((options: never) => FieldDecorator<T>);

/** An array of strings, or an object that is no class and no factory: the values of an `@Enum`. */
const isEnumValues = (item: object): item is EnumValues => typeof item !== "function";

/** A list item is a plain-value factory (registered by `scalar`) or else a DTO class. */
const elementOf = (item: object): ElementSpec => {
  if (isEnumValues(item)) return { kind: "enum", values: valuesOf(item) };
  const kind = scalarFactories.get(item);
  // the overloads admit only factories and DTO classes, so anything unregistered is a DTO class
  return kind === undefined
    ? { kind: "dto", dto: item as DtoClass }
    : { kind: "scalar", scalar: kind };
};

export type ListOptions<T> = FieldOptions<T[]> & {
  readonly minItems?: number;
  readonly maxItems?: number;
};

/** A list field's type: it compiles with a mutable `T[]` and with a `readonly T[]`. */
export type ListField<T> = FieldDecorator<T[]> & FieldDecorator<readonly T[]>;
export type OptionalListField<T> = FieldDecorator<T[] | undefined> &
  FieldDecorator<readonly T[] | undefined>;

/** `@List`: `optional: true` ↔ `name?: T[]`; the last signature is the required one. */
export interface ListFactory {
  <T>(item: ListItem<T>, options: ListOptions<T> & OptionalField): OptionalListField<T>;
  <T>(item: ListItem<T>, options?: ListOptions<T> & RequiredField<T[]>): ListField<T>;
  <const V extends readonly [string, ...string[]]>(
    values: V,
    options: ListOptions<V[number]> & OptionalField,
  ): OptionalListField<V[number]>;
  <const V extends readonly [string, ...string[]]>(
    values: V,
    options?: ListOptions<V[number]> & RequiredField<V[number][]>,
  ): ListField<V[number]>;
  <const E extends Readonly<Record<string, string>>>(
    values: E,
    options: ListOptions<E[keyof E]> & OptionalField,
  ): OptionalListField<E[keyof E]>;
  <const E extends Readonly<Record<string, string>>>(
    values: E,
    options?: ListOptions<E[keyof E]> & RequiredField<E[keyof E][]>,
  ): ListField<E[keyof E]>;
}

const list = (item: object, options: FieldSettings = {}): FieldDecorator<unknown> =>
  field("list-of", options, elementOf(item));

/** A list of DTOs (`@List(Job)`), of plain values (`@List(Text)`) or of an enum's values (`@List(Status)`). */
// one implementation behind all call signatures: `optional` only changes the field's type
export const List = list as ListFactory;

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
