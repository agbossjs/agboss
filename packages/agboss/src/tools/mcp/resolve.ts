import { McpTransport, type McpServerConfig } from "../../config/mcp-server-config.js";
import { McpError } from "../../core/error-families/remote-errors.js";
import { resolveReferences } from "../../environments/define-env.js";
import { Secret } from "../../environments/secret.js";

export type Env = Readonly<Record<string, string | undefined>>;

/** A server's connection with every reference read: what a transport is made of. */
export type ResolvedMcpServer =
  | {
      readonly transport: McpTransport.Stdio;
      readonly command: string;
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
    }
  | {
      readonly transport: McpTransport.Http;
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly target?: McpServerConfig["target"];
    };

/** The variables of this process a stdio server inherits unless `inheritSystemEnv` is `false`. */
const SYSTEM_ENV = ["PATH", "HOME", "LANG", "TMPDIR"] as const;

/** A value read from a reference: a text, or a `Secret` to reveal; `undefined` for an unset optional one. */
const textOf = (value: unknown): string | undefined =>
  value instanceof Secret ? value.reveal() : typeof value === "string" ? value : undefined;

/** The text of a header value: a text, a secret, or a bearer token made of one. */
function headerOf(value: unknown): string | undefined {
  if (typeof value === "object" && value !== null && Reflect.get(value, "kind") === "bearer") {
    const token = textOf(Reflect.get(value, "secret"));
    return token === undefined ? undefined : `Bearer ${token}`;
  }
  return textOf(value);
}

/** The entries of `record` whose value is a text after `read`; the others (unset optionals) left out. */
function textsOf(
  record: Readonly<Record<string, unknown>> | undefined,
  read: (value: unknown) => string | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record ?? {}).flatMap(([key, value]) => {
      const text = read(value);
      return text === undefined ? [] : [[key, text] as const];
    }),
  );
}

/**
 * The connection of one server with every `defineEnv` reference in it read from `env` (once, at
 * start: a missing variable is named, never its value). A value that is no text is a contract
 * error of the declaration.
 */
export function resolvedServerOf(
  name: string,
  config: McpServerConfig,
  env: Env,
): ResolvedMcpServer {
  const resolved = resolveReferences({ ...config }, env, `MCP server "${name}"`);
  if (config.transport === McpTransport.Stdio) {
    const command = textOf(resolved.command);
    if (command === undefined || command === "") throw new McpError.Unavailable();
    const inherited =
      config.inheritSystemEnv === false
        ? {}
        : textsOf(Object.fromEntries(SYSTEM_ENV.map((key) => [key, env[key]])), textOf);
    const args = Array.isArray(resolved.args) ? (resolved.args as unknown[]) : [];
    return {
      transport: McpTransport.Stdio,
      command,
      args: args.flatMap((arg) => textOf(arg) ?? []),
      env: {
        ...inherited,
        ...textsOf(resolved.env as Record<string, unknown> | undefined, textOf),
      },
    };
  }
  const url = textOf(resolved.url);
  if (url === undefined || !URL.canParse(url)) throw new McpError.Unavailable();
  return {
    transport: McpTransport.Http,
    url,
    headers: textsOf(resolved.headers as Record<string, unknown> | undefined, headerOf),
    ...(config.target === undefined ? {} : { target: config.target }),
  };
}

/** `a` over `b`, header names compared without case: a later one replaces an earlier one's. */
export function mergedHeaders(
  ...layers: readonly Readonly<Record<string, string>>[]
): Record<string, string> {
  const byName = new Map<string, readonly [string, string]>();
  for (const layer of layers)
    for (const [header, value] of Object.entries(layer))
      byName.set(header.toLowerCase(), [header, value]);
  return Object.fromEntries(byName.values());
}
