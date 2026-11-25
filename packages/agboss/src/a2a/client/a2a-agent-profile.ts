import type { Class } from "../../components/injection.js";
import { AgentConfig } from "./a2a-agent-config.js";
import {
  contractOfMeta,
  type A2AClientContract,
  type A2AClientOptions,
} from "./a2a-client-options.js";
import type { A2AClientServices } from "./a2a-client-services.js";

/**
 * What an `@A2AAgent` is under the selected profiles (#1318c, its `a2aAgents` shelf): a client is made by
 * the container with the class\'s declaration, so what it calls — its contract with the price and the call
 * bound, its address and its origins — is asked of the application\'s carrier of the components\' options
 * when it is used inside an execution. Outside one, or with the options a developer gave in code, it is
 * what is declared.
 */
export class AgentProfile {
  readonly #agent: string;
  readonly #options: A2AClientOptions;
  readonly #class: Class;
  readonly #configs = new WeakMap<object, AgentConfig>();

  constructor(agentClass: Class, agent: string, options: A2AClientOptions) {
    this.#class = agentClass;
    this.#agent = agent;
    this.#options = options;
  }

  /** The contract: the declared one, or the class\'s with the profiles\' price and bound. */
  contractOf(
    declared: A2AClientContract | undefined,
    services: A2AClientServices | undefined,
  ): A2AClientContract | undefined {
    if (this.#options.contract !== undefined) return declared;
    const meta = services?.options?.a2aAgentMetaOf(this.#class);
    return meta === undefined ? declared : contractOfMeta(meta);
  }

  /** The address and headers: the declared ones, or the profiles\' address and origins over them. */
  configOf(declared: AgentConfig, services: A2AClientServices | undefined): AgentConfig {
    const carrier = services?.options;
    const meta = carrier?.a2aAgentMetaOf(this.#class);
    if (carrier === undefined || meta === undefined || this.#options.url !== undefined)
      return declared;
    const known = this.#configs.get(carrier);
    if (known !== undefined) return known;
    const made = new AgentConfig(this.#agent, {
      url: meta.url,
      allowedOrigins: this.#options.allowedOrigins ?? meta.allowedOrigins ?? [],
      headers: meta.headers ?? {},
    });
    this.#configs.set(carrier, made);
    return made;
  }
}
