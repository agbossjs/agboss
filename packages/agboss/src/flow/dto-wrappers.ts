import type { DtoClass } from "../dto/types.js";

/**
 * The type wrappers of #270 — `optional(XDto)`, `listOf(XDto)`, `oneOf(ADto, BDto, …)` — with
 * `historyOf(XDto, { maxPrevious })` for an input that reads the earlier versions too (#299, S56). Each wrapper is a frozen
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

/** `listOf(XDto)` / `listOf(ADto, BDto, …)` — a list of values; several classes make a polymorphic list. */
export interface ListWrapper<TElement extends ListElementShape = ListElementShape> {
  readonly kind: Wrapper.List;
  /** The one class, or the `oneOf(…)` of the several the list holds. */
  readonly element: TElement;
  /** Every class the list may hold, in the order written (one for a homogeneous list). */
  readonly variants: readonly [DtoClass, ...DtoClass[]];
}

/** What `listOf(...variants)` holds: the class itself, or the `oneOf(…)` of two or more. */
export type ListElementOf<TVariants extends readonly [DtoClass, ...DtoClass[]]> =
  TVariants extends OneOfVariants ? OneOfWrapper<TVariants> : TVariants[0];

/** What may be optional: a DTO or a list (`optional(listOf(XDto))`, Q49). */
export type OptionalInnerShape = DtoClass | ListWrapper;

/** `optional(XDto)` — an input field that may be absent. */
export interface OptionalWrapper<TInner extends OptionalInnerShape = OptionalInnerShape> {
  readonly kind: Wrapper.Optional;
  readonly inner: TInner;
}

/** A value on a path, an input field or a step's value: `XDto`, `listOf(…)`, `optional(…)`. */
export type ValueShape = DtoClass | ListWrapper | OptionalWrapper;

/** What a component gives: `XDto`, `listOf(…)` or `oneOf(…)` — never `optional(…)`. */
export type OutputShape = DtoClass | ListWrapper | OneOfWrapper;

/** What a step gives (#299, S54): a value shape, or the `oneOf(…)` a `.toOneOf([…])` branches. */
export type ReturnedShape = ValueShape | OneOfWrapper;

/** `historyOf(XDto, { maxPrevious })`'s options. */
export interface HistoryOptions {
  /** At most this many earlier versions, the latest ones; every earlier version when omitted. */
  readonly maxPrevious?: number;
}

/**
 * `historyOf(XDto, { maxPrevious })` (#299, S56) — an input field that reads the current `XDto` and the
 * earlier versions of it in this execution: `HistoryOf<Tracked<XDto, P>>` in `InputOf`.
 */
export interface HistoryWrapper<TDto extends DtoClass = DtoClass> {
  readonly kind: Wrapper.History;
  readonly dto: TDto;
  readonly maxPrevious?: number;
}

/**
 * What a `historyOf(XDto)` field holds: the current value and the earlier versions, oldest first
 * (at most `maxPrevious` of them, the latest ones); `previous` is empty on the first visit.
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

/**
 * `listOf(VendorDto)` — a list of one class; `listOf(ScoreDto, RejectedDto, …)` — a polymorphic list,
 * each item one of the classes (#1288).
 */
export function listOf<const TVariants extends readonly [DtoClass, ...DtoClass[]]>(
  ...variants: TVariants
): ListWrapper<ListElementOf<TVariants>> {
  return listOfVariants(variants) as ListWrapper<ListElementOf<TVariants>>;
}

/** The list of one class, or of the several a `oneOf(…)` names. */
export function listOfElement(element: ListElementShape): ListWrapper {
  return listOfVariants(typeof element === "function" ? [element] : element.variants);
}

function listOfVariants(variants: readonly [DtoClass, ...DtoClass[]]): ListWrapper {
  const [only] = variants;
  const element: ListElementShape =
    variants.length === 1 ? only : oneOf(...(variants as OneOfVariants));
  return Object.freeze({
    kind: Wrapper.List,
    element,
    variants: Object.freeze([...variants] as [DtoClass, ...DtoClass[]]),
  });
}

export function oneOf<const TVariants extends OneOfVariants>(
  ...variants: TVariants
): OneOfWrapper<TVariants> {
  return Object.freeze({ kind: Wrapper.OneOf, variants: Object.freeze(variants) });
}

/**
 * `historyOf(OfferDraftDto, { maxPrevious: 2 })` — an `input` field that reads the current value of the
 * class and its earlier versions (#299, S56); a path must bring a current value.
 */
export function historyOf<const TDto extends DtoClass>(
  dto: TDto,
  options: HistoryOptions = {},
): HistoryWrapper<TDto> {
  const { maxPrevious } = options;
  return Object.freeze(
    maxPrevious === undefined
      ? { kind: Wrapper.History, dto }
      : { kind: Wrapper.History, dto, maxPrevious },
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

/** Whether a value is what a step can give: a value shape or a `oneOf(…)`. */
export const isReturnedShape = (value: unknown): value is ReturnedShape =>
  isValueShape(value) || (isWrapper(value) && value.kind === Wrapper.OneOf);
