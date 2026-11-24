import type { PromptValue } from "./prompt-source.js";

export interface PromptOptions {
  /**
   * The prompt: a file (`"./scout.prompt.md"`, `"../shared/tone.prompt.md"`), an `inline("…")` text,
   * or a list of those read in order; a bare text is still accepted until #1347b.
   */
  readonly prompt?: PromptValue;
  /** Paths to markdown files containing the prompt text (relative to the declaring file or absolute). */
  readonly promptUrls?: readonly string[];
}
