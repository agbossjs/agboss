import { LimitError } from "../../core/error-families/limit-errors.js";
import { isExecutionCancelled } from "../../core/execution-cancelled.js";
import { isGraphInterrupt } from "@langchain/langgraph";

/**
 * The errors of the v2 runtime (#272, #261 Q42, S9, S22): each a plain record in state when an
 * `.onError` catches it, so it holds after a resume.
 */

/**
 * What a step's code may throw that is not its failure (S21, S22): a limit, a cancel or a pause —
 * passed on as it is, never wrapped in the step's error.
 */
export const passesThrough = (error: unknown): boolean =>
  isGraphInterrupt(error) || error instanceof LimitError || isExecutionCancelled(error);
