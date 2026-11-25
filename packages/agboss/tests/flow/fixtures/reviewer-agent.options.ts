import type { AgentOptions } from "../../../src/flow/decorators/agent.js";
import { ArticleDto, ReviewDto } from "./dtos.js";
import { inline } from "../../../src/index.js";

/** #272 example 2b — one options const shared by two classes of one agent (one class = one node). */
export const reviewerAgentOptions = {
  prompt: inline("Review the article."),
  model: "moonshotai/kimi-k2.6",
  input: {
    article: ArticleDto,
  },
  output: ReviewDto,
} satisfies Omit<AgentOptions, "name" | "description">;
