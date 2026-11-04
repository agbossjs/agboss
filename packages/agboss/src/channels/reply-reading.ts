/**
 * Reading a reply by its interpreter (#267 PR 3, #644): by code, by a decision model or by a chat
 * model, in the call's frame, the answer validated by the call — the reader of a tree's pauses
 * (`replyReaderOf`) and `testReplyInterpreter`'s one reading (`readReplyBy`).
 */
import { runInFrame } from "../flow/context/frame.js";
import { resolveSettings } from "../llm/registry.js";
import { isDecisionModel } from "../models/decision-models.js";
import {
  ReplyInterpreterMissingError,
  UninterpretableReplyError,
} from "./channel-role.decorator.js";
import type { AssembledReplyInterpreter } from "./discovery.js";
import { crashed, readByCode, type Declined, type Interpreted } from "./reply-code.js";
import { readByDecision } from "./reply-decision.js";
import {
  readByModel,
  replyInterpreterCaller,
  type ReplyCall,
  type ReplyInterpreterInput,
  type ReplyReader,
  type ReplyReaderParts,
  type ReplyReading,
} from "./reply-reader.js";

async function byModel(
  interpreter: AssembledReplyInterpreter,
  model: string,
  input: ReplyInterpreterInput,
  call: Pick<ReplyCall, "beforeModelCall" | "callbacks" | "pii">,
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

/** One reply to read by one interpreter: the question it answers and where it is reported. */
export interface InterpreterCall extends Omit<ReplyCall, "pause"> {
  /** What the reply answers: the pause's question. */
  readonly ask: unknown;
  /** Who it answers, for the error's message: `pause <id>`. */
  readonly label: string;
}

/**
 * One interpreter reads one reply: in the call's frame, by code or by its model, the answer
 * validated by the call — the reader of a tree's pauses, and `testReplyInterpreter` (#644).
 */
export async function readReplyBy(
  interpreter: AssembledReplyInterpreter,
  call: InterpreterCall,
  parts: ReplyReaderParts,
): Promise<ReplyReading> {
  const input = { ask: call.ask, reply: call.reply };
  const { model } = interpreter;
  const interpreted = await runInFrame(call.frame, () =>
    model === undefined
      ? readByCode(interpreter, input, parts.instanceOf(interpreter.interpreter))
      : byModel(interpreter, model, input, call, parts),
  );
  const unreadable = (declined: Declined): ReplyReading => {
    const message = `${call.label}: ${interpreter.name} could not read the reply — ${declined.reason}`;
    const { reason, cause } = declined;
    const error = new UninterpretableReplyError(message, { reason, cause });
    return { kind: "unreadable", error, usage: interpreted.usage };
  };
  if (interpreted.kind === "declined") return unreadable(interpreted);
  try {
    return { kind: "read", decision: call.validate(interpreted.answer), usage: interpreted.usage };
  } catch (invalid) {
    return unreadable(crashed(invalid, interpreted.usage));
  }
}

/** The reader of a workflow's tree. */
export function replyReaderOf(parts: ReplyReaderParts): ReplyReader {
  return async (call) => {
    const { pause, ...rest } = call;
    const interpreter = parts.interpreters.find((found) => found.channel === pause.channel);
    if (interpreter === undefined) {
      throw new ReplyInterpreterMissingError(
        `pause ${pause.pauseId}: channel ${pause.channel} has no replyInterpreter — answer it with a decision, or name one on its @ChannelRole`,
      );
    }
    return readReplyBy(
      interpreter,
      { ...rest, ask: pause.ask, label: `pause ${pause.pauseId}` },
      parts,
    );
  };
}
