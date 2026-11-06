import type { AgentCard, Part, Task } from "@a2a-js/sdk";
import { validate } from "../../dto/schema.js";
import { currentFrame } from "../../flow/context/frame.js";
import { SystemClock, type Clock } from "../../infrastructure/clock.js";
import { accept } from "./a2a-accept.js";
import type { Accepted } from "./a2a-message.js";
import { skillOf, type A2ARemotePeer } from "./a2a-card.js";
import { CardCache, type Wire } from "./a2a-card-cache.js";
import {
  agentNameOf,
  allowedOriginsOfClass,
  checkedCallKey,
  contractOfClass,
  deadlineOf,
  urlOf,
  typedContractOf,
  type A2AClientCall,
  type A2AClientContract,
  type A2AClientOptions,
  type A2ATaskResult,
} from "./a2a-client-options.js";
import { A2AClientOperation } from "./a2a-client-errors.js";
import { a2aClientServicesOf, type A2AClientServices } from "./a2a-client-services.js";
import { A2AMesh } from "./a2a-guard-errors.js";
import { chargedOf, settledPeerOf } from "./a2a-charges.js";
import { AGBOSS_MESH, type A2AMeshActivation } from "./a2a-mesh-seam.js";
import { originPolicyOf } from "./a2a-origins.js";
import { failureOf, isInterrupted, outputOf } from "./a2a-outcome.js";
import {
  answerPartsOf,
  dataOf,
  inputPartsOf,
  partsOf,
  textOf,
  type A2AMessageInput,
} from "./a2a-parts.js";
import { waitForTask } from "./a2a-wait.js";
import { wireErrorOf } from "./a2a-wire-errors.js";

/** One call's settled answer. */
interface Settled {
  readonly accepted: Accepted;
  readonly task: Task | undefined;
  readonly peer: A2ARemotePeer;
}

/**
 * Calls an A2A v1.0 agent (#809) — another AGBoss application or any compliant agent — on the
 * official SDK. Subclass it with `@A2AAgent({ name, url, target?, input?, output?, price?, deps })`
 * and inject it like any provider. The agent's card is read on first use and checked (an A2A 1.0
 * interface on the client's origins, the skill, the skill's schemas); the message is accepted with
 * `returnImmediately` through `OutboundCalls` inside an execution (an ambiguous send reconciled,
 * never resent blindly to a foreign agent), then the task is waited for by stream or poll, up to
 * the deadline.
 */
export class A2AClient<TIn extends object = object, TOut extends object = object> {
  readonly url: string;

  /** What it calls and how much a call costs: the class's `@A2AAgent`, or the `contract` option. */
  readonly contract: A2AClientContract | undefined;

  readonly #agent: string;
  readonly #cards: CardCache;

