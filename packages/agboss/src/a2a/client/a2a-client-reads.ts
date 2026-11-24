import type { StreamResponse, Task } from "@a2a-js/sdk";
import { a2aEventOf } from "./a2a-public-map.js";
import type { Clock } from "../../infrastructure/clock.js";
import type { Wire } from "./a2a-card-cache.js";
import type { A2AClientCall } from "./a2a-client-options.js";
import { A2AClientOperation } from "./a2a-client-errors.js";
import { deadlineOf } from "./a2a-client-options.js";
import type { Accepted } from "./a2a-message.js";
import { stepSignalOf } from "./a2a-call-bounds.js";
import { waitForTask } from "./a2a-wait.js";
import { wireErrorOf } from "./a2a-wire-errors.js";

/** One read of the agent on its SDK client, its error translated (codes only). */
export async function readOf<T>(
  agent: string,
  wire: Promise<Wire>,
  operation: A2AClientOperation,
  signal: AbortSignal | undefined,
  read: (client: Wire["client"], options: { signal?: AbortSignal }) => Promise<T>,
): Promise<T> {
  const { client } = await wire;
  try {
    return await read(client, signal === undefined ? {} : { signal });
  } catch (error) {
    throw wireErrorOf(error, agent, operation, signal);
  }
}

/** `readOf` for a call: its signal is the call's own, else the running step's (D7). */
export function readCallOf<T>(
  agent: string,
  wireOf: WireOf,
  operation: A2AClientOperation,
  call: Pick<A2AClientCall, "signal">,
  read: (client: Wire["client"], options: { signal?: AbortSignal }) => Promise<T>,
): Promise<T> {
  const signal = stepSignalOf(call);
  return readOf(agent, wireOf(signal), operation, signal, read);
}

/** Where a read finds its wire: the client's card cache, for the call's signal. */
export type WireOf = (signal: AbortSignal | undefined) => Promise<Wire>;

/** The task as the agent has it, as the SDK shapes it. */
export const taskReadOf = (
  agent: string,
  wireOf: WireOf,
  taskId: string,
  call: Pick<A2AClientCall, "signal">,
): Promise<Task> =>
  readCallOf(agent, wireOf, A2AClientOperation.GetTask, call, (client, options) =>
    client.getTask({ tenant: "", id: taskId }, options),
  );

/** The task as the agent answers a cancel, as the SDK shapes it. */
export const taskCancelOf = (
  agent: string,
  wireOf: WireOf,
  taskId: string,
  call: Pick<A2AClientCall, "signal">,
): Promise<Task> =>
  readCallOf(agent, wireOf, A2AClientOperation.CancelTask, call, (client, options) =>
    client.cancelTask({ tenant: "", id: taskId, metadata: undefined }, options),
  );

/** The caller's `onEvent`, given the events as AGBoss types them (never the SDK's). */
function eventSinkOf(
  onEvent: A2AClientCall["onEvent"],
): ((event: StreamResponse) => void) | undefined {
  if (onEvent === undefined) return undefined;
  return (event) => {
    const mapped = a2aEventOf(event);
    if (mapped !== undefined) onEvent(mapped);
  };
}

/** What one wait is made of. */
export interface WaitSources {
  readonly agent: string;
  readonly wire: Wire;
  readonly accepted: Accepted;
  readonly clock: Clock;
  readonly call: A2AClientCall;
}

/** The accepted task, waited for until it settles; `undefined` for a stateless answer. */
export async function waitedOf(sources: WaitSources): Promise<Task | undefined> {
  const { agent, wire, accepted, clock, call } = sources;
  if (accepted.taskId === undefined) return undefined;
  return waitForTask({
    agent,
    client: wire.client,
    clock,
    taskId: accepted.taskId,
    task: accepted.task,
    isStreaming: wire.checked.card.capabilities?.streaming === true,
    deadlineAt: deadlineOf(clock, call),
    signal: call.signal,
    onEvent: eventSinkOf(call.onEvent),
  });
}
