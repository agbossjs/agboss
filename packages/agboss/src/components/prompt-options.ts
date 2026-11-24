import type { PromptSource } from "./prompt-source.js";

export interface PromptOptions {
  /**
   * The prompt: a file (`"./scout.prompt.md"`, `"../shared/tone.prompt.md"`), an `inline("…")` text,
   * or a list of those read in order.
   */
  readonly prompt?: PromptSource;
}
