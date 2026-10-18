import type { DtoClass } from "../dto/types.js";

/**
 * The type wrappers of #270 — `optional(XDto)`, `listOf(XDto)`, `oneOf(ADto, BDto, …)` — with
 * `historyOf(XDto, { limit })` for an input that reads the earlier versions too (#299, S56), and the
 * variant helpers `variant(XDto, value)` / `isVariant(item, XDto)`. Each wrapper is a frozen
 * descriptor the analyser and the runtime read, typed so the builder and `InputOf` can read it too.
 */

/** Which wrapper a descriptor is. */
export enum Wrapper {
  Optional = "optional",
  List = "list",
  OneOf = "one-of",
  History = "history",
}

/** The classes of a `oneOf(…)`: two or more. */
export type OneOfVariants = readonly [DtoClass, DtoClass, ...DtoClass[]];

/** `oneOf(ADto, BDto, …)` — exactly one of the classes (an agent's or an action's `output`). */
export interface OneOfWrapper<TVariants extends OneOfVariants = OneOfVariants> {
  readonly kind: Wrapper.OneOf;
  readonly variants: TVariants;
}

/** What a list holds: a DTO or a `oneOf(…)` — never an `optional(…)` (a list element is never absent). */
export type ListElementShape = DtoClass | OneOfWrapper;

/** `listOf(XDto)` / `listOf(oneOf(…))` — a list of values. */
export interface ListWrapper<TElement extends ListElementShape = ListElementShape> {
  readonly kind: Wrapper.List;
  readonly element: TElement;
}

/** What may be optional: a DTO or a list (`optional(listOf(XDto))`, Q49). */
export type OptionalInnerShape = DtoClass | ListWrapper;

/** `optional(XDto)` — an input field that may be absent. */
export interface OptionalWrapper<TInner extends OptionalInnerShape = OptionalInnerShape> {
  readonly kind: Wrapper.Optional;
  readonly inner: TInner;
}

/** A value on a path, an input field or a `.returns(…)` value: `XDto`, `listOf(…)`, `optional(…)`. */
export type ValueShape = DtoClass | ListWrapper | OptionalWrapper;

/** What a component gives: `XDto`, `listOf(…)` or `oneOf(…)` — never `optional(…)`. */
export type OutputShape = DtoClass | ListWrapper | OneOfWrapper;

/** What one `.returns(…)` names (#299, S54): a value shape, or the `oneOf(…)` a `.switch` branches. */
export type ReturnedShape = ValueShape | OneOfWrapper;

/** `historyOf(XDto, { limit })`'s options. */
export interface HistoryOptions {
  /** At most this many earlier versions, the latest ones; every earlier version when omitted. */
  readonly limit?: number;
}

/**
 * `historyOf(XDto, { limit })` (#299, S56) — an input field that reads the current `XDto` and the
 * earlier versions of it in this execution: `HistoryOf<Produced<XDto, P>>` in `InputOf`.
 */
export interface HistoryWrapper<TDto extends DtoClass = DtoClass> {
  readonly kind: Wrapper.History;
  readonly dto: TDto;
  readonly limit?: number;
}

/**
 * What a `historyOf(XDto)` field holds: the current value and the earlier versions, oldest first
 * (at most `limit` of them, the latest ones); `previous` is empty on the first visit.
 */
export interface HistoryOf<TValue> {
  readonly current: TValue;
  readonly previous: readonly TValue[];
}

/** Any wrapper descriptor. */
export type AnyWrapper = OptionalWrapper | ListWrapper | OneOfWrapper | HistoryWrapper;

/** The value a shape stands for: `XDto` → `XDto`, `listOf(XDto)` → `readonly XDto[]`, … */
export type ValueOf<TShape> =
  TShape extends DtoClass<infer TValue>
    ? TValue
    : TShape extends ListWrapper<infer TElement>
      ? readonly ValueOf<TElement>[]
      : TShape extends OneOfWrapper<infer TVariants>
        ? InstanceType<TVariants[number]>
        : TShape extends OptionalWrapper<infer TInner>
          ? ValueOf<TInner> | undefined
          : TShape extends HistoryWrapper<infer TDto>
            ? HistoryOf<InstanceType<TDto>>
            : never;

export function optional<const TInner extends OptionalInnerShape>(
  inner: TInner,
): OptionalWrapper<TInner> {
  return Object.freeze({ kind: Wrapper.Optional, inner });
}

export function listOf<const TElement extends ListElementShape>(
  element: TElement,
): ListWrapper<TElement> {
  return Object.freeze({ kind: Wrapper.List, element });
}

export function oneOf<const TVariants extends OneOfVariants>(
  ...variants: TVariants
): OneOfWrapper<TVariants> {
  return Object.freeze({ kind: Wrapper.OneOf, variants: Object.freeze(variants) });
}

