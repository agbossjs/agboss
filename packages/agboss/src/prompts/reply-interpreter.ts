import { ReplyInterpreterNotUnderstoodDto } from "../dto/standard/framework.js";
import { answerToolName } from "../flow/analyse/rules/models.js";
import { prettyJson } from "../flow/runtime/json.js";

/**
 * The texts of a model reply interpreter (#267 PR 3): one free-text reply to a pause, read as the
 * role's typed answer through one answer tool, under the interpreter's own `prompt`. The pause's
 * question and the reply come in the input message, never in the instructions (#270 Q51).
 */

/** The name the model calls to say a reply does not answer the question (#648). */
export const NOT_UNDERSTOOD_TOOL = answerToolName(ReplyInterpreterNotUnderstoodDto);

/** The system message of a reply interpreter (its own prompt follows). */
export const REPLY_INTERPRETER_SYSTEM = [
  "Someone answered a question in free text. Read their reply as the answer to that question.",
  "Answer only with what the reply says; never decide what it does not say.",
  'Call exactly one tool, once. An approval that changes the call ("ok, but only half") is approved: true with overrideArguments holding the changed fields.',
  `When the reply does not answer the question — unclear, off topic, a shrug — call ${NOT_UNDERSTOOD_TOOL} with why; that is not a refusal.`,
].join("\n");

/** The input message: the pause's question and the reply, each under its field's heading. */
export const replyInputMessage = (ask: unknown, reply: string): string =>
  `### ask\n${prettyJson(ask)}\n\n### reply\n${prettyJson(reply)}`;

/**
 * The yes / no question of a decision-model interpreter (#267 S124 a): approve or refuse only; the
 * interpreter's own prompt follows.
 */
export const REPLY_DECISION_QUESTION =
  "Someone answered an approval request in free text. Does their reply approve the request? " +
  "Answer yes only when the reply clearly approves it.";
