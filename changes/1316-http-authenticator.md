---
section: Breaking
issue: 1316
---

**`@HttpAuthenticator` replaces the A2A caller resolver** (#1316, part of #498): who calls an HTTP
listener is a class with `authenticate(request)` (sync or async, no `implements`, no `<typeof Start>`
generic), decorated `@HttpAuthenticator({ name?, description?, schemes?, deps? })`, listed in
`@Application({ services })` and named by the listener: `a2aHttpListener(app, { expose, authenticator,
publicUrl })`. Its answer is built by `HttpAuthResult.authenticated(caller)`, `.unauthenticated(reason,
{ challenge? })` or `.forbidden(reason)` (`HttpAuthKind`); the caller may carry a `rateLimitKey`. The
security schemes move to the authenticator that enforces them: `HttpSecurity.{bearer, apiKey,
oauth2ClientCredentials, mtls}` (`HttpSecurityScheme`, `HttpSecuritySchemeKind`) on `schemes`, written
into the card's `securitySchemes`. The listener also takes `provider` (the card's, from `@A2AExpose`)
and `onError(error, req)`, and resolves its authenticator when it is created: a class without the
decorator stops it with `[http.not-an-authenticator]`.

Removed: `A2ACallerResolver`, `A2ACallerRequest`, `A2ACallerResolution` (+ `Kind`, `Unauthenticated/Forbidden
Options`, `Resolved/Rejected…Resolution`), `A2ACaller`, `A2APeer`, `A2ASecurity`, `A2ASecurityScheme`,
`A2ASecuritySchemeKind`, `A2AHttpListenerOptions.callerResolver` and its `TStart` generic,
`A2AExposeOptions.security` and `.provider`, the `[a2a.caller-resolver-not-listed]` rule. Added:
`HttpAuthenticator`, `HttpAuthResult`, `HttpAuthKind`, `HttpAuthRequest`, `HttpCaller`,
`HttpAuthenticatorHandler`/`Meta`/`Options`, `HttpSecurity`, `HttpSecurityScheme`,
`HttpSecuritySchemeKind`, `A2AHttpListenerOptions.authenticator/provider/onError`.

Migration:

- `@Injectable() class X implements A2ACallerResolver<typeof Start> { resolveCaller(request) }` →
  `@HttpAuthenticator() class X { authenticate(request) }`, listed in `services`;
- `A2ACallerResolution.resolved(caller)` → `HttpAuthResult.authenticated(caller)`;
  `.unauthenticated({ reason, challenge })` → `.unauthenticated(reason, { challenge })`;
  `.forbidden({ reason })` → `.forbidden(reason)`;
- `callerResolver: X` → `authenticator: X`; `@A2AExpose({ security: [A2ASecurity.bearer()] })` →
  `@HttpAuthenticator({ schemes: [HttpSecurity.bearer()] })`; `@A2AExpose({ provider })` →
  `a2aHttpListener(app, { provider })`.
