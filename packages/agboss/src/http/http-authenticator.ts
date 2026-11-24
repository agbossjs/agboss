import { recordOptionKeys } from "../components/option-keys.js";
import { HTTP_AUTHENTICATOR_KEYS } from "../components/decorator-options.js";
import type { Class, ResolvedAll, Token } from "../components/injection.js";
import { componentOf, recordComponent } from "../components/metadata.js";
import { resolvedName } from "../flow/names.js";
import type { HttpAuthRequest, HttpAuthResult } from "./http-auth.js";
import type { HttpSecurityScheme } from "./http-security.js";

/**
 * `@HttpAuthenticator` (#1316): who calls an HTTP listener. Listed in `@Application({ services })`
 * (or `providers`) and named by a listener (`a2aHttpListener(app, { authenticator })`), which takes
 * the instance from the application's container and asks it on every request, before anything of
 * the request runs — the tenant is never guessed from the request by the framework.
 */

/** `@HttpAuthenticator({ … })` options. */
export interface HttpAuthenticatorOptions<TDeps extends readonly Token[] = readonly Token[]> {
  /** Kebab-case; the class name in kebab-case when left out. */
  readonly name?: string;
  readonly description?: string;
  /**
   * How callers authenticate, as the listener advertises it (an Agent Card's `securitySchemes`, any
   * one of them accepted). Described only: `authenticate` enforces it.
   */
  readonly schemes?: readonly HttpSecurityScheme[];
  /** Constructor dependencies, in order; checked against the constructor by the compiler. */
  readonly deps?: TDeps;
}

/** What `@HttpAuthenticator` records about a class. */
export interface HttpAuthenticatorMeta {
  readonly name: string;
  readonly description?: string;
  readonly schemes: readonly HttpSecurityScheme[];
  readonly deps: readonly Token[];
}

/** What an authenticator class declares: `authenticate(request)`, sync or async. */
export interface HttpAuthenticatorHandler {
  /** Decides on one request: `HttpAuthResult.authenticated(…)`, `.unauthenticated(…)` or `.forbidden(…)`. */
  readonly authenticate: (request: HttpAuthRequest) => HttpAuthResult | Promise<HttpAuthResult>;
}

/** `@HttpAuthenticator({ schemes? })` on a class with `authenticate(request)`. */
export function HttpAuthenticator<const TDeps extends readonly Token[] = []>(
  options: HttpAuthenticatorOptions<TDeps> = {},
) {
  return <TClass extends new (...args: ResolvedAll<TDeps>) => HttpAuthenticatorHandler>(
    value: TClass,
  ): TClass => {
    recordOptionKeys(value, "HttpAuthenticator", options, HTTP_AUTHENTICATOR_KEYS);
    const { description } = options;
    const meta = {
      name: resolvedName(options.name, value),
      schemes: options.schemes ?? [],
      deps: options.deps ?? [],
    };
    recordComponent(value, {
      kind: "http-authenticator",
      meta: description === undefined ? meta : { ...meta, description },
    });
    return value;
  };
}

/** What `@HttpAuthenticator` recorded on a class; `undefined` for any other. */
export function httpAuthenticatorOf(cls: Class): HttpAuthenticatorMeta | undefined {
  const component = componentOf(cls);
  return component?.kind === "http-authenticator" ? component.meta : undefined;
}
