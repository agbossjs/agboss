import type { HeaderSecretTemplate } from "../environments/define-env.js";
import type { EnvRef, OptionalSecretRef, SecretRef } from "../environments/env-ref.js";
import type { Milliseconds, Usd } from "../units/index.js";

/** How an MCP server is reached. */
export enum McpTransport {
  /** A process the application starts, spoken to over its stdin and stdout. */
  Stdio = "stdio",
  /** A Streamable HTTP endpoint. */
  Http = "http",
}

/** The AGBoss application and `@McpEndpoint` an MCP server is, for `describe` and the mesh's audience. */
export interface McpServerTarget {
  readonly application: string;
  readonly endpoint: string;
}

/** What `@McpServer` takes whatever the transport. */
export interface McpServerCommon {
  /** The AGBoss application and endpoint it is, when it is one. */
  readonly target?: McpServerTarget;
  /** How long one call may run (default 30 s). */
  readonly timeout?: Milliseconds;
  /** What one call costs by contract, charged to the calling step; default none. */
  readonly costPerCall?: Usd;
  /** At most this many calls at once, the rest wait (`1` for a stateful single-page server). */
  readonly maxConcurrentCalls?: number;
}

/** A server the application starts as a process. */
export interface McpStdioConfig extends McpServerCommon {
  readonly transport: McpTransport.Stdio;
  readonly command: string | EnvRef<string>;
  readonly args?: readonly (string | EnvRef<string>)[];
  /** The server's environment; an entry that resolves to `undefined` is left out. */
  readonly env?: Readonly<
    Record<string, string | EnvRef<string | undefined> | SecretRef | OptionalSecretRef>
  >;
  /** Whether `PATH`, `HOME`, `LANG` and `TMPDIR` of this process are passed on (default `true`). */
  readonly inheritSystemEnv?: boolean;
}

/** A server reached over Streamable HTTP. */
export interface McpHttpConfig extends McpServerCommon {
  readonly transport: McpTransport.Http;
  readonly url: string | EnvRef<string>;
  readonly headers?: Readonly<
    Record<string, string | EnvRef<string> | SecretRef | HeaderSecretTemplate>
  >;
}

/** An MCP server connection: secrets are references (`defineEnv`), read once when the application starts. */
export type McpServerConfig = McpStdioConfig | McpHttpConfig;
