import { recordComponent } from "../components/metadata.js";
import type { ResolvedAll, Token } from "../components/injection.js";
import type { A2AClient } from "./a2a-client.js";

export interface A2AAgentConfig<D extends readonly Token[] = []> {
  readonly name: string;
  /** The remote agent's base URL (`<url>/execute`); the client gets it at construction. */
  readonly url: string;
  /** Constructor dependencies, in order; checked against the constructor by the compiler. */
  readonly deps?: D;
}

/**
 * A remote workflow exposed over A2A, as a provider: `@A2AAgent({ name, url, deps })` on a class
 * that `extends A2AClient`; register it in `@Workflow({ providers })` and inject it into tools.
 */
export function A2AAgent<const D extends readonly Token[] = []>(config: A2AAgentConfig<D>) {
  return <C extends new (...args: ResolvedAll<D>) => A2AClient>(value: C): C => {
    recordComponent(value, {
      kind: "a2a-agent",
      meta: { name: config.name, url: config.url, deps: config.deps ?? [] },
    });
    return value;
  };
}
