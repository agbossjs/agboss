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

/**
 * Whether a reference is a thunk: an arrow function has no `prototype`, a class always has one — so a
 * class is never called as a function.
 */
const isThunk = <TClass extends Class>(ref: TargetRef<TClass>): ref is () => TClass =>
  !Object.hasOwn(ref, "prototype");

/** The class behind a reference; call it after every module has run (at assembly, never in a decorator). */
export const resolveTarget = <TClass extends Class>(ref: TargetRef<TClass>): TClass =>
  isThunk(ref) ? ref() : ref;
