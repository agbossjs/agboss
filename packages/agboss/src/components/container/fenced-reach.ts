import type { Class, Token } from "../injection.js";

/**
 * What can make a business key (#825): a class a component reaches through its `deps` that writes
 * under one — `OutboundCalls`, a `FencedEffectRepository` (any store of it). A component that reaches
 * one may call `effectKeyOf(…, { businessKey })`, so its application names an idempotency key.
 */
const writers = new WeakSet<Class>();

/** Marks `cls` and every class extending it as a writer under business keys (internal). */
export function markBusinessKeyWriter(cls: Class): void {
  writers.add(cls);
}

/** Whether `cls` is a writer or extends one. */
function isWriter(cls: Class): boolean {
  for (let at: unknown = cls; typeof at === "function"; at = Object.getPrototypeOf(at))
    if (writers.has(at as Class)) return true;
  return false;
}

/** A component that reaches a writer under business keys, and the writer (#825). */
export interface BusinessKeyWriterUse {
  readonly component: Class;
  readonly writer: Class;
}

/**
 * What a token is given, by the application's providers (#825): a class itself and every listed
 * class that extends it (an abstract dependency gets the listed one, whose own `deps` count), and a
 * value provider's value by its class — an `InjectionToken` too.
 */
export type TokenClasses = (token: Token) => readonly Class[];

/** `TokenClasses` over the listed providers: classes, and `provide(token, value)` values. */
export function tokenClassesOf(providers: readonly unknown[]): TokenClasses {
  const listed = providers.filter((provider): provider is Class => typeof provider === "function");
  const valued = new Map<unknown, Class[]>();
  for (const provider of providers) {
    if (typeof provider !== "object" || provider === null) continue;
    const token: unknown = Reflect.get(provider, "provide");
    const value: unknown = Reflect.get(provider, "useValue");
    const cls: unknown =
      typeof value === "object" && value !== null ? value.constructor : undefined;
    if (typeof cls === "function") valued.set(token, [...(valued.get(token) ?? []), cls as Class]);
  }
  return (token) => {
    const values = valued.get(token) ?? [];
    if (typeof token !== "function") return values;
    const extending = listed.filter((cls) => cls !== token && cls.prototype instanceof token);
    return [token, ...extending, ...values];
  };
}

/** The first of `roots` that is, or reaches through its `deps`, a writer under business keys. */
export function businessKeyWriterUseOf(
  roots: readonly Class[],
  depsOf: (cls: Class) => readonly Token[],
  classesOf: TokenClasses = (token) => (typeof token === "function" ? [token] : []),
): BusinessKeyWriterUse | undefined {
  for (const component of roots) {
    const reached = new Set<Class>([component]);
    for (const cls of reached) {
      if (isWriter(cls)) return { component, writer: cls };
      for (const token of depsOf(cls)) for (const given of classesOf(token)) reached.add(given);
    }
  }
  return undefined;
}

/** What each workflow's components reach of the writers (#825), by its metadata, at its assembly. */
const writerUses = new WeakMap<object, BusinessKeyWriterUse>();

/** Remembers what `workflow`'s components reach of the writers, when they reach one. */
export function rememberBusinessKeyWriter(
  workflow: object,
  use: BusinessKeyWriterUse | undefined,
): void {
  if (use !== undefined) writerUses.set(workflow, use);
}

/** What `workflow`'s components reach of the writers, as its assembled parts keep it. */
export const businessKeyWriterPartOf = (
  workflow: object,
): { readonly businessKeyWriter?: BusinessKeyWriterUse } => {
  const use = writerUses.get(workflow);
  return use === undefined ? {} : { businessKeyWriter: use };
};
