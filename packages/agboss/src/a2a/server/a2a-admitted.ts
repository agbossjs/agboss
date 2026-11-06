import {
  CancelTaskRequest,
  GetTaskRequest,
  SendMessageRequest,
  SubscribeToTaskRequest,
} from "@a2a-js/sdk";
import { A2AOperation } from "../a2a-caller.js";

/**
 * What a request was admitted for (#808, security review): its operation and the task it names,
 * read once — by the very decoder the SDK's transport hands our handler (proto-JSON:
 * `SendMessageRequest.fromJSON`, …), never by a parse of our own that could read another task
 * (an alias such as `task_id`, a number for a text, a key twice). The handler then refuses a
 * decoded request that is not the admitted one (`admittedRequest`).
 */

/** An admitted request: its operation and the task it names (`""`: none). */
export interface AdmittedRequest {
  readonly operation: A2AOperation;
  readonly taskId: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type Params = Record<string, unknown>;

/** The task each operation names, as the SDK decodes its `params` (proto-JSON: aliases too). */
const TASK_ID_OF: Readonly<Record<A2AOperation, (params: Params) => string>> = {
  [A2AOperation.SendMessage]: (params) => SendMessageRequest.fromJSON(params).message?.taskId ?? "",
  [A2AOperation.SendStreamingMessage]: (params) =>
    SendMessageRequest.fromJSON(params).message?.taskId ?? "",
  [A2AOperation.GetTask]: (params) => GetTaskRequest.fromJSON(params).id,
  [A2AOperation.CancelTask]: (params) => CancelTaskRequest.fromJSON(params).id,
  [A2AOperation.SubscribeToTask]: (params) => SubscribeToTaskRequest.fromJSON(params).id,
  [A2AOperation.ListTasks]: () => "",
};

/**
 * The request a JSON-RPC body asks for, decoded as the transport decodes it; `undefined` for any
 * other method, or params the transport refuses itself (it answers them, nothing admitted).
 */
export function admittedRequestOf(body: unknown): AdmittedRequest | undefined {
  if (!isObject(body)) return undefined;
  const { method, params } = body;
  const operation = Object.values(A2AOperation).find((known) => known === method);
  // Stryker disable next-line ConditionalExpression: an unknown method's lookup throws below, and is caught to the same `undefined`
  if (operation === undefined || !isObject(params)) return undefined;
  // Stryker disable BlockStatement: an empty catch answers the same `undefined`
  try {
    return { operation, taskId: TASK_ID_OF[operation](params) };
  } catch {
    return undefined; // the transport's own decode fails the same way: its error answers
  }
  // Stryker restore BlockStatement
}
