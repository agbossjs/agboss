import type { A2AAgentConfig } from "../a2a-decorator.js";
import { resolveReferences } from "../../environments/define-env.js";
import { Secret } from "../../environments/secret.js";

/**
 * What `@A2AAgent` declares of its address and headers, with every `defineEnv` reference read from
 * the application's environment (#1320): read once, on the client's first use inside the running
 * application — or at its construction when nothing in it is a reference. A missing variable is
 * named, never its value.
 */

/** The declared address and headers of a client. */
export interface DeclaredAgent {
  readonly url: A2AAgentConfig["url"];
  readonly allowedOrigins: NonNullable<A2AAgentConfig["allowedOrigins"]>;
  readonly headers: NonNullable<A2AAgentConfig["headers"]>;
}

/** A declared address and headers with every reference read. */
export interface ResolvedAgent {
  readonly url: string;
  readonly allowedOrigins: readonly string[];
  readonly headers: Readonly<Record<string, string>>;
}

const isReference = (value: unknown): boolean => typeof value !== "string";

/** Whether a declaration holds a reference: it can be read only with the application's environment. */
export const hasReferences = (declared: DeclaredAgent): boolean =>
  isReference(declared.url) ||
  declared.allowedOrigins.some(isReference) ||
  Object.values(declared.headers).some(isReference);

/** The text of a value read from a reference: a text, or a `Secret` revealed; `undefined` for an unset optional. */
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

/** `declared` with every reference read from `env`; a url or an origin that is no text is refused. */
export function resolvedAgentOf(
  agent: string,
  declared: DeclaredAgent,
  env: NodeJS.ProcessEnv,
): ResolvedAgent {
  const read = resolveReferences({ ...declared }, env, `A2A agent "${agent}"`);
  const url = textOf(read.url);
  if (url === undefined) throw new TypeError(`[a2a.url-invalid] ${agent}: its url is no text`);
  const origins = (read.allowedOrigins as readonly unknown[]).flatMap((each) => textOf(each) ?? []);
  const headers = Object.fromEntries(
    Object.entries(read.headers as Readonly<Record<string, unknown>>).flatMap(([name, value]) => {
      const text = headerOf(value);
      return text === undefined ? [] : [[name, text] as const];
    }),
  );
  return { url, allowedOrigins: origins, headers };
}

/** `layers` merged, header names compared without case: a later layer's header replaces an earlier one's. */
export function mergedHeaders(
  ...layers: readonly Readonly<Record<string, string>>[]
): Record<string, string> {
  const byName = new Map<string, readonly [string, string]>();
  for (const layer of layers)
    for (const [header, value] of Object.entries(layer))
      byName.set(header.toLowerCase(), [header, value]);
  return Object.fromEntries(byName.values());
}

/** A declared address and headers, read once with the environment of the moment of the first read. */
export class AgentConfig {
  readonly #agent: string;
  readonly #declared: DeclaredAgent;
  #resolved: ResolvedAgent | undefined;

  constructor(agent: string, declared: DeclaredAgent) {
    this.#agent = agent;
    this.#declared = declared;
  }

  /** Whether nothing in it is a reference: it can be read without an environment. */
  get isPlain(): boolean {
    return !hasReferences(this.#declared);
  }

  /** The declaration with its references read from `env` (once; later reads are the first one's). */
  read(env: NodeJS.ProcessEnv): ResolvedAgent {
    this.#resolved ??= resolvedAgentOf(this.#agent, this.#declared, env);
    return this.#resolved;
  }
}
