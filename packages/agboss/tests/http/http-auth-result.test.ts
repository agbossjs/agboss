/**
 * #1316 (#387 S2 Q1): an authenticator's answer is built only by `HttpAuthResult` — branded, frozen,
 * a plain object does not compile and is not an answer — and a decorated class takes the
 * `@HttpAuthenticator` shape: `authenticate(request)`, sync or async, no `implements`.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  HttpAuthenticator,
  HttpAuthKind,
  HttpAuthResult,
  HttpSecurity,
  HttpSecuritySchemeKind,
  type HttpAuthenticatorHandler,
  type HttpAuthRequest,
} from "../../src/index.js";
import { isHttpAuthResult } from "../../src/http/http-auth.js";
import { httpAuthenticatorOf } from "../../src/http/http-authenticator.js";

describe("#1316: HttpAuthResult", () => {
  it("authenticated carries the caller; unauthenticated and forbidden carry the reason", () => {
    const known = HttpAuthResult.authenticated({ ownerId: "c-1", rateLimitKey: "key-1" });
    const unknown = HttpAuthResult.unauthenticated("no token", { challenge: 'Bearer realm="a2a"' });
    const refused = HttpAuthResult.forbidden("no");

    expect(known).toEqual({
      kind: HttpAuthKind.Authenticated,
      caller: { ownerId: "c-1", rateLimitKey: "key-1" },
    });
    expect(unknown).toEqual({
      kind: HttpAuthKind.Unauthenticated,
      reason: "no token",
      challenge: 'Bearer realm="a2a"',
    });
    expect(refused).toEqual({ kind: HttpAuthKind.Forbidden, reason: "no" });
    expect(HttpAuthResult.unauthenticated("x")).not.toHaveProperty("challenge");
    expect([known, unknown, refused].map((result) => Object.isFrozen(result))).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("a plain object is not an answer", () => {
    const plain = { kind: HttpAuthKind.Authenticated, caller: {} };
    const authenticator: HttpAuthenticatorHandler = {
      // @ts-expect-error — not built by HttpAuthResult: no brand
      authenticate: () => plain,
    };

    expect(typeof authenticator.authenticate).toBe("function");
    expect(isHttpAuthResult(plain)).toBe(false);
    expect(isHttpAuthResult(HttpAuthResult.authenticated({}))).toBe(true);
  });
});

describe("#1316: @HttpAuthenticator", () => {
  it("records its name (kebab-case of the class), description and schemes", () => {
    @HttpAuthenticator({
      description: "Bearer keys",
      schemes: [HttpSecurity.bearer({ bearerFormat: "JWT" })],
    })
    class DeskKeyAuthenticator {
      async authenticate(request: HttpAuthRequest): Promise<HttpAuthResult> {
        await Promise.resolve();
        return request.http.headers.authorization === undefined
          ? HttpAuthResult.unauthenticated("no key")
          : HttpAuthResult.authenticated({});
      }
    }

    expect(httpAuthenticatorOf(DeskKeyAuthenticator)).toEqual({
      name: "desk-key-authenticator",
      description: "Bearer keys",
      schemes: [{ kind: HttpSecuritySchemeKind.Bearer, name: "bearer", bearerFormat: "JWT" }],
      deps: [],
    });
    expectTypeOf<HttpAuthRequest["operation"]>().toEqualTypeOf<string | undefined>();
  });

  it("a class without authenticate does not compile; a plain class has no authenticator meta", () => {
    // @ts-expect-error — an authenticator has `authenticate(request)`
    @HttpAuthenticator()
    class NoAuthenticate {
      readonly x = 1;
    }

    class Plain {
      readonly x = 1;
    }

    expect(httpAuthenticatorOf(NoAuthenticate)).toBeDefined();
    expect(httpAuthenticatorOf(Plain)).toBeUndefined();
  });
});
