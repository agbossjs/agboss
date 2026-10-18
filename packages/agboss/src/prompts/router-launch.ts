/**
 * The texts of a router deciding a parallel launch (#273 S23): its `OnDemand` routes are one yes/no
 * question each — the route's prompt — and a chat model answers them through one answer tool with
 * a boolean field per route. Part of the prompt version of a workflow that has such a router.
 */

/** The answer tool of a chat-model router before a launch. */
export const LAUNCH_ANSWER_TOOL = "answer-launch";

/** What the answer tool says it is for. */
export const LAUNCH_ANSWER_DESCRIPTION =
  "Finish with your answer: for each target, true to launch it, false to leave it out";

/** The system message of a chat-model router before a launch (its own prompt follows). */
export const LAUNCH_ROUTER_SYSTEM = [
  "You decide which targets run for the input. Each target is an independent yes/no question:",
  "launch it (true) when its condition holds for the input, else leave it out (false).",
  `Answer by calling ${LAUNCH_ANSWER_TOOL} once, with a boolean for every target.`,
].join("\n");

export const routerLaunchPromptTexts: readonly string[] = [
  LAUNCH_ANSWER_DESCRIPTION,
  LAUNCH_ROUTER_SYSTEM,
];
