import {
  AGENT_CARD_PATH,
  Message,
  Role,
  TaskState,
  type AgentCard,
  type Part,
  type Task,
} from "@a2a-js/sdk";
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  ServerCallContext,
  type ExecutionEventBus,
  type RequestContext,
} from "@a2a-js/sdk/server";
import { A2A_MESH_EXTENSION, A2A_SKILLS_EXTENSION } from "../../../../src/a2a/a2a-extension-uris.js";
import { meshBodyHashOf, meshEnvelopeTextOf } from "../../../../src/a2a/a2a-mesh-message.js";
import { meshRefusalOf, type MeshReceiver } from "../../../../src/mesh/mesh-admission.js";
import { isoDurationOf } from "../../../../src/mesh/mesh-durations.js";
import { readMeshEnvelope } from "../../../../src/mesh/mesh-envelope-codec.js";
import type { MeshEnvelope } from "../../../../src/mesh/mesh-envelope.js";
import { meshLimitBodyOf } from "../../../../src/mesh/mesh-wire.js";

/**
 * A foreign A2A v1.0 agent in process (#809): the official SDK's own server — `DefaultRequestHandler`
 * over an `InMemoryTaskStore`, behind `JsonRpcTransportHandler` — answering a client's `fetcher`
 * without a socket. A test scripts what its executor does with each message and injects faults: an
 * answer lost after the agent acted, a stream cut after some events. With `agboss` it also
 * deduplicates by `messageId` and declares the AGBoss extensions, as an AGBoss peer does.
 */

export const AGENT_URL = "http://agent.test/a2a";

/** The URL a fetch is asked for. */
export const urlOf = (input: Parameters<typeof fetch>[0]): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

/** Whether a handler's answer is a stream of events. */
const isStream = (answer: unknown): answer is AsyncGenerator =>
  typeof answer === "object" && answer !== null && Symbol.asyncIterator in answer;

/** A JSON-RPC request as the agent reads it. */
interface RpcBody {
  readonly id?: unknown;
  readonly method: string;
  readonly params?: {
    readonly message?: {
      readonly messageId?: string;
      readonly metadata?: unknown;
      readonly parts?: unknown;
    };
  };
}

/** What the executor does with one message. */
export type AgentScript = (
  context: RequestContext,
  bus: ExecutionEventBus,
  agent: SdkAgent,
) => Promise<void>;

export interface SdkAgentOptions {
  readonly script: AgentScript;
  readonly streaming?: boolean;
  /** Declare the AGBoss extensions (and dedupe by messageId): an AGBoss peer. */
  readonly agboss?: {
    readonly idempotencyRetention: number;
    readonly skills?: Record<string, unknown>;
  };
  readonly skills?: readonly string[];
  /** The card as served, replacing the built one (a v0.3 card). */
  readonly rawCard?: unknown;
  /**
   * An AGBoss receiver's mesh check, as a server does it on the wire: the envelope read from the
   * message's metadata, its `bodyHash` checked, its chain against this entry and `maxMeshHops` — a
   * refused chain is a REJECTED task with the limit's code and facts, nothing run.
   */
  readonly meshReceiver?: MeshReceiver;
}

/** One request the agent received. */
export interface ReceivedRequest {
  readonly method: string;
  readonly messageId: string | undefined;
  readonly headers: Readonly<Record<string, string>>;
  readonly metadata: unknown;
  readonly parts: unknown;
}

const textPart = (text: string): Part => ({
  content: { $case: "text", value: text },
  metadata: undefined,
  filename: "",
  mediaType: "text/plain",
});

const dataPart = (data: unknown): Part => ({
  content: { $case: "data", value: data },
  metadata: undefined,
  filename: "",
  mediaType: "application/json",
});

export const agentMessage = (
  context: RequestContext,
  parts: Part[],
  metadata?: Record<string, unknown>,
): Message => ({
  messageId: `answer-${context.userMessage.messageId}`,
  contextId: context.contextId,
  taskId: context.taskId,
  role: Role.ROLE_AGENT,
  parts,
  metadata,
  extensions: [],
  referenceTaskIds: [],
});

