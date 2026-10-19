import type { Class } from "../../components/injection.js";

/**
 * A class a unit runner's container creates instead of another (#262 S62): wherever a component
 * depends on `token`, it gets the container's instance of `replacement` — created like any class,
 * its own `deps` resolved. Classes only: a value of a class stays `[di.instance-provider]` (#261).
 */
export interface Override {
  readonly token: Class;
  readonly replacement: Class;
}

/** `override(SearchClient, FakeSearchClient)`: the fake's instances must fit the token's type. */
export function override<T>(token: Class<T>, replacement: Class<T>): Override {
  return { token, replacement };
}
