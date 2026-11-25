import type { Part } from "@a2a-js/sdk";
import { markBusinessKeyWriter } from "../../components/container/fenced-reach.js";
import { validate } from "../../dto/schema.js";
import { currentFrame } from "../../flow/context/frame.js";
import { lazyLoad, SystemClock, type Clock } from "../../infrastructure/clock.js";
import { accept } from "./a2a-accept.js";
import { CardCache, type Wire } from "./a2a-card-cache.js";
import { AgentConfig, type ResolvedAgent } from "./a2a-agent-config.js";
import { AgentProfile } from "./a2a-agent-profile.js";
import { boundCallOf, stepSignalOf } from "./a2a-call-bounds.js";
import { cardCacheOf } from "./a2a-client-cache.js";
import { taskCancelOf, taskReadOf, waitedOf, type WireOf } from "./a2a-client-reads.js";
import {
  agentNameOf,
  allowedOriginsOfClass,
  headersOfClass,
  checkedCall,
  contractOfClass,
  urlOf,
  typedContractOf,
  type A2AClientCall,
  type A2AClientContract,
  type A2AClientOptions,
  type A2ATaskResult,
  type Settled,
} from "./a2a-client-options.js";
import {
  a2aClientServicesOf,
  storedFileReaderOf,
  type A2AClientServices,
} from "./a2a-client-services.js";
import {
  chargedOf,
  recordRefused,
  refusedCall,
  settledChargeOf,
  settledPeerOf,
} from "./a2a-charges.js";
import { activatedMeshOf } from "./a2a-activation.js";
import { callPeerOf } from "./a2a-call-peer.js";
import { outputOf, untypedResultOf } from "./a2a-outcome.js";
import { inputPartsOf, partsOf } from "./a2a-parts.js";
import { a2aCardOf } from "./a2a-card-map.js";
import { a2aTaskOf } from "./a2a-public-map.js";
import type { A2AAgentCard, A2AMessageInput, A2ATask } from "../a2a-types.js";
import type { A2ADownloadOptions, FileDto } from "./a2a-download.js";

/**
 * Calls an A2A v1.0 agent (#809) — another AGBoss application or any compliant agent — on the
 * official SDK. Subclass it with `@A2AAgent({ name, url, headers?, timeout?, target?, input?, output?, costPerCall?, deps })`
 * and inject it like any provider. The agent's card is read on first use and checked (an A2A 1.0
 * interface on the client's origins, the skill, the skill's schemas); the message is accepted with
 * `returnImmediately` through `OutboundCalls` inside an execution (an ambiguous send reconciled,
 * never resent blindly to a foreign agent), then the task is waited for by stream or poll, up to
 * the deadline.
 */
export class A2AClient<TIn extends object = object, TOut extends object = object> {
  readonly #declared: A2AClientContract | undefined;
  readonly #profile: AgentProfile;

  readonly #agent: string;
  readonly #options: A2AClientOptions;
  readonly #config: AgentConfig;
  readonly #filePolicy: A2AClientOptions["filePolicy"];
  #cards: CardCache | undefined;
  readonly #wired: WireOf = (signal) => this.#wire(signal);

