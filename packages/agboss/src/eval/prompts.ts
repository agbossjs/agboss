/** Jev judge question and options — the eval's own prompt, not part of agents' versions. */
export const JUDGE_INSTRUCTIONS = "Is the answer an adequate response to the task?";
export const ADEQUATE = "The answer correctly and fully addresses the task.";
export const INADEQUATE = "The answer is wrong, incomplete, off-topic or empty.";

/** Pairwise comparison of two answers to the same task (judged in both orders by the caller). */
export const PAIR_INSTRUCTIONS = "Which answer addresses the task better?";
export const FIRST_BETTER = "Answer 1 addresses the task better.";
export const SECOND_BETTER = "Answer 2 addresses the task better.";
