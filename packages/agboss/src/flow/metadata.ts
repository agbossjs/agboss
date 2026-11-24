import type { Class } from "../components/injection.js";

/**
 * Where a value on a flow path came from (#1274): the component that gave it, the visit, the item,
 * and the values it was built from — read with the static `Metadata` facade, never off the value.
 * The facts live in a module-private `WeakMap` keyed by the value object, so a DTO carries no
 * property of its own for them: `Reflect.ownKeys`, `structuredClone`, JSON and assertions see the
 * plain data the DTO is.
 */

/** The phantom brand of `Tracked<T>`: a type only, never set on a value. */
export declare const valueMetadata: unique symbol;

/** Everything known about where one value came from. */
export interface ValueMetadata<TComponent extends Class = Class> {
  /** The checkpoint's id of the value (`<node>:<visit>/<slot>`), `[index]` after it for a list item. */
  readonly valueId: string;
  /** The path scope's slot the value was written into. */
  readonly slot: string;
  /** The class of the component that gave the value; across a child workflow, the child's class. */
  readonly createdBy: TComponent;
  /** Which visit of that component gave it, from 1. */
  readonly visitNumber: number;
  /** The place in the list of a per-item run or a joined list. */
  readonly itemIndex?: number | undefined;
  /** What it was built from: the values the producer read. */
  readonly parents: readonly ValueMetadata[];
}

/** What `Metadata.with(value, options)` states of a value; the rest takes a default. */
export interface MetadataOptions<TComponent extends Class = Class> {
  readonly createdBy: TComponent;
  readonly visitNumber?: number | undefined;
  readonly itemIndex?: number | undefined;
  readonly parents?: readonly (Tracked<object> | ValueMetadata)[] | undefined;
  readonly slot?: string | undefined;
  readonly valueId?: string | undefined;
}

/** A value whose metadata the framework or `Metadata.with` recorded; a plain DTO is not one. */
export type Tracked<TValue extends object, TComponent extends Class = Class> = TValue & {
  readonly [valueMetadata]: TComponent;
};

/** What `Tracked` leaves of a type that is not a plain data object: dates, bytes, patterns, functions. */
export type UntrackedLeaf = Date | Uint8Array | RegExp | ((...args: never[]) => unknown);

/** `T` as a plain value: a test writes `Untracked<InputOf<X>>` where the handler reads `InputOf<X>`. */
export type Untracked<T> = T extends readonly (infer TItem)[]
  ? readonly Untracked<TItem>[]
  : T extends { readonly [valueMetadata]: Class }
    ? Omit<T, typeof valueMetadata> | T
    : T extends UntrackedLeaf
      ? T
      : T extends object
        ? { readonly [K in keyof T]: Untracked<T[K]> }
        : T;

const metadataOf = new WeakMap<object, ValueMetadata>();

const isObject = (value: unknown): value is object =>
  (typeof value === "object" && value !== null) || typeof value === "function";

const isValueMetadata = (value: unknown): value is ValueMetadata =>
  typeof value === "object" && value !== null && "valueId" in value && "createdBy" in value;

/** `of(value)` for a value `with` or the runtime tracked; `undefined` for any other. */
function of(value: object): ValueMetadata | undefined;
function of(value: unknown): ValueMetadata | undefined {
  return isObject(value) ? metadataOf.get(value) : undefined;
}

/** The values `value` was built from, nearest first, each once (a value built from the same ancestor twice). */
function ancestors(value: object): readonly ValueMetadata[] {
  const found = new Map<string, ValueMetadata>();
  let level = of(value)?.parents ?? [];
  while (level.length > 0) {
    const next: ValueMetadata[] = [];
    for (const parent of level) {
      if (found.has(parent.valueId)) continue;
      found.set(parent.valueId, parent);
      next.push(...parent.parents);
    }
    level = next;
  }
  return [...found.values()];
}

/** A shallow copy that keeps the prototype (a DTO class stays itself, #1288), an array stays an array. */
const cloneOf = <TValue extends object>(value: TValue): TValue =>
  Array.isArray(value)
    ? (value.slice() as TValue)
    : Object.assign(Object.create(Object.getPrototypeOf(value) as object | null) as TValue, value);

/** The metadata of a value written by `with`: what is not stated is the component's first visit. */
function describedBy(options: MetadataOptions): ValueMetadata {
  const visitNumber = options.visitNumber ?? 1;
  const slot = options.slot ?? "value";
  const parents = (options.parents ?? []).flatMap((parent) => {
    const known = isValueMetadata(parent) ? parent : of(parent);
    return known === undefined ? [] : [known];
  });
  return Object.freeze({
    valueId: options.valueId ?? `${options.createdBy.name}:${String(visitNumber)}/${slot}`,
    slot,
    createdBy: options.createdBy,
    visitNumber,
    ...(options.itemIndex === undefined ? {} : { itemIndex: options.itemIndex }),
    parents: Object.freeze(parents),
  });
}

/**
 * `Metadata.of(value)`, `.has(value)`, `.createdBy(value)`, `.ancestors(value)` read where a value of
 * a flow path came from; `.with(value, options)` gives a copy that states it (a test's input, an
 * action's result). `createdBy` is the creator's class, so `Metadata.createdBy(item) ===
 * LookupVendorAction` and an exhaustive `switch` on it both work.
 */
export interface MetadataFacade {
  of<TComponent extends Class>(value: Tracked<object, TComponent>): ValueMetadata<TComponent>;
  of(value: object): ValueMetadata | undefined;
  has(value: object): value is Tracked<object>;
  /** The class that gave `value`; for a value that is one of several tracked kinds (`@Arbitrate(A, B)`), `typeof A | typeof B`. */
  createdBy<TValue extends Tracked<object>>(value: TValue): TValue[typeof valueMetadata];
  createdBy(value: object): Class | undefined;
  ancestors(value: object): readonly ValueMetadata[];
  /** A copy of `value` (its prototype kept) that states its metadata; `value` itself is never branded. */
  with<TValue extends object, TComponent extends Class>(
    value: TValue,
    options: MetadataOptions<TComponent>,
  ): Tracked<TValue, TComponent>;
}

export const Metadata: MetadataFacade = Object.freeze({
  of,
  has: (value: object): value is Tracked<object> => of(value) !== undefined,
  createdBy: (value: object) => of(value)?.createdBy,
  ancestors,
  with: <TValue extends object, TComponent extends Class>(
    value: TValue,
    options: MetadataOptions<TComponent>,
  ): Tracked<TValue, TComponent> => {
    const copy = cloneOf(value);
    metadataOf.set(copy, describedBy(options));
    return copy as Tracked<TValue, TComponent>;
  },
} as MetadataFacade);

/**
 * The runtime's side: records where `value` came from. A value another visit already recorded is
 * copied first (prototype kept) — one object never holds two sets of facts — and the copy returned.
 */
export function trackValue<TValue>(value: TValue, metadata: ValueMetadata): TValue {
  if (!isObject(value)) return value;
  const known = metadataOf.get(value);
  const target = known === undefined || known.valueId === metadata.valueId ? value : cloneOf(value);
  metadataOf.set(target, metadata);
  return target;
}