/** The task of a message, in `state`, with these artifacts and status message. */
export function taskOf(
  context: RequestContext,
  state: TaskState,
  artifacts: { readonly name: string; readonly parts: Part[] }[] = [],
  statusMessage?: Message,
): Task {
  return {
    id: context.taskId,
    contextId: context.contextId,
    status: { state, message: statusMessage, timestamp: new Date(0).toISOString() },
    artifacts: artifacts.map((artifact, index) => ({
      artifactId: `artifact-${String(index)}`,
      name: artifact.name,
      description: "",
      parts: artifact.parts,
      metadata: undefined,
      extensions: [],
    })),
    history: [],
    metadata: undefined,
  };
}

/** Scripts: the common answers. */
export const scripts = {
  /** A stateless message: the text back, upper-cased. */
  messageEcho: (async (context, bus) => {
    const text = context.userMessage.parts.find((part) => part.content?.$case === "text");
    const value = text?.content?.$case === "text" ? text.content.value : "";
    bus.publish(AgentEvent.message(agentMessage(context, [textPart(value.toUpperCase())])));
    bus.finished();
  }) satisfies AgentScript,

  /** A COMPLETED task with one artifact. */
  completeWith:
    (output: { readonly data?: unknown; readonly text?: string }): AgentScript =>
    async (context, bus) => {
      const parts =
        output.data === undefined ? [textPart(output.text ?? "")] : [dataPart(output.data)];
      bus.publish(
        AgentEvent.task(
          taskOf(context, TaskState.TASK_STATE_COMPLETED, [{ name: "answer", parts }]),
        ),
      );
      bus.finished();
    },

  /** A task that ends in `state` with a status message (a failure's text). */
  endWith:
    (state: TaskState, text: string, metadata?: Record<string, unknown>): AgentScript =>
    async (context, bus) => {
      const message = agentMessage(context, [textPart(text)], metadata);
      bus.publish(AgentEvent.task(taskOf(context, state, [], message)));
      bus.finished();
    },
} as const;

/** A working task the test ends by hand (`agent.finish(…)`). */
export function workingThen(): AgentScript {
  return async (context, bus, agent) => {
    bus.publish(AgentEvent.task(taskOf(context, TaskState.TASK_STATE_WORKING)));
    // the executor runs until the test ends the task (or it is canceled)
    await new Promise<void>((resolve) => {
      agent.held.set(context.taskId, { context, bus, release: resolve });
    });
  };
}

export class SdkAgent {
  readonly received: ReceivedRequest[] = [];
  /** Tasks held working by `workingThen()`, by id. */
  readonly held = new Map<
    string,
    {
      readonly context: RequestContext;
      readonly bus: ExecutionEventBus;
      readonly release: () => void;
    }
  >();
  /** The next N SendMessage answers are lost after the agent acted. */
  loseSendAnswers = 0;
  /** The next N streams are cut after this many events. */
  cutStreams: number[] = [];
  /** The card fetches made. */
  cardFetches = 0;
  /** The envelopes the messages carried, decoded, and whether each one's bodyHash matched. */
  readonly envelopes: {
    readonly envelope: MeshEnvelope;
    readonly isBodyBound: boolean;
    readonly isSigned: boolean;
    readonly text: string;
  }[] = [];
  readonly card: AgentCard;
  readonly #options: SdkAgentOptions;
  readonly #transport: JsonRpcTransportHandler;
  /** An AGBoss peer's dedupe: the task (or message) of each messageId. */
  readonly #byMessageId = new Map<string, unknown>();

  constructor(options: SdkAgentOptions) {
    this.#options = options;
    this.card = this.#cardOf(options);
    const executor = {
      execute: (context: RequestContext, bus: ExecutionEventBus) =>
        options.script(context, bus, this),
      cancelTask: async (taskId: string, bus: ExecutionEventBus) => {
        const held = this.held.get(taskId);
        const context = held?.context;
        if (context !== undefined) {
          bus.publish(AgentEvent.task(taskOf(context, TaskState.TASK_STATE_CANCELED)));
        }
        bus.finished();
        this.held.delete(taskId);
        held?.release();
      },
    };
    const handler = new DefaultRequestHandler(this.card, new InMemoryTaskStore(), executor);
    this.#transport = new JsonRpcTransportHandler(handler);
  }

