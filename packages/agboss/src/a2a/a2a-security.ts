/**
 * How an A2A agent's callers authenticate (#808, spec §4.5): declared on `@A2AExpose({ security })`
 * and written into its Agent Card's `securitySchemes` and `securityRequirements` (any one of them
 * is enough). It only describes: the listener's caller resolver enforces it.
 */

/** How a scheme is carried. */
export enum A2ASecuritySchemeKind {
  /** `Authorization: Bearer <token>`. */
  Bearer = "bearer",
  /** A key in a request header. */
  ApiKey = "api-key",
  /** An OAuth 2.0 client-credentials token. */
  OAuth2ClientCredentials = "oauth2-client-credentials",
  /** A client certificate. */
  MutualTls = "mtls",
}

/** One declared scheme: its name in the card, and how it is carried. */
export type A2ASecurityScheme =
  | {
      readonly kind: A2ASecuritySchemeKind.Bearer;
      readonly name: string;
      readonly bearerFormat?: string;
    }
  | { readonly kind: A2ASecuritySchemeKind.ApiKey; readonly name: string; readonly header: string }
  | {
      readonly kind: A2ASecuritySchemeKind.OAuth2ClientCredentials;
      readonly name: string;
      readonly tokenUrl: string;
      readonly scopes: Readonly<Record<string, string>>;
    }
  | { readonly kind: A2ASecuritySchemeKind.MutualTls; readonly name: string };

/** The schemes of `@A2AExpose({ security: [A2ASecurity.bearer(), …] })`. */
export const A2ASecurity = {
  /** A bearer token (`name` default `"bearer"`; `bearerFormat`, e.g. `"JWT"`). */
  bearer(
    options: { readonly name?: string; readonly bearerFormat?: string } = {},
  ): A2ASecurityScheme {
    return {
      kind: A2ASecuritySchemeKind.Bearer,
      name: options.name ?? "bearer",
      ...(options.bearerFormat === undefined ? {} : { bearerFormat: options.bearerFormat }),
    };
  },
  /** A key in the header `header` (`name` default `"api-key"`). */
  apiKey(options: { readonly header: string; readonly name?: string }): A2ASecurityScheme {
    return {
      kind: A2ASecuritySchemeKind.ApiKey,
      name: options.name ?? "api-key",
      header: options.header,
    };
  },
  /** An OAuth 2.0 client-credentials token from `tokenUrl` (`name` default `"oauth2"`). */
  oauth2ClientCredentials(options: {
    readonly tokenUrl: string;
    readonly scopes?: Readonly<Record<string, string>>;
    readonly name?: string;
  }): A2ASecurityScheme {
    return {
      kind: A2ASecuritySchemeKind.OAuth2ClientCredentials,
      name: options.name ?? "oauth2",
      tokenUrl: options.tokenUrl,
      scopes: options.scopes ?? {},
    };
  },
  /** A client certificate (`name` default `"mtls"`). */
  mtls(options: { readonly name?: string } = {}): A2ASecurityScheme {
    return { kind: A2ASecuritySchemeKind.MutualTls, name: options.name ?? "mtls" };
  },
} as const;
