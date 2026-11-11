import type { Message, StreamResponse, Task } from "@a2a-js/sdk";
import { nestedFileFieldsOf } from "../files/a2a-file.dto.js";
import type { A2AReceivedFile } from "./a2a-client-files.js";
import { ComponentError, componentOf } from "../../components/metadata.js";
import type { DtoClass } from "../../dto/types.js";
import { currentFrame } from "../../flow/context/frame.js";
import type { Clock } from "../../infrastructure/clock.js";
import type { Milliseconds, Usd } from "../../units/index.js";
import type { A2ARemotePeer } from "./a2a-card.js";
import type { A2AMesh } from "./a2a-guard-errors.js";

/**
 * What an `A2AClient` is built with and called with (#809), and what `@A2AAgent` recorded of its
 * class — read once, at construction.
 */

/**
 * What an `A2AClient` calls (#809): the skill, what `execute` sends and gets back, the price of one
 * call and — for an AGBoss peer — its application. `@A2AAgent`'s, or a standalone client's
 * `contract` option. Without `input` / `output` the client is untyped: `send`, not `execute`.
 */
export interface A2AClientContract {
  /** The receiver's `@Application({ name })`, when it is an AGBoss application. */
  readonly application?: string;
  /** The agent's skill (an AGBoss application's exported start); optional with one skill. */
  readonly skill?: string;
  /** The skill's finishes the client takes (#916); unset: every finish of the skill. */
  readonly finishes?: readonly string[];
  readonly input?: DtoClass;
  readonly output?: DtoClass;
  /** What one call costs, charged to the calling step's budgets (the mesh's report may raise it). */
  readonly price?: Usd;
  /** Whether the agent must declare the AGBoss mesh; default `Required` with an `application`. */
  readonly mesh?: A2AMesh;
}

export interface A2AClientOptions {
  /** The agent's base URL (its card at `<url>/.well-known/agent-card.json`); default: `@A2AAgent({ url })`. */
  readonly url?: string;
  /** Headers of every request, before `getHeaders()`'s. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Pluggable fetch implementation (tests, proxies). */
  readonly fetcher?: typeof fetch;
  /** The contract of a client built without `@A2AAgent` (a script, a test). */
  readonly contract?: A2AClientContract;
  /** How long the agent's card is kept before it is fetched again; default 5 minutes. */
  readonly cardTtl?: Milliseconds;
  /**
   * Origins besides the `url`'s the agent's card may name for its interfaces (`https://rpc.example`);
   * default: `@A2AAgent({ allowedOrigins })`. Any other is refused, and no request goes there.
   */
  readonly allowedOrigins?: readonly string[];
}

/** One event of a remote task while the call waits: the SDK's `StreamResponse`. */
export type A2AStreamEvent = StreamResponse;

/** Per call. */
export interface A2AClientCall {
  /** The conversation to continue (was `threadId`): the agent's `contextId`. */
  readonly contextId?: string;
  /** Ends the call (with the signal's reason); the remote task is not canceled by it. */
  readonly signal?: AbortSignal;
  /** Each event of the remote task while the call waits (stream events, or each changed poll). */
  readonly onEvent?: (event: A2AStreamEvent) => void;
  /**
   * How long the call waits for the task at most — the execution's deadline is the other bound,
   * the earlier wins; then a best-effort CancelTask and `A2ACallDeadlineError`.
   */
  readonly timeout?: Milliseconds;
  /**
   * Inside one step, a second call of this client with another message needs its own key: each call
   * of a step is one outbound call, recorded and replayed by its name (`[a2a.repeated-call]`).
   */
  readonly key?: string;
}

/**
 * What an untyped call gives: the task (absent when the agent answered with a stateless message),
 * the message, the answer's text and first data part, and the peer as the call relied on it — what
 * is and is not guaranteed (`peer.kind`, `peer.mesh`).
 */