  #cardOf(options: SdkAgentOptions): AgentCard {
    const extensions =
      options.agboss === undefined
        ? []
        : [
            {
              uri: A2A_MESH_EXTENSION,
              description: "AGBoss mesh",
              required: false,
              params: { idempotencyRetention: isoDurationOf(options.agboss.idempotencyRetention) },
            },
            {
              uri: A2A_SKILLS_EXTENSION,
              description: "AGBoss skills",
              required: false,
              params: { skills: options.agboss.skills ?? {} },
            },
          ];
    return {
      name: "sdk-agent",
      description: "An agent on the official SDK",
      supportedInterfaces: [
        { url: AGENT_URL, protocolBinding: "JSONRPC", tenant: "", protocolVersion: "1.0" },
      ],
      provider: undefined,
      version: "1.0.0",
      capabilities: { streaming: options.streaming ?? false, pushNotifications: false, extensions },
      securitySchemes: {},
      securityRequirements: [],
      defaultInputModes: ["text/plain", "application/json"],
      defaultOutputModes: ["text/plain", "application/json"],
      skills: (options.skills ?? ["ask-workflow-start"]).map((id) => ({
        id,
        name: id,
        description: id,
        tags: ["test"],
        examples: [],
        inputModes: [],
        outputModes: [],
        securityRequirements: [],
      })),
      signatures: [],
    };
  }

  /** Ends a held task: COMPLETED with this output, or in another state. */
  finish(
    taskId: string,
    state: TaskState,
    output?: { readonly data?: unknown; readonly text?: string },
  ): void {
    const held = this.held.get(taskId);
    if (held === undefined) throw new Error(`no held task ${taskId}`);
    const parts =
      output === undefined
        ? []
        : output.data === undefined
          ? [textPart(output.text ?? "")]
          : [dataPart(output.data)];
    const artifacts = parts.length === 0 ? [] : [{ name: "answer", parts }];
    held.bus.publish(AgentEvent.task(taskOf(held.context, state, artifacts)));
    held.bus.finished();
    this.held.delete(taskId);
    held.release();
  }

  count(method: string): number {
    return this.received.filter((request) => request.method === method).length;
  }

  /** The client's `fetcher`: the card, and JSON-RPC to the SDK's transport handler. */
  readonly fetcher: typeof fetch = async (input, init) => {
    const url = urlOf(input);
    if (url === `${AGENT_URL}/${AGENT_CARD_PATH}`) {
      this.cardFetches += 1;
      return Response.json(this.#options.rawCard ?? this.card);
    }
    if (url !== AGENT_URL || init?.method !== "POST") {
      return new Response("not found", { status: 404 });
    }
    return this.#answer(init);
  };

  /** The next N `SubscribeToTask` requests answer 502 (a proxy's failure), before the agent. */
  failStreams = 0;
  /** Rewrites an answer before it goes back (a malformed agent): JSON-RPC response in, out. */
  rewrite: ((method: string, answer: Record<string, unknown>) => unknown) | undefined;

  /** Records one request as the agent read it. */
  #record(body: RpcBody, headers: Readonly<Record<string, string>>): void {
    const message = body.params?.message;
    this.received.push({
      method: body.method,
      messageId: message?.messageId,
      headers,
      metadata: message?.metadata,
      parts: message?.parts,
    });
  }

  /** One JSON-RPC request: recorded, the mesh checked, deduplicated, answered, faults applied. */
  async #answer(init: RequestInit): Promise<Response> {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const raw: unknown = JSON.parse(typeof init.body === "string" ? init.body : "{}");
    const body = raw as RpcBody;
    this.#record(body, headers);
    if (body.method === "SubscribeToTask" && this.failStreams > 0) {
      this.failStreams -= 1;
      return new Response("bad gateway", { status: 502 });
    }
    const refused = this.#meshRefusal(body);
    if (refused !== undefined) return Response.json(refused);
    const context = new ServerCallContext({ requestedVersion: headers["a2a-version"] ?? "1.0" });
    const answer =
      this.#dedupe(body) ?? (await this.#transport.handle(raw as Record<string, unknown>, context));
    this.#remember(body, answer);
    return this.#reply(body.method, answer);
  }

  /** The answer as sent back: lost, streamed, or rewritten. */
  #reply(method: string, answer: unknown): Response {
    if (method === "SendMessage" && this.loseSendAnswers > 0) {
      this.loseSendAnswers -= 1;
      throw new TypeError("fetch failed: the answer was lost");
    }
    if (isStream(answer)) return this.#stream(answer, method);
    return Response.json(this.rewrite?.(method, answer as Record<string, unknown>) ?? answer);
  }

  /** An AGBoss peer keeps each message's answer by its messageId. */
  #remember(body: RpcBody, answer: unknown): void {
    const messageId = body.params?.message?.messageId;
    if (body.method !== "SendMessage" || messageId === undefined) return;
    if (this.#options.agboss !== undefined) this.#byMessageId.set(messageId, answer);
  }

  /** A REJECTED task for a message whose chain the receiver refuses; `undefined` to go on. */
  #meshRefusal(body: {
    readonly id?: unknown;
    readonly method: string;
    readonly params?: { readonly message?: unknown };
  }): unknown {
    if (body.method !== "SendMessage" && body.method !== "SendStreamingMessage") return undefined;
    const message = body.params?.message;
    const text = meshEnvelopeTextOf(message);
    const read = readMeshEnvelope(text);
    const envelope = read?.envelope;
    if (read !== undefined && text !== undefined) {
      const isBodyBound = read.envelope.bodyHash === meshBodyHashOf(message);
      this.envelopes.push({
        envelope: read.envelope,
        isBodyBound,
        isSigned: read.signed !== undefined,
        text,
      });
    }
    const receiver = this.#options.meshReceiver;
    if (receiver === undefined) return undefined;
    const limit = meshLimitBodyOf(meshRefusalOf(receiver, envelope));
    if (limit === undefined) return undefined;
    const statusMessage = {
      messageId: "refusal",
      contextId: "ctx-refused",
      taskId: "task-refused",
      role: "ROLE_AGENT",
      parts: [{ text: `refused: ${limit.error}` }],
      metadata: { [A2A_MESH_EXTENSION]: { code: limit.code, details: limit.details } },
    };
    const task = {
      id: "task-refused",
      contextId: "ctx-refused",
      status: {
        state: "TASK_STATE_REJECTED",
        message: statusMessage,
        timestamp: new Date(0).toISOString(),
      },
    };
    return { jsonrpc: "2.0", id: body.id, result: { task } };
  }

  /** An AGBoss peer's answer to a messageId it already accepted: the same, nothing run again. */
  #dedupe(body: {
    readonly id?: unknown;
    readonly method: string;
    readonly params?: { readonly message?: { readonly messageId?: string } };
  }): unknown {
    const messageId = body.params?.message?.messageId;
    if (
      this.#options.agboss === undefined ||
      body.method !== "SendMessage" ||
      messageId === undefined
    ) {
      return undefined;
    }
    const earlier = this.#byMessageId.get(messageId);
    return earlier === undefined ? undefined : { ...(earlier as object), id: body.id };
  }

  #stream(events: AsyncGenerator, method: string): Response {
    const rewrite = this.rewrite;
    const cutAfter = this.cutStreams.shift();
    let sent = 0;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (cutAfter !== undefined && sent >= cutAfter) {
          controller.error(new TypeError("terminated"));
          await events.return(undefined);
          return;
        }
        const next = await events.next();
        if (next.done === true) {
          controller.close();
          return;
        }
        sent += 1;
        const value = rewrite?.(method, next.value as Record<string, unknown>) ?? next.value;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  }
}

export { Message, TaskState };
