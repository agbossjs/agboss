import type { Task } from "@a2a-js/sdk";
import type { Clock } from "../../infrastructure/clock.js";
import type { Wire } from "./a2a-card-cache.js";
import type { A2AClientCall } from "./a2a-client-options.js";
import type { A2AClientOperation } from "./a2a-client-errors.js";
import { deadlineOf } from "./a2a-client-options.js";
import type { Accepted } from "./a2a-message.js";
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
    onEvent: call.onEvent,
  });
}