  constructor(options: A2AClientOptions = {}) {
    this.url = options.url ?? urlOf(new.target, new.target.name);
    this.contract = options.contract ?? contractOfClass(new.target);
    this.#agent = agentNameOf(new.target, new.target.name);
    const allowed = options.allowedOrigins ?? allowedOriginsOfClass(new.target);
    const fixed = options.headers ?? {};
    this.#cards = new CardCache({
      url: this.url,
      agent: this.#agent,
      contract: this.contract,
      policy: originPolicyOf(this.#agent, this.url, allowed),
      fetcher: options.fetcher ?? fetch,
      headersOf: async () => ({ ...fixed, ...(await this.getHeaders()) }),
      ttl: options.cardTtl,
    });
  }

  /** Extra headers per request (e.g. a fresh token); override in a subclass. */
  protected getHeaders(): Promise<Record<string, string>> {
    return Promise.resolve({});
  }

  /** The agent's card, checked against the client's contract (fetched once per `cardTtl`). */
  public async agentCard(call: Pick<A2AClientCall, "signal"> = {}): Promise<AgentCard> {
    return (await this.#wire(call.signal)).checked.card;
  }

  /**
   * Runs the agent's skill with a typed input (#809 AC1): `input` validated by the input DTO and sent
   * as one data part (text for `WorkflowStartTextDto`), the COMPLETED task's artifact validated by
   * the output DTO. FAILED with an AGBoss mesh limit throws that limit; FAILED / REJECTED
   * `A2ATaskFailedError`, CANCELED `A2ATaskCanceledError`, INPUT_REQUIRED `A2ATaskInterruptedError`.
   * A client without both DTOs throws `[a2a.no-contract]`.
   */
  public async execute(input: TIn, call: A2AClientCall = {}): Promise<TOut> {
    const contract = typedContractOf(this.constructor.name, this.contract);
    const parts = inputPartsOf(contract.input, validate(contract.input, input));
    const { task, accepted } = await this.#call(parts, undefined, call);
    const raw = outputOf(this.#agent, contract.output, task, accepted.message);
    // the contract's output DTO is the class's `TOut` (the decorator ties them)
    return validate(contract.output, raw) as TOut;
  }

  /**
   * Sends an untyped message (#809 AC1) — a text, `{ data }`, or the parts — and returns what the
   * agent gave: a COMPLETED or interrupted task (INPUT_REQUIRED: `reply(taskId, …)` continues it),
   * or a stateless message. FAILED, REJECTED and CANCELED throw as for `execute`.
   */
  public async send(message: A2AMessageInput, call: A2AClientCall = {}): Promise<A2ATaskResult> {
    return this.#resultOf(await this.#call(partsOf(message), undefined, call));
  }

  /** Continues a task that waits for input (INPUT_REQUIRED) with `answer`, as `send` does. */
  public async reply(
    taskId: string,
    answer: A2AMessageInput,
    call: A2AClientCall = {},
  ): Promise<A2ATaskResult> {
    return this.#resultOf(await this.#call(partsOf(answer), taskId, call));
  }

  /** The task as the agent has it now. */
  public getTask(taskId: string, call: Pick<A2AClientCall, "signal"> = {}): Promise<Task> {
    return this.#read(A2AClientOperation.GetTask, call.signal, (client, options) =>
      client.getTask({ tenant: "", id: taskId }, options),
    );
  }

  /** Asks the agent to cancel the task (was `cancel(threadId)`): the task as it answers. */
  public cancel(taskId: string, call: Pick<A2AClientCall, "signal"> = {}): Promise<Task> {
    return this.#read(A2AClientOperation.CancelTask, call.signal, (client, options) =>
      client.cancelTask({ tenant: "", id: taskId, metadata: undefined }, options),
    );
  }

  /** One read of the agent on its SDK client, its error translated (codes only). */
  async #read<T>(
    operation: A2AClientOperation,
    signal: AbortSignal | undefined,
    read: (client: Wire["client"], options: { signal?: AbortSignal }) => Promise<T>,
  ): Promise<T> {
    const { client } = await this.#wire(signal);
    try {
      return await read(client, signal === undefined ? {} : { signal });
    } catch (error) {
      throw wireErrorOf(error, this.#agent, operation, signal);
    }
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
    return this.#cards.wireOf(this.#clock(), signal);
  }

  /** The mesh of a call to the card's agent, and the skill the call names. */
  #activated(wire: Wire): { readonly activation: A2AMeshActivation; readonly skill?: string } {
    const { card, peer } = wire.checked;
    const application = this.contract?.application;
    const skill = skillOf(card, {
      agent: this.#agent,
      skill: this.contract?.skill,
      input: undefined,
      output: undefined,
    });
    const mesh =
      this.contract?.mesh ?? (application === undefined ? A2AMesh.IfSupported : A2AMesh.Required);
    const seam = this.#services()?.mesh ?? AGBOSS_MESH;
    const activation = seam.activate(card, peer, { agent: this.#agent, application, skill, mesh });
    return skill === undefined ? { activation } : { activation, skill };
  }

  /**
   * One call: the card, the accept (its price charged then), the wait (a report's excess then) —
   * both charged on every pass under the call's own ledger identity, so a takeover that replays the
   * accept charges each once (#810 AC5).
   */
  async #call(
    parts: readonly Part[],
    taskId: string | undefined,
    call: A2AClientCall,
  ): Promise<Settled> {
    const key = checkedCallKey(this.#agent, call.key);
    const wire = await this.#wire(call.signal);
    const { activation, skill } = this.#activated(wire);
    const clock = this.#clock();
    const accepted = await accept({
      agent: this.#agent,
      url: this.url,
      peer: wire.checked.peer,
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
    const price = this.contract?.price;
    const charged = chargedOf(accepted, clock);
    activation.charge(price, charged);
    const task = await this.#waited(wire, accepted, clock, call);
    activation.settle(task, price, charged);
    const peer = settledPeerOf(activation, accepted, this.contract?.application ?? this.#agent);
    return { accepted, task, peer };
  }

  /** The accepted task, waited for until it settles; `undefined` for a stateless answer. */
  async #waited(
    wire: Wire,
    accepted: Accepted,
    clock: Clock,
    call: A2AClientCall,
  ): Promise<Task | undefined> {
    if (accepted.taskId === undefined) return undefined;
    return waitForTask({
      agent: this.#agent,
      client: wire.client,
      clock,
      taskId: accepted.taskId,
      task: accepted.task,
      isStreaming: wire.checked.card.capabilities?.streaming === true,
      deadlineAt: deadlineOf(clock, call),
      signal: call.signal,
      onEvent: call.onEvent,
    });
  }

  /** An untyped call's result: an interrupted task given back, any other failure thrown. */
  #resultOf(settled: Settled): A2ATaskResult {
    const { task, peer } = settled;
    const { message } = settled.accepted;
    const failure =
      task === undefined || isInterrupted(task) ? undefined : failureOf(task, this.#agent);
    if (failure !== undefined) throw failure;
    const answer = task ?? message;
    const parts = answer === undefined ? [] : answerPartsOf(answer);
    return { task, message, text: textOf(parts), data: dataOf(parts)?.value, peer };
  }
}
