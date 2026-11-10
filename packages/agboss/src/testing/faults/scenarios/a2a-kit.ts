import { A2A_SKILLS_EXTENSION } from "../../../a2a/a2a-extension-uris.js";
import { systemClock } from "../../../infrastructure/clock.js";
import { seconds } from "../../../units/index.js";
import type { FaultCluster } from "../cluster.js";
import type { FaultPodOptions } from "../cluster-options.js";
import { FaultWaitError, type FaultPod } from "../pod.js";
import { FaultPayment } from "../pod-protocol.js";
import { FaultScenarioSkippedError } from "../scenario.js";
import { answerOf, askedTaskOf, type A2AAnswer } from "./a2a-wire.js";
import { expectThat } from "./kit.js";

export type { A2AAnswer } from "./a2a-wire.js";

/**
 * What the A2A scenarios are written with (#811 AC4): pods that serve the fixture over A2A, and
 * the JSON-RPC calls a caller sends them — each answer kept as an event of the pod it came from
 * (`a2a-answer`: the task's id, state and code, or the error's code), so the invariants read every
 * state a caller was told, in order. A store set that keeps no A2A tasks serves none: the scenario
 * is skipped, with the reason.
 */

/** Why an A2A scenario does not run on a set without an A2A task store. */
export const NO_A2A_TASKS =
  "the store set keeps no A2A tasks: list an A2ATaskRepository in faultStores.providers to run it";

/** The skills the fixture serves. */
export enum FaultSkill {
  Order = "fault-order-workflow-start",
  Approval = "fault-approval-workflow-start",
}

/**
 * Starts pod `name`. Whether the scenario runs is the store set's: a set that keeps no A2A tasks
 * skips it; one that keeps them and whose pod serves no A2A fails it — never a skip.
 */
export async function a2aPod(
  cluster: FaultCluster,
  name: string,
  options: FaultPodOptions = {},
): Promise<FaultPod> {
  const pod = await cluster.pod(name, options);
  if (!pod.a2a.keepsA2ATasks) throw new FaultScenarioSkippedError(NO_A2A_TASKS);
  if (pod.a2a.a2aUrl === undefined)
    throw new FaultA2AWireError(`pod ${name} keeps A2A tasks, yet serves no A2A listener`);
  return pod;
}

/** An A2A answer that is no well-formed JSON-RPC 2.0 answer to the call made: the scenario fails. */
export class FaultA2AWireError extends Error {
  override name = "FaultA2AWireError";
}

let calls = 0;

/**
 * Calls `method` on `pod`'s listener; its answer, kept as the pod's `a2a-answer` event (an error
 * answer keeps the task the call named). An answer that is not a JSON-RPC 2.0 answer to this call
 * is a `FaultA2AWireError`, noted among the scenario's failed expectations.
 */
export async function a2aCall(
  cluster: FaultCluster,
  pod: FaultPod,
  method: string,
  params: unknown,
): Promise<A2AAnswer> {
  if (pod.a2a.a2aUrl === undefined)
    throw new FaultA2AWireError(`pod ${pod.name} serves no A2A listener`);
  calls += 1;
  const id = calls;
  const asked = askedTaskOf(params);
  cluster.note(pod, { type: "a2a-asked", method, ...asked });
  const response = await fetch(pod.a2a.a2aUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "a2a-version": "1.0" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const answer = answerOf(response.status, body, id);
  if (typeof answer === "string") {
    const why = `${method} on ${pod.name} answered no JSON-RPC answer: ${answer} (${text.slice(0, 300)})`;
    expectThat(cluster, false, why);
    throw new FaultA2AWireError(why);
  }
  const told = answer.errorCode === undefined ? answer : { ...asked, ...answer };
  cluster.note(pod, { type: "a2a-answer", method, ...told });
  return told;
}

/**
 * A call left in flight while the scenario goes on (a held accept, a held resume): the same call,
 * whose failure — the scenario stopped early, its pod killed — is noted among the scenario's
 * failed expectations as it happens, never an unhandled rejection. Await it to read its answer.
 */
export function a2aCallInFlight(
  cluster: FaultCluster,
  pod: FaultPod,
  method: string,
  params: unknown,
): Promise<A2AAnswer> {
  const call = a2aCall(cluster, pod, method, params);
  call.catch((error: unknown) => {
    cluster.expectations.push(`${method} on ${pod.name}, in flight, failed: ${String(error)}`);
  });
  return call;
}

/** A `SendMessage`'s params, as the wire takes them (ProtoJSON). */
export interface A2ASendParams {
  readonly message: Readonly<Record<string, unknown>>;
  readonly configuration: { readonly returnImmediately: boolean };
}

/** A new order's message for `skill`, answered at its accept (`returnImmediately`). */
export const orderMessage = (
  messageId: string,
  orderId: string,
  skill: FaultSkill,
): A2ASendParams => ({
  message: {
    messageId,
    role: "ROLE_USER",
    parts: [
      {
        data: { orderId, decline: false, payment: FaultPayment.Lookup },
        mediaType: "application/json",
      },
    ],
    metadata: { [A2A_SKILLS_EXTENSION]: { skill } },
  },
  configuration: { returnImmediately: true },
});

/** A follow-up approving the task's only pending pause. */
export const approval = (messageId: string, taskId: string): A2ASendParams => ({
  message: {
    messageId,
    taskId,
    role: "ROLE_USER",
    parts: [{ data: { decision: { approved: true } }, mediaType: "application/json" }],
  },
  configuration: { returnImmediately: true },
});

/** How often a wait reads the task again (real time): a read is what repairs it. */
const READ_EVERY = seconds(0.25);

/**
 * Reads the task on `pod` until `holds` accepts what it says — its read repair runs on each read,
 * on the pods' clock — bounded by the cluster's wait; past it a `FaultWaitError` naming `what`.
 */
export async function readUntil(
  cluster: FaultCluster,
  pod: FaultPod,
  taskId: string,
  what: string,
  holds: (answer: A2AAnswer) => boolean,
): Promise<A2AAnswer> {
  const deadline = systemClock.now().getTime() + cluster.waitTimeout;
  for (;;) {
    const answer = await a2aCall(cluster, pod, "GetTask", { id: taskId });
    if (holds(answer)) return answer;
    if (systemClock.now().getTime() > deadline)
      throw new FaultWaitError(
        `task ${taskId} on ${pod.name}: no ${what} within ${String(cluster.waitTimeout / 1000)} s; last read ${JSON.stringify(answer)}`,
      );
    await systemClock.sleep(READ_EVERY);
  }
}
