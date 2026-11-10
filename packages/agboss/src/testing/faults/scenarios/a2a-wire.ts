import { A2A_MESH_EXTENSION } from "../../../a2a/a2a-extension-uris.js";
import { A2ATaskState } from "../../../infrastructure/a2a-task.repository.js";

/**
 * How a fault scenario reads an A2A answer (#811 AC4): only a JSON-RPC 2.0 answer to the call made —
 * HTTP 200, `jsonrpc` "2.0", its own id, exactly one of a result and an error — counts; a result is
 * a task with an id and a known state, an error a whole-number code. Anything else is said, never
 * read as an answer.
 */

/** What a caller was told of a task: its state and code, or the call's error. */
export interface A2AAnswer {
  readonly taskId?: string;
  readonly state?: A2ATaskState;
  readonly code?: string;
  readonly errorCode?: number;
}

/** A record of a JSON value, or `undefined`. */
const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** The task of a JSON-RPC result (a `SendMessage`'s `{ task }`, a read's task). */
const taskOf = (result: Record<string, unknown>): Record<string, unknown> | undefined =>
  "task" in result ? recordOf(result.task) : result;

/** The stable code of a task's status message (`metadata[mesh-uri].code`), if any. */
function codeOf(status: Record<string, unknown>): string | undefined {
  const message = recordOf(status.message);
  const mesh = recordOf(recordOf(message?.metadata)?.[A2A_MESH_EXTENSION]);
  return typeof mesh?.code === "string" ? mesh.code : undefined;
}

/** A JSON-RPC result's task as told: its id, its known state and code — else what is wrong. */
function toldOf(result: unknown): A2AAnswer | string {
  const task = taskOf(recordOf(result) ?? {});
  const status = recordOf(task?.status);
  const state = Object.values(A2ATaskState).find((known) => known === status?.state);
  if (typeof task?.id !== "string" || task.id === "") return "a result without a task id";
  if (status === undefined || state === undefined)
    return `task ${task.id} in an unknown state ${JSON.stringify(status?.state)}`;
  const code = codeOf(status);
  return { taskId: task.id, state, ...(code === undefined ? {} : { code }) };
}

/** What a JSON-RPC answer to call `id` says — else what makes it no answer to it. */
export function answerOf(status: number, body: unknown, id: number): A2AAnswer | string {
  const answer = recordOf(body);
  if (status !== 200) return `HTTP ${String(status)}`;
  if (answer?.jsonrpc !== "2.0") return `jsonrpc ${JSON.stringify(answer?.jsonrpc)}, not "2.0"`;
  if (answer.id !== id) return `the answer of call ${JSON.stringify(answer.id)}, not ${String(id)}`;
  const [hasResult, hasError] = ["result" in answer, "error" in answer];
  if (hasResult === hasError) return "neither or both of result and error";
  return hasResult ? toldOf(answer.result) : errorOf(answer.error);
}

/** A JSON-RPC error as told: its whole-number code — else what is wrong. */
function errorOf(error: unknown): A2AAnswer | string {
  const code = recordOf(error)?.code;
  return typeof code === "number" && Number.isInteger(code)
    ? { errorCode: code }
    : `an error whose code is ${JSON.stringify(code)}`;
}

/** The task a call names: a read's or a cancel's `id`, a follow-up's `message.taskId`. */
export function askedTaskOf(params: unknown): { readonly taskId?: string } {
  const named = recordOf(params);
  const taskId = named?.id ?? recordOf(named?.message)?.taskId;
  return typeof taskId === "string" ? { taskId } : {};
}