export interface A2ATaskResult {
  readonly task: Task | undefined;
  readonly message: Message | undefined;
  readonly text: string | undefined;
  readonly data: unknown;
  /** The answer's files (#859), in order: each one's bytes inline (`raw`) or by `url`. */
  readonly files: readonly A2AReceivedFile[];
  readonly peer: A2ARemotePeer;
}

/** The url `@A2AAgent` recorded on the class being constructed. */
export function urlOf(target: object, name: string): string {
  const meta = componentOf(target);
  if (meta?.kind !== "a2a-agent") {
    throw new ComponentError(
      `[a2a.no-url] ${name} has no @A2AAgent({ url }) and no url option — the remote agent's address is unknown`,
    );
  }
  return meta.meta.url;
}

/** `fields` without the ones that are `undefined` (an optional field is absent, never `undefined`). */
function definedOf<T extends object>(fields: { readonly [K in keyof T]: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as T;
}

/** The contract `@A2AAgent` recorded on the class being constructed, if any. */
export function contractOfClass(target: object): A2AClientContract | undefined {
  const meta = componentOf(target);
  if (meta?.kind !== "a2a-agent") return undefined;
  const { target: callee, input, output, price, mesh } = meta.meta;
  return definedOf<A2AClientContract>({
    application: callee?.application,
    skill: callee?.skill,
    finishes: callee?.finishes,
    input,
    output,
    price,
    mesh,
  });
}

/** The origins `@A2AAgent({ allowedOrigins })` recorded on the class, if any. */
export function allowedOriginsOfClass(target: object): readonly string[] {
  const meta = componentOf(target);
  return meta?.kind === "a2a-agent" ? (meta.meta.allowedOrigins ?? []) : [];
}

/** The name of the client: its `@A2AAgent`'s, else its class's. */
export function agentNameOf(target: object, fallback: string): string {
  const meta = componentOf(target);
  return meta?.kind === "a2a-agent" ? meta.meta.name : fallback;
}

/** A call's `key`: part of an outbound call's name, so of its charset (`[A-Za-z0-9._-]`, 1–40). */
export function checkedCallKey(agent: string, key: string | undefined): string | undefined {
  if (key === undefined || /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/u.test(key)) return key;
  throw new ComponentError(
    `[a2a.call-key-invalid] ${agent}: a call's key is 1–40 letters, digits, ".", "_" or "-", a letter or digit first`,
  );
}

/** When a call's wait ends at the latest: the execution's deadline, the call's timeout. */
export function deadlineOf(clock: Pick<Clock, "now">, call: A2AClientCall): Date | undefined {
  const at = currentFrame()?.execution.deadline?.at;
  const ofExecution = at === undefined ? undefined : Date.parse(at);
  const ofCall = call.timeout === undefined ? undefined : clock.now().getTime() + call.timeout;
  const bounds = [ofExecution, ofCall].filter(
    (bound): bound is number => bound !== undefined && !Number.isNaN(bound),
  );
  return bounds.length === 0 ? undefined : new Date(Math.min(...bounds));
}

/** A typed contract: both DTOs. */
export interface TypedContract extends A2AClientContract {
  readonly input: DtoClass;
  readonly output: DtoClass;
}

/** The contract `execute` needs: both DTOs, else `[a2a.no-contract]`. */
export function typedContractOf(
  name: string,
  contract: A2AClientContract | undefined,
): TypedContract {
  if (contract?.input !== undefined && contract.output !== undefined) {
    // #859: a file below the top level would travel in the data part — refused, as at assembly
    const nested = [contract.input, contract.output].flatMap((dto) =>
      nestedFileFieldsOf(dto).map((path) => `${dto.name}.${path}`),
    );
    if (nested.length > 0)
      throw new ComponentError(
        `[a2a.nested-file-field] ${name}: ${nested.join(", ")} holds an A2AFileDto below the top level — an A2A file is a part of its own, in a top-level field`,
      );
    return { ...contract, input: contract.input, output: contract.output };
  }
  throw new ComponentError(
    `[a2a.no-contract] ${name} declares no typed contract — @A2AAgent({ input, output }) on its class, or the contract option; send(message) runs without one`,
  );
}
