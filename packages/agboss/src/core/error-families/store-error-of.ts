import { AGBossError } from "../errors.js";
import type { VariantOptions } from "./family.js";
import { StoreErrorKind, type StoreError } from "./store-errors.js";

/** The variant of `StoreError` of one kind. */
export type StoreErrorOfKind<TKind extends StoreErrorKind> = Extract<
  StoreError,
  { readonly kind: TKind }
>;

/** What the store packages build errors with: `StoreError.of(StoreErrorKind.SchemaTooNew, { … })`. */
export interface StoreErrorStatics {
  /** A genuine `StoreError` of `kind`: how `@agboss/postgres` & co. report without a class of their own. */
  of<TKind extends StoreErrorKind>(
    kind: TKind,
    options: VariantOptions<StoreErrorOfKind<TKind>>,
  ): StoreErrorOfKind<TKind>;
}

/** The variant's name of a kind: `"schema-too-new"` → `SchemaTooNew`. */
const variantNameOf = (kind: StoreErrorKind): string | undefined =>
  Object.entries(StoreErrorKind).find(([, value]) => value === kind)?.[0];

/** `of` finds the variant of a kind among the family's own constructors. */
export function withOf<TConstructor extends object>(
  constructor: TConstructor,
): TConstructor & StoreErrorStatics {
  function of<TKind extends StoreErrorKind>(
    kind: TKind,
    options: VariantOptions<StoreErrorOfKind<TKind>>,
  ): StoreErrorOfKind<TKind> {
    const name = variantNameOf(kind);
    const Variant: unknown = name === undefined ? undefined : Reflect.get(constructor, name);
    if (typeof Variant !== "function") throw new TypeError(`${kind} is not a kind of StoreError`);
    const error: unknown = Reflect.construct(Variant, [options]);
    if (!(error instanceof AGBossError)) throw new TypeError(`${kind} did not make an error`);
    return error as StoreErrorOfKind<TKind>;
  }
  return Object.assign(constructor, { of });
}
