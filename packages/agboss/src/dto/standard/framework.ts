import { Decimal, Flag, ListOf, Nested, Text } from "../decorators.js";
import { markOpen } from "../metadata.js";
import { PiiAction } from "../../pii/actions.js";

/** The text a workflow run starts with (the input of a text `@WorkflowStart`). */
export class WorkflowStartTextDto {
  @Text({ prompt: "the text the run starts with", minLength: 1 })
  text!: string;

  @Text({
    prompt: "who or what sent it, if the caller knows",
    optional: true,
    sensitive: PiiAction.replaceWithToken(),
  })
  author?: string;
}

/** The text a workflow run finishes with (the output of a text `@WorkflowFinish`). */
export class WorkflowFinishTextDto {
  @Text({ prompt: "the text the run finishes with, in plain words" })
  text!: string;
}

/** What a workflow pause asks outside the run — a person or a system. */
export class WorkflowPauseQuestionDto {
  @Text({ prompt: "the question to ask, in one sentence" })
  question!: string;

  @ListOf(Text, {
    prompt: "answers to choose from, if the choice is closed",
    optional: true,
    maxItems: 6,
  })
  options?: string[];
}

/** The replyWith to a workflow pause's question. */
export class WorkflowPauseAnswerDto {
  @Text({ prompt: "the replyWith" })
  replyWith!: string;
}

/** Any JSON object: the arguments of some tool (internal — not a concept of its own). */
export class ToolArguments {
  readonly [name: string]: unknown;
}
markOpen(ToolArguments);

/** A tool call waiting for approval — one call per pause. */
export class ToolCallApprovalAskDto {
  @Text({ prompt: "the id of the call being approved" })
  callId!: string;

  @Text({ prompt: "the tool's name" })
  tool!: string;

  @Nested(ToolArguments, { prompt: "the arguments the tool would get" })
  arguments!: ToolArguments;

  @Text({ prompt: "what the call will do, in one sentence" })
  summary!: string;
}

/** The decision on one tool call waiting for approval. */
export class ToolCallApprovalDecisionDto {
  @Flag({ prompt: "true to run the call, false to refuse it" })
  approved!: boolean;

  @Text({ prompt: "who or what decided" })
  by!: string;

  @Text({ prompt: "feedback or reason for rejection", optional: true })
  feedback?: string;

  @Nested(ToolArguments, { prompt: "arguments to override the call with", optional: true })
  overrideArguments?: ToolArguments;
}

/**
 * The input of a tool that takes nothing (`{}`). `extends Object` only because an empty class body is a
 * lint error; the class is as plain as `class NoInputDto {}`.
 */
export class NoInputDto extends Object {}

/** Plain text, e.g. the result of an MCP server tool that returns text only. */
export class PlainTextDto {
  @Text({ prompt: "the text" })
  text!: string;
}

/** A piece of text a knowledge base (`@Rag`) found for a query. */
export class RagSearchResultDto {
  @Text({ prompt: "the found text" })
  text!: string;

  @Text({ prompt: "where it comes from: a document, a page, a file" })
  source!: string;

  @Decimal({ prompt: "how well it matches the query, from 0 to 1", optional: true, min: 0, max: 1 })
  score?: number;
}
