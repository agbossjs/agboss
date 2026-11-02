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

const READ_THE_REPLY =
  "Someone answered a question in free text. Read their reply as the answer to that question.";
const ONLY_WHAT_IT_SAYS =
  "Answer only with what the reply says; never decide what it does not say.";
const NOT_UNDERSTOOD = `When the reply does not answer the question — unclear, off topic, a shrug — call ${NOT_UNDERSTOOD_TOOL} with why; that is not a refusal.`;

/** The system message of an approval role's reply interpreter (its own prompt follows). */
export const REPLY_INTERPRETER_SYSTEM = [
  READ_THE_REPLY,
  ONLY_WHAT_IT_SAYS,
  'Call exactly one tool, once. An approval that changes the call ("ok, but only half") is approved: true with overrideArguments holding the changed fields.',
  NOT_UNDERSTOOD,
].join("\n");

/** The system message of a question role's reply interpreter (#659): the answer is the role's DTO. */
export const QUESTION_REPLY_INTERPRETER_SYSTEM = [
  READ_THE_REPLY,
  ONLY_WHAT_IT_SAYS,
  "Call exactly one tool, once: the answer tool with the fields the reply gives.",
  NOT_UNDERSTOOD,
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
