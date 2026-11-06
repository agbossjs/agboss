import type {
  AgentCard,
  CancelTaskRequest,
  GetTaskRequest,
  ListTasksRequest,
  ListTasksResponse,
  Message,
  SendMessageRequest,
  StreamResponse,
  SubscribeToTaskRequest,
  Task,
  TaskPushNotificationConfig,
  ListTaskPushNotificationConfigsResponse,
} from "@a2a-js/sdk";
import { A2AError } from "@a2a-js/sdk/errors";
import type { A2ARequestHandler, ServerCallContext } from "@a2a-js/sdk/server";
import {
  isTerminalA2ATaskState,
  type A2ATaskRecord,
} from "../../infrastructure/a2a-task.repository.js";
import { A2AOperation } from "../a2a-caller.js";
import { acceptedTask } from "./a2a-accept.js";
import { listedTasks } from "./a2a-list-tasks.js";
import { canceledTask } from "./a2a-cancel-task.js";
import { followedUpTask } from "./a2a-follow-up.js";
import { callerOf, ownedTask, type A2AServerParts } from "./a2a-server-parts.js";
import { StreamEnd, taskStream } from "./a2a-stream.js";
import { restingTask } from "./a2a-task-wait.js";
import { wireTaskOf } from "./a2a-task-view.js";
import {
  A2AInternalError,
  extendedCardNotConfigured,
  invalidParams,
  pushNotSupported,
  unsupportedOperation,
} from "./a2a-wire-errors.js";

/**
 * The SDK's `A2ARequestHandler`, implemented over the application (#808, design §1.1 and §4.1):
 * every task an A2A task of the store, one root execution under its reserved id — never the SDK's
 * `DefaultRequestHandler`, its own ids or its own task store. The SDK parses and serializes; every
 * error that leaves here is an A2A error with a fixed text, anything else is logged by its class
 * and answered `-32603` "the request failed" (#807: no error's own text on the wire).
 */

export class A2AServerRequestHandler implements A2ARequestHandler {
  constructor(
    private readonly parts: A2AServerParts,
    private readonly card: AgentCard,
  ) {}

  getAgentCard(): Promise<AgentCard> {
    return Promise.resolve(this.card);
  }

  getAuthenticatedExtendedAgentCard(): Promise<AgentCard> {
    return Promise.reject(extendedCardNotConfigured());
  }

  sendMessage(params: SendMessageRequest, context: ServerCallContext): Promise<Message | Task> {
    return this.#guarded("SendMessage", async () => {
      const { task, signal, answered } = await this.#sent(
        A2AOperation.SendMessage,
        params,
        context,
      );
      const isImmediate = params.configuration?.returnImmediately === true;
      const shown = isImmediate ? task : await restingTask(this.parts, task, signal, answered);
      return wireTaskOf(shown, this.parts.skills);
    });
  }

  async *sendMessageStream(
    params: SendMessageRequest,
    context: ServerCallContext,
  ): AsyncGenerator<StreamResponse, void, undefined> {
    const { task, signal, answered } = await this.#guarded("SendStreamingMessage", () =>
      this.#sent(A2AOperation.SendStreamingMessage, params, context),
    );
    yield* this.#guardedStream(
      taskStream(this.parts, task, { end: StreamEnd.Rest, signal, answered }),
    );
  }

  getTask(params: GetTaskRequest, context: ServerCallContext): Promise<Task> {
    return this.#guarded("GetTask", async () => {
      const caller = callerOf(context, A2AOperation.GetTask, params.id);
      const task = await ownedTask(this.parts, caller, params.id);
      return wireTaskOf(task, this.parts.skills);
    });
  }

  cancelTask(params: CancelTaskRequest, context: ServerCallContext): Promise<Task> {
    return this.#guarded("CancelTask", async () => {
      const caller = callerOf(context, A2AOperation.CancelTask, params.id);
      return wireTaskOf(await canceledTask(this.parts, caller, params.id), this.parts.skills);
    });
  }

  async *resubscribe(
    params: SubscribeToTaskRequest,
    context: ServerCallContext,
  ): AsyncGenerator<StreamResponse, void, undefined> {
    const { caller, task } = await this.#guarded("SubscribeToTask", async () => {
      const subscriber = callerOf(context, A2AOperation.SubscribeToTask, params.id);
      const found = await ownedTask(this.parts, subscriber, params.id);
      if (isTerminalA2ATaskState(found.status.state))
        throw unsupportedOperation("a2a.task-over", "the task is over: nothing to subscribe to");
      return { caller: subscriber, task: found };
    });
    yield* this.#guardedStream(
      taskStream(this.parts, task, { end: StreamEnd.Terminal, signal: caller.signal }),
    );
  }

  listTasks(params: ListTasksRequest, context: ServerCallContext): Promise<ListTasksResponse> {
    return this.#guarded("ListTasks", () =>
      listedTasks(this.parts, callerOf(context, A2AOperation.ListTasks), params),
    );
  }

  createTaskPushNotificationConfig(): Promise<TaskPushNotificationConfig> {
    return Promise.reject(pushNotSupported());
  }

  getTaskPushNotificationConfig(): Promise<TaskPushNotificationConfig> {
    return Promise.reject(pushNotSupported());
  }

  listTaskPushNotificationConfigs(): Promise<ListTaskPushNotificationConfigsResponse> {
    return Promise.reject(pushNotSupported());
  }

  deleteTaskPushNotificationConfig(): Promise<void> {
    return Promise.reject(pushNotSupported());
  }

  /** A new message's task, or a follow-up's, and the request's own end. */
  async #sent(
    operation: A2AOperation.SendMessage | A2AOperation.SendStreamingMessage,
    params: SendMessageRequest,
    context: ServerCallContext,
  ): Promise<{
    readonly task: A2ATaskRecord;
    readonly signal: AbortSignal;
    readonly answered: number;
  }> {
    const { message } = params;
    const caller = callerOf(context, operation, message?.taskId ?? "");
    if (message === undefined) throw invalidParams("a2a.message-required", "a message is required");
    if (message.messageId === "")
      throw invalidParams("a2a.message-id-required", "messageId is required");
    if (message.taskId === "")
      return {
        task: await acceptedTask(this.parts, caller, message),
        signal: caller.signal,
        answered: 0,
      };
    const { task, answered } = await followedUpTask(this.parts, caller, message);
    return { task, signal: caller.signal, answered };
  }

  /** Runs one operation: A2A errors as they are, anything else logged by its class, `-32603`. */
  async #guarded<T>(operation: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw this.#wireErrorOf(operation, error);
    }
  }

  async *#guardedStream(
    stream: AsyncGenerator<StreamResponse, void, undefined>,
  ): AsyncGenerator<StreamResponse, void, undefined> {
    try {
      yield* stream;
    } catch (error) {
      throw this.#wireErrorOf("stream", error);
    }
  }

  #wireErrorOf(operation: string, error: unknown): Error {
    if (error instanceof A2AError) return error;
    const name = error instanceof Error ? error.name : typeof error;
    this.parts.log.error("a2a.request-failed", `an A2A ${operation} failed: ${name}`);
    return new A2AInternalError();
  }
}
