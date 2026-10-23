import { recordComponent } from "../components/metadata.js";
import type { ResolvedAll, Token } from "../components/injection.js";
import type { DtoClass } from "../dto/types.js";
import type { Usd } from "../units/index.js";
import type { A2AClient } from "./a2a-client.js";

/** The export an `@A2AAgent` calls (#398 PR 3): the receiving application and its start. */
export interface A2ATarget {
  /** The receiver's `@Application({ name })` — the envelope's `audience`. */
  readonly application: string;
  /** The receiver's exported `@WorkflowStart` name (`POST <url>/execute { start, … }`). */
  readonly start: string;
}

export interface A2AAgentConfig<
  TIn extends DtoClass = DtoClass,
  TOut extends DtoClass = DtoClass,
  D extends readonly Token[] = [],
> {
  /** `billing-desk-a2a-agent` — kebab-case, ending with `-a2a-agent` (`[name.kind-suffix]`). */
  readonly name: string;
  /** The remote agent's base URL (`<url>/execute`); the client gets it at construction. */
  readonly url: string;
  /** What it calls: the receiving application and its exported start (`[a2a.target-required]`). */
  readonly target: A2ATarget;
  /** What `execute(input)` takes: the target start's input, validated before it is sent. */
  readonly input: TIn;
  /** What `execute` gives back: the target's finish output, validated when it comes. */
  readonly output: TOut;
  /**
   * What one call costs by contract (Q6 c): the caller records the larger of it and the spend a
   * trusted peer's signed report gives — the price alone when there is no verified report.
   */
  readonly price?: Usd;
  /** Constructor dependencies, in order; checked against the constructor by the compiler. */
  readonly deps?: D;
}

/** What `@A2AAgent` records of its class. */
export interface A2AAgentMeta {
  readonly name: string;
  readonly url: string;
  readonly target: A2ATarget;
  readonly input: DtoClass;
  readonly output: DtoClass;
  readonly price?: Usd;
  readonly deps: readonly Token[];
}

/**
 * A remote workflow exposed over A2A, as a declared contract (#398 PR 3): `@A2AAgent({ name, url,
 * target, input, output, price?, deps })` on a class that `extends A2AClient<In, Out>`; list it in
 * `providers` and inject it into tools — `execute(input)` is typed by the contract, its input and
 * output validated, and `agboss describe --json` lists it among the application's consumed contracts.
 */
export function A2AAgent<
  TIn extends DtoClass,
  TOut extends DtoClass,
  const D extends readonly Token[] = [],
>(config: A2AAgentConfig<TIn, TOut, D>) {
  return <
    C extends new (...args: ResolvedAll<D>) => A2AClient<InstanceType<TIn>, InstanceType<TOut>>,
  >(
    value: C,
  ): C => {
    const meta: A2AAgentMeta = {
      name: config.name,
      url: config.url,
      target: config.target,
      input: config.input,
      output: config.output,
      ...(config.price === undefined ? {} : { price: config.price }),
      deps: config.deps ?? [],
    };
    recordComponent(value, { kind: "a2a-agent", meta });
    return value;
  };
}
