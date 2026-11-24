import { onStart } from "../../../src/flow/builder.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { ArticleDto, ArticleRequestDto, ReviewDto } from "./dtos.js";
import { reviewerAgentOptions } from "./reviewer-agent.options.js";
import { inline } from "../../../src/index.js";

/** #272 example 2b — the same work at two stages = two classes sharing one options const. */

@WorkflowStart({
  name: "article-workflow-start",
  description: "What to write about",
  input: ArticleRequestDto,
})
export class ArticleWorkflowStart {}

@Agent({
  name: "article-draft-agent",
  description: "Writes the first draft",
  prompt: inline("Write the draft."),
  model: "moonshotai/kimi-k2.6",
  input: {
    request: ArticleRequestDto,
  },
  output: ArticleDto,
})
export class ArticleDraftAgent {}

@Agent({
  ...reviewerAgentOptions,
  name: "draft-reviewer-agent",
  description: "Reviews the first draft of an article",
})
export class DraftReviewerAgent {}

@Agent({
  name: "writer-agent",
  description: "Rewrites the article by the review",
  prompt: inline("Rewrite the article."),
  model: "moonshotai/kimi-k2.6",
  input: {
    article: ArticleDto,
    review: ReviewDto,
  },
  output: ArticleDto,
})
export class WriterAgent {}

@Agent({
  ...reviewerAgentOptions,
  name: "final-reviewer-agent",
  description: "Reviews the article before it is published",
})
export class FinalReviewerAgent {}

@WorkflowFinish({
  name: "article-workflow-finish",
  description: "The final review",
  output: ReviewDto,
})
export class ArticleWorkflowFinish {}

export const articlePaths = [
  onStart(ArticleWorkflowStart)
    .toAgent(ArticleDraftAgent)
    .toAgent(DraftReviewerAgent)
    .toAgent(WriterAgent)
    .toAgent(FinalReviewerAgent)
    .toFinish(ArticleWorkflowFinish),
] as const;

@Workflow({
  name: "article-workflow",
  version: "1.0.0",
  flow: articlePaths,
})
export class ArticleWorkflow {}
