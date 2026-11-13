import { recordComponent } from "../components/metadata.js";
import type { ResolvedAll, Token } from "../components/injection.js";
import type { DtoClass } from "../dto/types.js";
import type { Usd } from "../units/index.js";
import type { A2AClient } from "./client/a2a-client.js";
import type { A2AMesh } from "./client/a2a-guard-errors.js";

/**
 * Whom an `@A2AAgent` calls (#809, design §4.4): an AGBoss application, named for `describe`,
 * federation and the mesh's audience, the skill — the receiver's exported start — that a message
 * names, and the skill's finishes the client takes (#916). All optional: a foreign agent has no
 * application, an agent with one skill needs no name for it, a client of every finish lists none.
 */
export interface A2ATarget {
  /** The receiver's `@Application({ name })`, when it is an AGBoss application. */
  readonly application?: string;
  /** The agent's skill id (an AGBoss application's exported `@WorkflowStart` name; was `start`). */
  readonly skill?: string;
  /**
   * The skill's finishes a typed client takes (#916, `@WorkflowFinish` names): its `output` must
   * accept each one's, and a task that ends at another is `A2AUnexpectedFinishError`. Unset: every
   * finish of the skill — the output must accept them all (`[a2a.schema-mismatch]` otherwise).
   */
  readonly finishes?: readonly string[];
}

/**
 * What `@A2AAgent({ … })` takes: the agent's parts beside its DTOs, and either both `input` and
 * `output` (a typed agent: `execute(input)` sends `input` and gives `output`, both validated) or
 * neither (an untyped one: `send(message)` only).
 */
export type A2AAgentConfig<
  TIn extends DtoClass = DtoClass,
  TOut extends DtoClass = DtoClass,
  D extends readonly Token[] = [],
> = {
  /** `billing-desk-a2a-agent` — kebab-case, ending with `-a2a-agent` (`[name.kind-suffix]`). */
  readonly name: string;
  /** The agent's base URL; its card is read from `<url>/.well-known/agent-card.json`. */
  readonly url: string;
  /** Whom it calls: an AGBoss application and its skill (both optional). */
  readonly target?: A2ATarget;
  /**
   * What one call costs by contract, charged to the calling step's budgets — the only spend known
   * of a foreign agent; an AGBoss peer's verified report may raise it (the mesh extension).
   */
  readonly price?: Usd;
  /**
   * Whether the agent must declare the AGBoss mesh extension (the call chain's loop and hop limits,
   * the caller's budget and deadline, the signed spend): default `A2AMesh.Required` with a
   * `target.application`, `A2AMesh.IfSupported` without — a foreign agent is called without it.
   */
  readonly mesh?: A2AMesh;
  /**
   * Origins besides the `url`'s that the agent's card may name for its interfaces
   * (`["https://rpc.billing.example"]`); any other is refused and gets no request (#809).
   */
  readonly allowedOrigins?: readonly string[];
  /** Constructor dependencies, in order; checked against the constructor by the compiler. */
  readonly deps?: D;
} & (
  | {
      /** What `execute(input)` takes: the skill's input, validated before it is sent. */
      readonly input: TIn;
      /** What `execute` gives back: the task's output, validated when it comes. */
      readonly output: TOut;
    }
  | {
      readonly input?: undefined;
      readonly output?: undefined;
    }
);

/** What `@A2AAgent` records of its class. */
export interface A2AAgentMeta {
  readonly name: string;
  readonly url: string;
  readonly target?: A2ATarget;
  readonly input?: DtoClass;
  readonly output?: DtoClass;
  readonly price?: Usd;
  readonly mesh?: A2AMesh;
  readonly allowedOrigins?: readonly string[];
  readonly deps: readonly Token[];
}

/**
 * An A2A v1.0 agent as a declared contract (#809): `@A2AAgent({ name, url, target?, input?, output?,
 * price?, deps })` on a class that `extends A2AClient<In, Out>` (`A2AClient` untyped); list it in
 * `providers` and inject it into tools — `execute(input)` is typed by the contract, `send(message)`
 * takes anything. A typed agent of an AGBoss application is listed by `agboss describe --json`
 * among the application's consumed contracts.
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
      ...(config.target === undefined ? {} : { target: config.target }),
      ...(config.input === undefined ? {} : { input: config.input, output: config.output }),
      ...(config.price === undefined ? {} : { price: config.price }),
      ...(config.mesh === undefined ? {} : { mesh: config.mesh }),
      ...(config.allowedOrigins === undefined
        ? {}
        : { allowedOrigins: [...config.allowedOrigins] }),
      deps: config.deps ?? [],
    };
    recordComponent(value, { kind: "a2a-agent", meta });
    return value;
  };
}
