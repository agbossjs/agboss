import type { Clock } from "../infrastructure/clock.js";
import type { PauseAnswerLog } from "../infrastructure/pause-answer-log.js";
import { permitsOf } from "./answer-permit.js";
import type { AppDeps } from "./app-deps.js";
import { lazyReplyAnswering, type AnswerParts } from "./resume.js";

/** What recording an answer reads from the workflow's deps: its replies, its clock, its log and its targets' `permitAnswer`. */
export const answerPartsOf = (
  deps: AppDeps,
  clock: Clock,
  answers: PauseAnswerLog,
): Pick<AnswerParts, "replies" | "clock" | "answers" | "permits"> => ({
  replies: lazyReplyAnswering(deps),
  clock,
  answers,
  permits: permitsOf(deps),
});