  constructor(options: A2AClientOptions = {}) {
    this.#options = options;
    this.#declared = options.contract ?? contractOfClass(new.target);
    this.#filePolicy = options.filePolicy;
    this.#agent = agentNameOf(new.target, new.target.name);
    this.#profile = new AgentProfile(new.target, this.#agent, options);
    this.#config = new AgentConfig(this.#agent, {
      url: options.url ?? urlOf(new.target, new.target.name),
      allowedOrigins: options.allowedOrigins ?? allowedOriginsOfClass(new.target),
      headers: headersOfClass(new.target),
    });
    // a plain address is checked now (a malformed one never starts); references are read with the application's environment
    if (this.#config.isPlain) this.#cardCache();
  }

  /** What it calls and how much a call costs: its `@A2AAgent` as the profiles leave it in an application, or the `contract` option. */
  get contract(): A2AClientContract | undefined {
    return this.#profile.contractOf(this.#declared, this.#services());
  }

  /** The agent's base URL; a `defineEnv` reference is read from the application's environment on first use. */
  get url(): string {
    return this.#resolve().url;
  }

  /** The declared address and headers with their references read, once (the running application's environment, else the process's). */
  #resolve(): ResolvedAgent {
    const services = this.#services();
    return this.#profile.configOf(this.#config, services).read(services?.env ?? process.env);
  }

  /** The agent's card cache: built with the first use, once its address is known. */
  #cardCache(): CardCache {
    if (this.#cards !== undefined) return this.#cards;
    this.#cards = cardCacheOf({
      agent: this.#agent,
      contract: this.contract,
      resolved: this.#resolve(),
      options: this.#options,
      dynamicHeaders: async () => await this.getHeaders(),
    });
    return this.#cards;
  }

  /**
   * Headers added to every request, read per request (a fresh token), over the declared `headers`
   * and the `headers` option, names compared without case; the framework's own header
   * (`X-AGBoss-Mesh`) is set last and never replaced. Override in a subclass: sync or async.
   */
  protected getHeaders(): Record<string, string> | Promise<Record<string, string>> {
    return {};
  }

  /** The agent's card, checked against the client's contract (fetched once per `cardTtl`). */
  public async agentCard(call: Pick<A2AClientCall, "signal"> = {}): Promise<A2AAgentCard> {
    return a2aCardOf((await this.#wire(stepSignalOf(call))).checked.card);
  }

  /**
   * Runs the agent's skill with a typed input (#809 AC1): `input` validated by the input DTO and sent
   * as one data part (text for `WorkflowStartTextDto`), the COMPLETED task's artifact validated by
   * the output DTO. FAILED with an AGBoss mesh limit throws that limit; FAILED / REJECTED
   * `A2ATaskFailedError`, CANCELED `A2ATaskCancelledError`, INPUT_REQUIRED `A2ATaskInterruptedError`.
   * A client without both DTOs throws `[a2a.no-contract]`.
   */
  public async execute(input: TIn, given: A2AClientCall = {}): Promise<TOut> {
    const call = boundCallOf(given, this.contract?.timeout);
    const contract = typedContractOf(this.constructor.name, this.contract);
    const read = storedFileReaderOf(this.#services());
    const parts = await inputPartsOf(contract.input, validate(contract.input, input), read);
    const { task, accepted, peer } = await this.#call(parts, undefined, call);
    // Stryker disable next-line OptionalChaining: equivalent: `typedContractOf` above refused a client without its contract, so it is there
    const finishes = this.contract?.finishes;
    const raw = outputOf(this.#agent, contract.output, task, accepted.message, finishes, peer.mesh);
    // the contract's output DTO is the class's `TOut` (the decorator ties them)
    return validate(contract.output, raw) as TOut;
  }

  /**
   * Sends an untyped message (#809 AC1) — a text, `{ data }`, or the parts — and returns what the
   * agent gave: a COMPLETED or interrupted task (INPUT_REQUIRED: `reply(taskId, …)` continues it),
   * or a stateless message. FAILED, REJECTED and CANCELED throw as for `execute`.
   */
  public async send(message: A2AMessageInput, call: A2AClientCall = {}): Promise<A2ATaskResult> {
    return this.#untyped(message, undefined, call);
  }

  /** Continues a task that waits for input (INPUT_REQUIRED) with `answer`, as `send` does. */
  public async reply(
    taskId: string,
    answer: A2AMessageInput,
    call: A2AClientCall = {},
  ): Promise<A2ATaskResult> {
    return this.#untyped(answer, taskId, call);
  }

  /** One untyped call: its files read first when stored (D7: a rejection, never a throw). */
  async #untyped(
    input: A2AMessageInput,
    taskId: string | undefined,
    call: A2AClientCall,
  ): Promise<A2ATaskResult> {
    const parts = await partsOf(input, storedFileReaderOf(this.#services()));
    const bound = boundCallOf(call, this.contract?.timeout);
    return untypedResultOf(await this.#call(parts, taskId, bound), this.#agent);
  }

  public async downloadFile(file: FileDto, options?: A2ADownloadOptions): Promise<Uint8Array> {
    const using = [this.#cardCache().fetch, this.#clock(), this.#filePolicy] as const;
    const bounds = await lazyLoad(import("./a2a-download-bounds.js"));
    return await bounds.downloadedBy(this, file, options, using);
  }

  /** The task as the agent has it now. */
  public async getTask(taskId: string, call: Pick<A2AClientCall, "signal"> = {}): Promise<A2ATask> {
    return a2aTaskOf(await taskReadOf(this.#agent, this.#wired, taskId, call));
  }

  /** Asks the agent to cancel the task (was `cancel(threadId)`): the task as it answers. */
  public async cancel(taskId: string, call: Pick<A2AClientCall, "signal"> = {}): Promise<A2ATask> {
    return a2aTaskOf(await taskCancelOf(this.#agent, this.#wired, taskId, call));
  }

  /** The application's services in an execution; `undefined` outside one. */
  #services(): A2AClientServices | undefined {
    const frame = currentFrame();
    return frame === undefined
      ? undefined
      : a2aClientServicesOf(frame.execution.tenant.application);
  }

  /** The application's clock in an execution, else the system's. */
  #clock(): Clock {
    return this.#services()?.clock ?? new SystemClock();
  }

  /** The card and its SDK client: fetched, checked, kept for `cardTtl` on the app's clock. */
  #wire(signal: AbortSignal | undefined): Promise<Wire> {
    return this.#cardCache().wireOf(this.#clock(), signal);
  }

  /**
   * One call: the card, the accept (its price charged then), the wait (a report's excess then) —
   * both charged on every pass under the call's own ledger identity, so a takeover that replays the
   * accept charges each once (#810 AC5). A call the agent refused at the accept (`REJECTED` with a
   * mesh limit, #849) charges neither, on any pass, while the agent's task says so (`refusedCall`).
   */
  async #call(
    parts: readonly Part[],
    taskId: string | undefined,
    call: A2AClientCall,
  ): Promise<Settled> {
    const key = checkedCall(this.#agent, call, this.contract?.costPerCall);
    const wire = await this.#wire(call.signal);
    const { activation, skill } = activatedMeshOf(wire, {
      agent: this.#agent,
      contract: this.contract,
      seam: this.#services()?.mesh,
    });
    const clock = this.#clock();
    const accepted = await accept({
      agent: this.#agent,
      url: this.url,
      // #860: a direct-reply skill's messageId is deduplicated for its message retention only
      peer: callPeerOf(wire.checked.card, wire.checked.peer, skill),
      client: wire.client,
      clock,
      parts,
      skill,
      contextId: call.contextId,
      taskId,
      key,
      sign: (message) => activation.sign(message),
      meshEchoOf: wire.meshEchoOf,
      signal: call.signal,
    });
    const price = this.contract?.costPerCall;
    const charged = chargedOf(accepted, clock);
    if (accepted.isRefused) {
      return refusedCall({
        agent: this.#agent,
        taskId: accepted.taskId,
        read: (taskId) => taskReadOf(this.#agent, this.#wired, taskId, call),
        charge: () => {
          activation.charge(price, charged);
        },
        record: () => {
          recordRefused(activation, accepted, this.contract?.application ?? this.#agent);
        },
      });
    }
    activation.charge(price, charged);
    const task = await waitedOf({ agent: this.#agent, wire, accepted, clock, call });
    // #860: a direct reply settles on its message (its run report rides its metadata)
    activation.settle(task ?? accepted.message, price, settledChargeOf(charged, clock));
    const peer = settledPeerOf(activation, accepted, this.contract?.application ?? this.#agent);
    return { accepted, task, peer };
  }
}

// a component that reaches a client sends under a call key of the idempotency secret (#1317d)
markBusinessKeyWriter(A2AClient);
