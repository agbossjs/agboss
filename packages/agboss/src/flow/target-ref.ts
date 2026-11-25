import type { Class } from "../components/injection.js";

/**
 * A class a declaration names, or a thunk of it (#1271b, #1287): `{ target: Finish }` or
 * `{ target: () => Finish }`. The thunk is for the class declared below the one that names it — a
 * decorator's argument is evaluated before the class below exists, so `Finish` there is a
 * `ReferenceError` (the temporal dead zone) while `() => Finish` is read at assembly, once every
 * module has run.
 */
export type TargetRef<TClass extends Class = Class> = TClass | (() => TClass);

/** The class a `TargetRef` stands for: `typeof Finish` for `typeof Finish` and `() => typeof Finish`. */
export type UnwrapTarget<TRef> = TRef extends abstract new (...args: never[]) => unknown
  ? TRef
  : TRef extends () => infer TClass
    ? TClass
    : TRef;

/** `UnwrapTarget` as a `Class`, for the checks that take a class (`never` for a reference that is none). */
export type ClassOf<TRef> = UnwrapTarget<TRef> extends infer TClass extends Class ? TClass : never;

/**
 * Whether a reference is a thunk: an arrow function has no `prototype`, a class always has one — so a
 * class is never called as a function.
 */
const isThunk = <TClass extends Class>(ref: TargetRef<TClass>): ref is () => TClass =>
  typeof ref === "function" && !Object.hasOwn(ref, "prototype");

/** The class behind a reference; call it after every module has run (at assembly, never in a decorator). */
export const resolveTarget = <TClass extends Class>(ref: TargetRef<TClass>): TClass =>
  isThunk(ref) ? ref() : ref;

/**
 * A declaration's data with `key` holding the class a reference stands for (#1287). A class is stored
 * as it is; a thunk is read the first time `key` is read, never while the path is built — a
 * decorator's argument runs before the class below it exists, so a thunk called there would hit the
 * temporal dead zone. The result reads like plain data afterwards; every reader of `key` is at
 * assembly or at run time.
 */
export function withTarget<const TKey extends string, TRest extends object>(
  key: TKey,
  ref: TargetRef,
  rest: TRest,
): TRest & Readonly<Record<TKey, Class>> {
  if (!isThunk(ref)) return { ...rest, [key]: ref } as TRest & Readonly<Record<TKey, Class>>;
  return Object.defineProperty({ ...rest }, key, {
    enumerable: true,
    get: lazily(ref),
  }) as TRest & Readonly<Record<TKey, Class>>;
}

/** `() => ref()` that calls the thunk until it gives a class, then keeps it. */
function lazily<TValue>(thunk: () => TValue): () => TValue {
  let resolved: TValue | undefined;
  return () => (resolved ??= thunk());
}

/** `withTarget` for a list of references: `key` holds their classes, the list read on first use. */
export function withTargets<const TKey extends string, TRest extends object>(
  key: TKey,
  refs: readonly TargetRef[],
  rest: TRest,
): TRest & Readonly<Record<TKey, readonly Class[]>> {
  type Result = TRest & Readonly<Record<TKey, readonly Class[]>>;
  if (!refs.some(isThunk)) return { ...rest, [key]: Object.freeze([...refs]) } as Result;
  const get = lazily(() => Object.freeze(refs.map((ref) => resolveTarget(ref))));
  return Object.defineProperty({ ...rest }, key, { enumerable: true, get }) as Result;
}
