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

/**
 * The system message of an approval role's reply interpreter (its own prompt follows). #688: a capped approval —
 * "yes, up to $900" on a call asking $1,200 — read as not understood by cheap models under a one-line
 * prompt; the text now says what a limit is (an approval with the field set to it, in any language),
 * when it leaves the call as it is, and what stays not understood: no yes or no, a guess, a limit
 * that would need converting. Never an approval the reply did not give.
 */
export const REPLY_INTERPRETER_SYSTEM = [
  "Someone answered a question in free text, in any language. Read their reply as the answer to that question.",
  "Answer only with what the reply says; never decide what it does not say. Call exactly one tool, once.",
  'A yes with a limit below what the call asks agrees to the call with a change: approve-with-changes, overrideArguments holding only the fields the reply changes, in the units of the call\'s own arguments. On a call asking 1200 US dollars, "yes, up to $900", "ok but max 900", "approved, no more than 900 dollars", "fine if it stays under $900", "da, ma non più di 900 dollari" and "да, но максимум 900 долларов" all approve with the amount set to 900 — a limit is never a refusal. Dollars in any language are the same currency.',
  'A plain yes, or a limit at or above what the call asks, agrees to the call as it is: approve, with no overrideArguments — never raise an amount up to a limit ("approved, up to $2000" on a call asking 1200 approves 1200).',
  'A reply that says no refuses the call, with or without a reason ("no", "not now", "no, not this quarter", "no, we have no budget", "нет", "לא"): refuse, with the reason — a no is never unclear, even when it says nothing about the details of the call.',
  `When the reply neither agrees nor refuses — unclear, off topic, a shrug, a question back, a maybe, contradictory — or its limit is in another currency than the call's own and would need converting (euros or shekels on a call in US dollars), call ${NOT_UNDERSTOOD_TOOL} with why; that is not a refusal.`,
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
