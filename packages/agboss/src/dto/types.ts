import type { MaskingPiiAction } from "../pii/actions.js";

/**
 * DTOs (#118): data shapes as classes, one field decorator per field. The decorator says what the model
 * reads (`prompt`) and what is checked at runtime; its type says what the compiler checks.
 */

/** A DTO class: plain data, constructed with no arguments. */
export type DtoClass<T = object> = abstract new () => T;

/** Field kinds of plain values — what `@ListOf(Text)` can hold besides DTOs. */
export type ScalarKind =
  | "text"
  | "integer"
  | "decimal"
  | "flag"
  | "email"
  | "url"
  | "uuid"
  | "date"
  | "date-time"
  | "duration"
  | "decimal-string"
  | "currency-code"
  | "country-code"
  | "phone-number"
  | "media-type"
  | "time-zone";

export type FieldKind = ScalarKind | "one-of" | "list-of" | "nested";

/**
 * A sensitive field's action (#120): `sensitive: PiiAction.replaceWithToken()` — a masking action
 * only (`replaceWithKind`, `replacePart`, `replaceWithToken`); `blockWithRefusal` does not compile.
 */
export type Sensitivity = MaskingPiiAction;

/** Options every field decorator takes. */
export interface FieldOptions<T> {
  /** What the model reads about the field (its JSON Schema `description`). */
  readonly prompt?: string;
  readonly sensitive?: Sensitivity;
  readonly example?: T;
}

/** A required field (`name!: T`), optionally with a default the model may leave out. */
export interface RequiredField<T> {
  readonly optional?: false;
  readonly default?: T;
}

/** An optional field (`name?: T`). */
export interface OptionalField {
  readonly optional: true;
  readonly default?: never;
}

export interface TextLimits {
  readonly minLength?: number;
  readonly maxLength?: number;
  /** An own format, e.g. `/^[A-Z]{2}-\d{4}$/`; say it in `prompt` too. */
  readonly pattern?: RegExp;
}

export interface NumberLimits {
  readonly min?: number;
  readonly max?: number;
}

export interface DecimalStringLimits {
  /** At most this many digits after the point. */
  readonly scale?: number;
}

export interface ListLimits {
  readonly minItems?: number;
  readonly maxItems?: number;
}

export interface OneOfValues<V extends readonly string[]> {
  readonly values: V;
}

/** Everything a decorator recorded besides its kind (the union of all decorators' options). */
export interface FieldSettings
  extends FieldOptions<unknown>, TextLimits, NumberLimits, DecimalStringLimits, ListLimits {
  readonly optional?: boolean;
  readonly default?: unknown;
  readonly values?: readonly string[];
}

/** What a list holds or a nested field is: a plain value or a DTO. */
export type ElementSpec =
  | { readonly kind: "scalar"; readonly scalar: ScalarKind }
  | { readonly kind: "dto"; readonly dto: DtoClass };

/** One decorated field as recorded at class definition. */
export interface FieldSpec {
  readonly name: string;
  readonly kind: FieldKind;
  readonly optional: boolean;
  readonly settings: FieldSettings;
  /** `@ListOf` element / `@Nested` DTO. */
  readonly element?: ElementSpec;
  /** Declared on a `#private` field (not plain data). */
  readonly isPrivate: boolean;
}

/**
 * What the compiler demands of the decorated field: its name is public (`keyof This` — not a TS
 * `private`), it is not `#private` and not `static`.
 */
export interface PlainFieldContext<This> {
  readonly name: keyof This;
  readonly private: false;
  readonly static: false;
}

/**
 * A field decorator for fields of exactly type `T`: the initializer `(T) => T` makes the compiler
 * demand the field's type ≡ `T` both ways (#113).
 */
export type FieldDecorator<T> = <This>(
  value: undefined,
  context: ClassFieldDecoratorContext<This, T> & PlainFieldContext<This>,
) => (initial: T) => T;

/** A decorator factory: `optional: true` ↔ `name?: T`; the last signature is the required one. */
export interface FieldFactory<T, TLimits extends object = object> {
  (options: TLimits & FieldOptions<T> & OptionalField): FieldDecorator<T | undefined>;
  (options?: TLimits & FieldOptions<T> & RequiredField<T>): FieldDecorator<T>;
}
