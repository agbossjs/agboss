import type { JudgeOutputShape } from "./judge-decorators.js";
import type { Class } from "./injection.js";
import type { PromptSource } from "./prompt-source.js";

/**
 * The options of a declarative model judge (#1290): an empty class — its model reads the criterion
 * (`prompt`, a file or `inline(…)`), the task and the answer, and answers a verdict. Without
 * `threshold` the model answers pass or fail; with it a score from 0 to 1 that passes at
 * `score >= threshold`.
 */
export interface DeclarativeJudgeOptions<TOutput extends JudgeOutputShape = JudgeOutputShape> {
  /** Unique in the workflow; the class name in kebab-case when left out. */
  readonly name?: string;
  /** What it judges: the agent's answer as this DTO. */
  readonly output: TOutput;
  readonly description?: string;
  /** The criterion: a `.prompt.md` file next to the class (`./…`), or `inline(…)`. */
  readonly prompt: PromptSource;
  /** In `(0, 1]`: the score the answer needs. Left out, the model answers pass or fail. */
  readonly threshold?: number;
  /** The judge's own model: a chat model or a decision model; a role of its provider when left out. */
  readonly model?: string;
  /** The `@ModelProvider` that serves it: its workflow's, its application's when left out. */
  readonly modelProvider?: Class;
  /** A declarative judge injects nothing: it is an empty class. */
  readonly deps?: never;
}

/** A declarative judge's class: empty — it has no `judge` method (its model decides). */
export type DeclarativeJudgeClass<C extends Class> = C &
  ("judge" extends keyof InstanceType<C> ? never : unknown);
