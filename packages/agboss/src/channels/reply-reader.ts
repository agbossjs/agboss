import type { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { ChatDefaults, ModelSettings, ResolvedModelSettings } from "../config/types.js";
import type { Class } from "../components/injection.js";
import { recordUsage, type UsageRecord } from "../finops/usage.js";
import { runInFrame, type FrameSpec } from "../flow/context/frame.js";
import type { PauseRecord } from "../infrastructure/pause-record.js";
import type { ModelGateway } from "../llm/gateway.js";
import { resolveSettings } from "../llm/registry.js";
import { maskForModel, revealFromModel } from "../pii/model-boundary.js";
import type { PiiPolicySet } from "../pii/policy-set.js";
import type { PiiTokenMap } from "../pii/tokens.js";
import { REPLY_INTERPRETER_SYSTEM, replyInputMessage } from "../prompts/reply-interpreter.js";
import { isDecisionModel } from "../models/decision-models.js";
import {
  ReplyInterpreterMissingError,
  UninterpretableReplyError,
} from "./channel-role.decorator.js";
import type { AssembledReplyInterpreter } from "./discovery.js";
import { crashed, readByCode, type Declined, type Interpreted } from "./reply-code.js";
import { readByDecision } from "./reply-decision.js";
import { replyToolsOf, withCorrectedCall } from "./reply-tools.js";
import type { ToolBinding } from "../flow/runtime/answer-tools.js";

/**
 * Reading a free-text reply to a pause (#267 PR 3): the pause's role's interpreter gets the pause's
 * original question and the reply, and what it gives is validated like a decision. A reply nobody
 * can read — a code interpreter's `ReplyInterpretation.notUnderstood({ reason })` (S124 b) or its
 * crash (a throw), a model that gives no answer, an answer that is not valid — is `unreadable`: the
 * caller throws `UninterpretableReplyError` and the pause stays pending. What a model interpreter
 * spent is reported either way. A decision-model interpreter makes one `Decision.noul` (S124 a,
 * `reply-decision.ts`); a chat-model interpreter makes one chat call under the cost caller
 * `reply-interpreter:<name>` — its instructions after the framework's system text, the question and
 * the reply in the input message, one answer tool of the role's answer DTO; no answer is a decline.
 * Its model reads them through the application's PII policies and its answer is revealed before
 * validation, like an agent's (#120): a token no map knows is a decline, a `blockWithRefusal` value
 * in them throws `PiiRefusedError`. Either kind reads in the pause's execution frame — its step's
 * `ExecutionContext`, its tenant for the rate limits.
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

/** The policies a reply interpreter's model reads through, and the tokens its execution has. */
export interface ReplyPii {
  readonly policies: PiiPolicySet;
  readonly known: PiiTokenMap;
}

/** Where a model interpreter's call goes: the gateway, its settings, the trace's callbacks, PII. */
export interface ReplyModelSite {
  readonly gateway: ModelGateway;
  readonly settings: ResolvedModelSettings;
  readonly callbacks: readonly BaseCallbackHandler[];
  readonly pii: ReplyPii;
}

/** The model's request through the policies: a blocked value in it is refused. */
async function maskedRequestOf(
  interpreter: AssembledReplyInterpreter,
  input: ReplyInterpreterInput,
  pii: ReplyPii,
): Promise<Awaited<ReturnType<typeof maskForModel>>> {
  const system = `${REPLY_INTERPRETER_SYSTEM}\n\n${interpreter.instructions}`.trim();
  const messages = [
    new SystemMessage(system),
    new HumanMessage(replyInputMessage(input.ask, input.reply)),
  ];
  const masked = await maskForModel(pii.policies, messages, pii.known);
  const refused = await pii.policies.refusalError(masked.blocked, masked.usage);
  if (refused !== undefined) throw refused;
  return masked;
}

/** One call per move (#648, #649): an answer or "not understood", never both, never twice. */
const ONE_CALL: ToolBinding = { parallel_tool_calls: false };

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
  const tools = replyToolsOf(interpreter.answer, interpreter.approves);
  const request = await maskedRequestOf(interpreter, input, site.pii);
  const reply = await chat
    .bindTools([...tools.definitions], ONE_CALL)
    .invoke([...request.messages], { callbacks: [...site.callbacks] });
  const message = reply instanceof AIMessage ? reply : new AIMessage({ content: reply.content });
  const usage = [...request.usage, recordUsage(caller, site.settings, message)];
  const revealed = revealFromModel(message, { ...site.pii.known, ...request.tokens });
  if (revealed.unknownTokens.length > 0) {
    const reason = `the model gave unknown tokens ${revealed.unknownTokens.join(", ")}`;
    return { kind: "declined", reason, usage };
  }
  return readingOf(revealed.move.tool_calls ?? [], tools, input.ask, usage);
}

/** One tool call of the interpreter's move, as LangChain gives it. */
interface MoveCall {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/**
 * What the model's move says (#648): "not understood" with its reason — the first call that says
 * so wins, an answer beside it is no answer —, else the answer, its correction on top of the call's
 * own arguments, else no answer at all.
 */
function readingOf(
  calls: readonly MoveCall[],
  tools: ReturnType<typeof replyToolsOf>,
  ask: unknown,
  usage: readonly UsageRecord[],
): ModelReading {
  const notUnderstood = calls.find((call) => call.name === tools.notUnderstood);
  if (notUnderstood !== undefined) {
    const { reason } = notUnderstood.args;
    const why = typeof reason === "string" && reason.trim() !== "" ? reason : "no reason given";
    return { kind: "declined", reason: `the reply does not answer the question: ${why}`, usage };
  }
  const answer = calls.find((call) => call.name === tools.answer);
  return answer === undefined
    ? { kind: "declined", reason: "the model gave no answer", usage }
    : { kind: "answered", answer: withCorrectedCall(answer.args, ask), usage };
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
  /** The pause's execution and step: what the interpreter's `ExecutionContext` reads. */
  readonly frame: FrameSpec;
  readonly pii: ReplyPii;
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

async function byModel(
  interpreter: AssembledReplyInterpreter,
  model: string,
  input: ReplyInterpreterInput,
  call: ReplyCall,
  parts: ReplyReaderParts,
): Promise<Interpreted> {
  await call.beforeModelCall();
  if (isDecisionModel(model)) {
    const caller = replyInterpreterCaller(interpreter.name);
    const site = { gateway: parts.gateway, model, caller, pii: call.pii };
    return readByDecision(interpreter, input, site);
  }
  const settings = resolveSettings(
    { ...parts.chatModelSettings(model), model },
    parts.chatDefaults,
  );
  const site = { gateway: parts.gateway, settings, callbacks: call.callbacks, pii: call.pii };
  return readByModel(interpreter, input, site);
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
    const interpreted = await runInFrame(call.frame, () =>
      model === undefined
        ? readByCode(interpreter, input, parts.instanceOf(interpreter.interpreter))
        : byModel(interpreter, model, input, call, parts),
    );
    const unreadable = (declined: Declined): ReplyReading => {
      const message = `pause ${pause.pauseId}: ${interpreter.name} could not read the reply — ${declined.reason}`;
      const { reason, cause } = declined;
      const error = new UninterpretableReplyError(message, { reason, cause });
      return { kind: "unreadable", error, usage: interpreted.usage };
    };
    if (interpreted.kind === "declined") return unreadable(interpreted);
    try {
      return {
        kind: "read",
        decision: call.validate(interpreted.answer),
        usage: interpreted.usage,
      };
    } catch (invalid) {
      return unreadable(crashed(invalid, interpreted.usage));
    }
  };
}
