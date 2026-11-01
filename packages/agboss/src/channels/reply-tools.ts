import type { ToolDefinition } from "@langchain/core/language_models/base";
import { jsonSchemaOf, type JsonSchema } from "../dto/schema.js";
import {
  ReplyInterpreterNotUnderstoodDto,
  ToolCallApprovalDecisionDto,
} from "../dto/standard/framework.js";
import type { DtoClass } from "../dto/types.js";
import { answerToolsOf } from "../flow/runtime/answer-tools.js";
import { withSortedKeys } from "../flow/runtime/json.js";
import { NOT_UNDERSTOOD_TOOL } from "../prompts/reply-interpreter.js";

export { NOT_UNDERSTOOD_TOOL };

/**
 * The tools of a chat-model reply interpreter (#648): its answer tool — for an approval role with
 * `overrideArguments` described by the approved tool's input, every field optional, so "ok, but only
 * up to $500" can be an approval with the one changed field — and a tool to say the reply does not
 * answer the question, which is never a refusal.
 */

/** What the model reads about a correction: the fields the reply changes, the rest kept. */
export const OVERRIDE_ARGUMENTS_DESCRIPTION =
  "Only with approved: true — an approval that changes the call. The fields the reply changes, with their new values; every field left out keeps the call's own value.";

/** What the model reads about the not-understood tool. */
export const NOT_UNDERSTOOD_DESCRIPTION =
  "The reply does not answer the question — unclear, off topic, a shrug: say why. Not a refusal: the question stays open.";

/** An interpreter's tools: what its answer is, and the names of each. */
export interface ReplyTools {
  readonly definitions: readonly ToolDefinition[];
  readonly answer: string;
  readonly notUnderstood: string;
}

/** The approved tool's input as a correction: its fields, none required. */
function correctionOf(approves: DtoClass): JsonSchema {
  const schema = Object.entries(jsonSchemaOf(approves)).filter(([key]) => key !== "required");
  return { ...Object.fromEntries(schema), description: OVERRIDE_ARGUMENTS_DESCRIPTION };
}

/** The answer tool, `overrideArguments` typed by `approves` for an approval role. */
function answerDefinitionOf(answer: DtoClass, approves: DtoClass | undefined): ToolDefinition {
  const [tool] = answerToolsOf(answer).tools;
  if (tool === undefined) throw new TypeError(`no answer tool for ${answer.name}`);
  if (answer !== ToolCallApprovalDecisionDto || approves === undefined) return tool.definition;
  const parameters = tool.definition.function.parameters as JsonSchema & {
    readonly properties: Readonly<Record<string, JsonSchema>>;
  };
  const properties = { ...parameters.properties, overrideArguments: correctionOf(approves) };
  return {
    ...tool.definition,
    function: {
      ...tool.definition.function,
      parameters: withSortedKeys({ ...parameters, properties }),
    },
  };
}

const notUnderstoodDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: NOT_UNDERSTOOD_TOOL,
    description: NOT_UNDERSTOOD_DESCRIPTION,
    parameters: withSortedKeys(jsonSchemaOf(ReplyInterpreterNotUnderstoodDto)),
  },
};

/** The tools of an interpreter answering `answer` for a role that approves `approves`. */
export function replyToolsOf(answer: DtoClass, approves: DtoClass | undefined): ReplyTools {
  const definition = answerDefinitionOf(answer, approves);
  return {
    definitions: [definition, notUnderstoodDefinition],
    answer: definition.function.name,
    notUnderstood: NOT_UNDERSTOOD_TOOL,
  };
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A model's approval with its correction on top of the call's own arguments (the pause's `ask`):
 * the call it approves is the whole input, the fields the reply changed replaced. Anything else —
 * no correction, a refusal — as it is.
 */
export function withCorrectedCall(answer: unknown, ask: unknown): unknown {
  if (!isRecord(answer) || !isRecord(answer.overrideArguments) || !isRecord(ask)) return answer;
  if (!isRecord(ask.arguments)) return answer;
  return { ...answer, overrideArguments: { ...ask.arguments, ...answer.overrideArguments } };
}