/**
 * `historyOf(OfferDraftDto, { limit: 2 })` — an `input` field that reads the current value of the
 * class and its earlier versions (#299, S56); a path must bring a current value.
 */
export function historyOf<const TDto extends DtoClass>(
  dto: TDto,
  options: HistoryOptions = {},
): HistoryWrapper<TDto> {
  const { limit } = options;
  return Object.freeze(
    limit === undefined ? { kind: Wrapper.History, dto } : { kind: Wrapper.History, dto, limit },
  );
}

const WRAPPERS: readonly string[] = Object.values(Wrapper);

/** Whether a value is one of the wrapper descriptors (not a DTO class, not plain options). */
export function isWrapper(value: unknown): value is AnyWrapper {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    typeof value.kind === "string" &&
    WRAPPERS.includes(value.kind)
  );
}

/** Whether a value is a value shape (`XDto`, `listOf(…)`, `optional(…)`). */
export function isValueShape(value: unknown): value is ValueShape {
  return (
    typeof value === "function" ||
    (isWrapper(value) && (value.kind === Wrapper.List || value.kind === Wrapper.Optional))
  );
}

/** Whether a value is what one `.returns(…)` takes: a value shape or a `oneOf(…)`. */
export const isReturnedShape = (value: unknown): value is ReturnedShape =>
  isValueShape(value) || (isWrapper(value) && value.kind === Wrapper.OneOf);

/** The key the class of a `oneOf` value is kept under (non-enumerable, never serialized). */
const variantClass: unique symbol = Symbol("agboss.variant");

/** A value of one class of a `oneOf` output, as `variant(XDto, value)` returns it. */
export type Variant<TDto extends DtoClass> = InstanceType<TDto> & {
  readonly [variantClass]: TDto;
};

/**
 * A value read from the path scope: who produced it and the value (#270, Q19). Distributes over a
 * union value, so `isVariant` narrows `Produced<A | B, P>` in both branches.
 */
export type Produced<TValue, TProducer> = TValue extends unknown
  ? ProducedValue<TValue, TProducer>
  : never;

export interface ProducedValue<TValue, TProducer> {
  readonly producer: TProducer;
  readonly value: TValue;
}

/** Some fields of a `oneOf` value with its class: an element matcher in a test's `when(…)` (#262). */
export type PartialVariant<TDto extends DtoClass> = Partial<InstanceType<TDto>> & {
  readonly [variantClass]: TDto;
};

/** An action's `oneOf` result: names the class it returns; the runtime never guesses it by shape. */
export function variant<TDto extends DtoClass>(dto: TDto, value: InstanceType<TDto>): Variant<TDto>;
/**
 * In a test (#262): an element of a `listOf(oneOf(…))` input matched by its class and the fields
 * given — `when({ scores: [variant(CompanyScoreDto, { score: 9 })] })`.
 */
export function variant<TDto extends DtoClass>(
  dto: TDto,
  value: Partial<InstanceType<TDto>>,
): PartialVariant<TDto>;
export function variant<TDto extends DtoClass>(
  dto: TDto,
  value: Partial<InstanceType<TDto>>,
): Variant<TDto> | PartialVariant<TDto> {
  const result: Partial<InstanceType<TDto>> = { ...value };
  Object.defineProperty(result, variantClass, { value: dto, enumerable: false });
  // marked just above; a full value (the first overload) is a Variant, a partial one a PartialVariant
  return result as PartialVariant<TDto>;
}

/** The class `variant(XDto, value)` marked a value with; undefined for a plain value. */
export function variantClassOf(value: unknown): DtoClass | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const marked: unknown = Reflect.get(value, variantClass);
  return typeof marked === "function" ? (marked as DtoClass) : undefined;
}

/** The class a `oneOf` value carries: on the `Produced` record, else on its value. */
function variantOf(item: ProducedValue<unknown, unknown>): unknown {
  const own: unknown = Reflect.get(item, variantClass);
  if (own !== undefined) return own;
  const { value } = item;
  return typeof value === "object" && value !== null ? Reflect.get(value, variantClass) : undefined;
}

/** Narrows a `Produced` value (or a list element) of a `oneOf` to one of its classes. */
export function isVariant<TItem extends ProducedValue<unknown, unknown>, TDto extends DtoClass>(
  item: TItem,
  dto: TDto,
): item is Extract<TItem, ProducedValue<InstanceType<TDto>, unknown>> {
  return variantOf(item) === dto;
}

/** Marks a `Produced` record with its value's class (the runtime does it for a `oneOf` value). */
export function withVariant<TItem extends ProducedValue<unknown, unknown>>(
  item: TItem,
  dto: DtoClass,
): TItem {
  const copy: TItem = { ...item };
  Object.defineProperty(copy, variantClass, { value: dto, enumerable: false });
  return copy;
}
