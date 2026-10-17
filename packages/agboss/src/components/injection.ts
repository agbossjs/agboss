/** A named value to inject (config objects, functions); classes are their own tokens. */
export class InjectionToken<T> {
  declare readonly __type: T;
  constructor(readonly description: string) {}
}

/** Any class. `never[]` parameters: we only need the instance type. */
export type Class<T = unknown> = abstract new (...args: never[]) => T;

export type Token = Class | InjectionToken<unknown>;

/** What a token gives the constructor: a token's value type, or a class's instance type. */
export type Resolved<T> =
  T extends InjectionToken<infer V>
    ? V
    : T extends abstract new (...args: never[]) => infer I
      ? I
      : never;

/** Constructor parameters for a `deps` list — the compiler checks count, order and types. */
export type ResolvedAll<D extends readonly Token[]> = { -readonly [K in keyof D]: Resolved<D[K]> };

export const tokenName = (token: Token): string =>
  token instanceof InjectionToken ? token.description : token.name || "(anonymous class)";

/** Module-private: only `provide()` can build a `ValueProvider`, so a raw literal is a type error. */
const valueProviderBrand: unique symbol = Symbol("ValueProvider");

/** A value bound to a token; build it with `provide(token, value)`. */
export interface ValueProvider<T = unknown> {
  readonly provide: InjectionToken<T> | Class<T>;
  readonly useValue: T;
  readonly [valueProviderBrand]: true;
}

/** Registered in `@Workflow({ providers })`: a class (created by the container) or a value. */
export type Provider = Class | ValueProvider;

/** Ties a value strictly to its token type for `@Workflow({ providers })`. */
export function provide<T>(token: InjectionToken<T> | Class<T>, value: T): ValueProvider<T> {
  return { provide: token, useValue: value, [valueProviderBrand]: true };
}
