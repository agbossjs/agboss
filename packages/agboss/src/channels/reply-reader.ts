import type { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { ChatDefaults, ModelSettings, ResolvedModelSettings } from "../config/types.js";
import type { Class } from "../components/injection.js";
import { recordUsage, type UsageRecord } from "../finops/usage.js";
import { answerToolsOf } from "../flow/runtime/answer-tools.js";
import type { PauseRecord } from "../infrastructure/pause-record.js";
import type { ModelGateway } from "../llm/gateway.js";
import { resolveSettings } from "../llm/registry.js";
import { REPLY_INTERPRETER_SYSTEM, replyInputMessage } from "../prompts/reply-interpreter.js";
import { ReplyInterpreterMissingError, UninterpretableReplyError } from "./reply-interpreter.js";
import type { AssembledReplyInterpreter } from "./reply-interpreters.js";

/**
 * Reading a free-text reply to a pause (#267 PR 3): the pause's role's interpreter gets the pause's
 * original question and the reply, and what it gives is validated like a decision. A reply nobody
 * can read — the interpreter declines, or its answer is not valid — is `unreadable`: the caller
 * throws `UninterpretableReplyError` and the pause stays pending. What a model interpreter spent is
 * reported either way. A model interpreter makes one chat call under the cost caller
 * `reply-interpreter:<name>` — its instructions after the framework's system text, the question and
 * the reply in the input message, one answer tool of the role's answer DTO; no answer is a decline.
 */

/** What the interpreter reads: the pause's original question and the free-text reply. */
export interface ReplyInterpreterInput {
  readonly ask: unknown;
  readonly reply: string;
}

/** What one reading gave: the answer, or why there is none — and what the call cost. */
export type ModelReading =
  | { readonly kind: "answered"; readonly answer: unknown; readonly usage: readonly UsageRecord[] }
  | { readonly kind: "declined"; readonly reason: string; readonly usage: readonly UsageRecord[] };

/** Where a model interpreter's call goes: the gateway, its settings, the trace's callbacks. */
export interface ReplyModelSite {
  readonly gateway: ModelGateway;
  readonly settings: ResolvedModelSettings;
  readonly callbacks: readonly BaseCallbackHandler[];
}

/** The cost caller of a reply interpreter, also its script key in tests. */
export const replyInterpreterCaller = (name: string): string => `reply-interpreter:${name}`;

/** One reading of `input` by a model interpreter. */
export async function readByModel(
  interpreter: AssembledReplyInterpreter,
  input: ReplyInterpreterInput,
  site: ReplyModelSite,
): Promise<ModelReading> {
  const caller = replyInterpreterCaller(interpreter.name);
  const user = { kind: "reply-interpreter", interpreter: interpreter.name, input } as const;
  const chat = site.gateway.chatModel({ user, settings: site.settings });
  if (chat.bindTools === undefined)
    throw new TypeError(`${caller}: ${site.settings.model} cannot call tools`);
  const tools = answerToolsOf(interpreter.answer);
  const system = `${REPLY_INTERPRETER_SYSTEM}\n\n${interpreter.instructions}`.trim();
  const messages = [
    new SystemMessage(system),
    new HumanMessage(replyInputMessage(input.ask, input.reply)),
  ];
  const reply = await chat
    .bindTools(tools.tools.map((tool) => tool.definition))
    .invoke(messages, { callbacks: [...site.callbacks] });
  const message = reply instanceof AIMessage ? reply : new AIMessage({ content: reply.content });
  const usage = [recordUsage(caller, site.settings, message)];
  const names = new Set(tools.tools.map((tool) => tool.name));
  const answer = (message.tool_calls ?? []).find((call) => names.has(call.name));
  return answer === undefined
    ? { kind: "declined", reason: "the model gave no answer", usage }
    : { kind: "answered", answer: answer.args, usage };
}

/** One reply to read: its pause, the text, and what the caller does around the model call. */
export interface ReplyCall {
  readonly pause: PauseRecord;
  readonly reply: string;
  /** The decision as the role validates it (the tool's input checks `overrideArguments`). */
  readonly validate: (decision: unknown) => unknown;
  /** Before a model interpreter's call: the tree's budgets checked (an exhausted one throws). */
  readonly beforeModelCall: () => Promise<void>;
  /** The trace's callbacks of the pause's execution (none without tracing). */
  readonly callbacks: readonly BaseCallbackHandler[];
}

/** What reading gave: the validated decision, or why there is none — and what it cost. */
export type ReplyReading =
  | { readonly kind: "read"; readonly decision: unknown; readonly usage: readonly UsageRecord[] }
  | {
      readonly kind: "unreadable";
      readonly error: UninterpretableReplyError;
      readonly usage: readonly UsageRecord[];
    };

/** What the reader runs on: the tree's interpreters, the gateway, the container. */
export interface ReplyReaderParts {
  readonly interpreters: readonly AssembledReplyInterpreter[];
  readonly gateway: ModelGateway;
  readonly chatDefaults: ChatDefaults;
  /** Settings (price) of a chat model, by model id — like a chat-model router's. */
  readonly chatModelSettings: (model: string) => ModelSettings;
  /** A code interpreter's instance (the container's, or a test's mock). */
  readonly instanceOf: (interpreter: Class) => unknown;
}

/** Reads one reply. */
export type ReplyReader = (call: ReplyCall) => Promise<ReplyReading>;

/** What the interpreter itself answered, before validation. */
type Interpreted =
  | { readonly kind: "answered"; readonly answer: unknown; readonly usage: readonly UsageRecord[] }
  | { readonly kind: "declined"; readonly cause: unknown; readonly usage: readonly UsageRecord[] };

async function byCode(
  interpreter: AssembledReplyInterpreter,
  input: ReplyInterpreterInput,
  parts: ReplyReaderParts,
): Promise<Interpreted> {
  const instance = parts.instanceOf(interpreter.interpreter);
  const interpret: unknown =
    typeof instance === "object" && instance !== null
      ? Reflect.get(instance, "interpret")
      : undefined;
  if (typeof interpret !== "function")
    throw new TypeError(`${interpreter.name}: interpret is not a method`);
  try {
    const answer: unknown = await Reflect.apply(interpret, instance, [input]);
    return { kind: "answered", answer, usage: [] };
  } catch (cause) {
    // a code interpreter declines a reply it cannot read by throwing
    return { kind: "declined", cause, usage: [] };
  }
}

async function byModel(
  interpreter: AssembledReplyInterpreter,
  model: string,
  input: ReplyInterpreterInput,
  call: ReplyCall,
  parts: ReplyReaderParts,
): Promise<Interpreted> {
  await call.beforeModelCall();
  const settings = resolveSettings(
    { ...parts.chatModelSettings(model), model },
    parts.chatDefaults,
  );
  const site = { gateway: parts.gateway, settings, callbacks: call.callbacks };
  const reading = await readByModel(interpreter, input, site);
  return reading.kind === "answered"
    ? reading
    : { kind: "declined", cause: new Error(reading.reason), usage: reading.usage };
}

/** The reader of a workflow's tree. */
export function replyReaderOf(parts: ReplyReaderParts): ReplyReader {
  return async (call) => {
    const { pause, reply } = call;
    const interpreter = parts.interpreters.find((found) => found.channel === pause.channel);
    if (interpreter === undefined) {
      throw new ReplyInterpreterMissingError(
        `pause ${pause.pauseId}: channel ${pause.channel} has no replyInterpreter — answer it with a decision, or name one on its @ChannelRole`,
      );
    }
    const input = { ask: pause.ask, reply };
    const { model } = interpreter;
    const interpreted =
      model === undefined
        ? await byCode(interpreter, input, parts)
        : await byModel(interpreter, model, input, call, parts);
    const unreadable = (cause: unknown): ReplyReading => {
      const reason = cause instanceof Error ? cause.message : String(cause);
      const message = `pause ${pause.pauseId}: ${interpreter.name} could not read the reply — ${reason}`;
      const error = new UninterpretableReplyError(message, { cause });
      return { kind: "unreadable", error, usage: interpreted.usage };
    };
    if (interpreted.kind === "declined") return unreadable(interpreted.cause);
    try {
      return {
        kind: "read",
        decision: call.validate(interpreted.answer),
        usage: interpreted.usage,
      };
    } catch (invalid) {
      return unreadable(invalid);
    }
  };
}
