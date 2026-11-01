import { Decision } from "../llm/decisions.js";
import type { ModelGateway } from "../llm/gateway.js";
import { maskedModelText } from "../pii/model-boundary.js";
import { REPLY_DECISION_QUESTION, replyInputMessage } from "../prompts/reply-interpreter.js";
import type { AssembledReplyInterpreter } from "./discovery.js";
import type { ModelReading, ReplyInterpreterInput, ReplyPii } from "./reply-reader.js";

/**
 * A reply read by a decision model (#267 S124 a): approve / refuse only — one
 * `Decision.noul("approved")` about the pause's question and the reply (the input message, masked by
 * the PII policies like a chat interpreter's), the interpreter's `prompt` as its instructions. The
 * answer is `{ approved }`, approved when P(yes) > 0.5 — never a `reason` or `overrideArguments`
 * (every role is an approval role, #647, so any role may name one).
 * The call is counted under the interpreter's cost caller, `reply-interpreter:<name>`.
 */

/** The question's id: the answer's only field. */
export const APPROVED_QUESTION = "approved";

/** P(yes) above which a reply approves. */
const APPROVAL_THRESHOLD = 0.5;

/** Where a decision interpreter's call goes: the gateway, its decision model, the policies. */
export interface ReplyDecisionSite {
  readonly gateway: ModelGateway;
  readonly model: string;
  readonly caller: string;
  readonly pii: ReplyPii;
}

/** One reading of `input` by a decision-model interpreter. */
export async function readByDecision(
  interpreter: AssembledReplyInterpreter,
  input: ReplyInterpreterInput,
  site: ReplyDecisionSite,
): Promise<ModelReading> {
  const { decide } = site.gateway;
  if (decide === undefined)
    throw new TypeError(`${site.caller}: the model gateway cannot decide on ${site.model}`);
  const state = await maskedModelText(
    site.pii.policies,
    replyInputMessage(input.ask, input.reply),
    site.pii.known,
  );
  const instructions = `${REPLY_DECISION_QUESTION}\n\n${interpreter.instructions}`.trim();
  const outcome = await decide({
    caller: site.caller,
    model: site.model,
    request: { state: state.text, questions: { [APPROVED_QUESTION]: Decision.noul(instructions) } },
  });
  const usage = [...state.usage, outcome.usage];
  const answer = outcome.answers[APPROVED_QUESTION];
  if (answer?.type !== "noul")
    return { kind: "declined", reason: "the model gave no yes / no answer", usage };
  return { kind: "answered", answer: { approved: answer.noul > APPROVAL_THRESHOLD }, usage };
}
