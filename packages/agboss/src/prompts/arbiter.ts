/**
 * The texts of a model arbiter (#279): one yes/no question per arriving answer — does it meet the
 * criterion of the agent that gave it? — under the arbiter's own `prompt`. A decision model gets one
 * `Decision.noul`; a chat model answers through one answer tool with one boolean. Part of the prompt
 * version of a workflow that has a model arbiter.
 */

/** The question's key: the decision's one answer. */
export const ARBITER_QUESTION = "counts";

/** The answer tool of a chat-model arbiter. */
export const ARBITER_ANSWER_TOOL = "answer-arbiter";

/** What the answer tool says it is for. */
export const ARBITER_ANSWER_DESCRIPTION =
  "Finish with your verdict: true when the answer meets the criterion and counts, false when it does not";

/** The system message of a chat-model arbiter (its own prompt follows). */
export const ARBITER_SYSTEM = [
  "You judge one answer an agent gave. Decide only whether it meets the criterion of that agent;",
  "do not answer the task yourself and do not judge anything the criterion does not ask for.",
  `Answer by calling ${ARBITER_ANSWER_TOOL} once.`,
].join("\n");

/** The heading of the answer judged, in the decision's input: the agent that gave it. */
export const arbiterAnswerHeading = (agent: string): string => `### answer (from ${agent})`;

export const arbiterPromptTexts: readonly string[] = [
  ARBITER_QUESTION,
  ARBITER_ANSWER_DESCRIPTION,
  ARBITER_SYSTEM,
  arbiterAnswerHeading("<agent>"),
];
