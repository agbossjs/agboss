/**
 * How the callers of an HTTP listener authenticate (#808, A2A spec §4.5; #1316): declared on the
 * `@HttpAuthenticator({ schemes })` that enforces them, and written by a protocol's listener into
 * what it advertises (an Agent Card's `securitySchemes`). It only describes: `authenticate` enforces.
 */

/** How a scheme is carried. */
export enum HttpSecuritySchemeKind {
  /** `Authorization: Bearer <token>`. */
  Bearer = "bearer",
  /** A key in a request header. */
  ApiKey = "api-key",
  /** An OAuth 2.0 client-credentials token. */
  OAuth2ClientCredentials = "oauth2-client-credentials",
  /** A client certificate. */
  MutualTls = "mtls",
}

/** One declared scheme: its name, and how it is carried. */
export type HttpSecurityScheme =
  | {
      readonly kind: HttpSecuritySchemeKind.Bearer;
      readonly name: string;
      readonly bearerFormat?: string;
    }
  | {
      readonly kind: HttpSecuritySchemeKind.ApiKey;
      readonly name: string;
      readonly header: string;
    }
  | {
      readonly kind: HttpSecuritySchemeKind.OAuth2ClientCredentials;
      readonly name: string;
      readonly tokenUrl: string;
      readonly scopes: Readonly<Record<string, string>>;
    }
  | { readonly kind: HttpSecuritySchemeKind.MutualTls; readonly name: string };

/** The schemes of `@HttpAuthenticator({ schemes: [HttpSecurity.bearer(), …] })`. */
export const HttpSecurity = {
  /** A bearer token (`name` default `"bearer"`; `bearerFormat`, e.g. `"JWT"`). */
  bearer(
    options: { readonly name?: string; readonly bearerFormat?: string } = {},
  ): HttpSecurityScheme {
    return {
      kind: HttpSecuritySchemeKind.Bearer,
      name: options.name ?? "bearer",
      ...(options.bearerFormat === undefined ? {} : { bearerFormat: options.bearerFormat }),
    };
  },
  /** A key in the header `header` (`name` default `"api-key"`). */
  apiKey(options: { readonly header: string; readonly name?: string }): HttpSecurityScheme {
    return {
      kind: HttpSecuritySchemeKind.ApiKey,
      name: options.name ?? "api-key",
      header: options.header,
    };
  },
  /** An OAuth 2.0 client-credentials token from `tokenUrl` (`name` default `"oauth2"`). */
  oauth2ClientCredentials(options: {
    readonly tokenUrl: string;
    readonly scopes?: Readonly<Record<string, string>>;
    readonly name?: string;
  }): HttpSecurityScheme {
    return {
      kind: HttpSecuritySchemeKind.OAuth2ClientCredentials,
      name: options.name ?? "oauth2",
      tokenUrl: options.tokenUrl,
      scopes: options.scopes ?? {},
    };
  },
  /** A client certificate (`name` default `"mtls"`). */
  mtls(options: { readonly name?: string } = {}): HttpSecurityScheme {
    return { kind: HttpSecuritySchemeKind.MutualTls, name: options.name ?? "mtls" };
  },
} as const;
