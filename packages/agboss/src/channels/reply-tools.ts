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
  "Only with approve-with-changes — an approval with a limit or a change (\"yes, up to $900\"). The fields the reply changes, with their new values in the units of the call's own arguments; every field left out keeps the call's own value.";

/** An approval role's decisions as the interpreter's model names them (#688). */
export enum ReplyDecision {
  Approve = "approve",
  ApproveWithChanges = "approve-with-changes",
  Refuse = "refuse",
}

/** What the model reads about its decision (#688). */
export const DECISION_DESCRIPTION =
  "approve: the reply agrees to the call as it is (a plain yes, or a limit at or above what the call asks). approve-with-changes: the reply agrees but changes the call — a limit below what it asks, another value — and overrideArguments says what changes. refuse: the reply refuses the call.";

const DECISION_SCHEMA: JsonSchema = {
  type: "string",
  enum: [ReplyDecision.Approve, ReplyDecision.ApproveWithChanges, ReplyDecision.Refuse],
  description: DECISION_DESCRIPTION,
};

/** What the model reads about the not-understood tool. */
export const NOT_UNDERSTOOD_DESCRIPTION =
  "The reply neither approves nor refuses — unclear, off topic, a shrug, a maybe — or names a limit that would need converting: say why. Not a refusal: the question stays open. A yes with a limit is an approval, never this.";

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
  // #688: three named decisions, never a boolean a cheap model reads "a limit below the call" into
  const { approved: _approved, ...rest } = parameters.properties;
  const properties = { ...rest, decision: DECISION_SCHEMA, overrideArguments: correctionOf(approves) };
  return {
    ...tool.definition,
    function: {
      ...tool.definition.function,
      parameters: withSortedKeys({ ...parameters, properties, required: ["decision"] }),
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
  return correctedCallOf(approvalOf(answer), ask);
}

/**
 * The model's decision as the role's answer (#688): `approve` the call as it is (a correction
 * beside it dropped — never a raise the reply did not ask for), `approve-with-changes` with its
 * correction (none: no answer), `refuse` with its reason. An answer in the DTO's own shape (a
 * script's) as it is.
 */
function approvalOf(answer: unknown): unknown {
  if (!isRecord(answer) || !("decision" in answer)) return answer;
  const { decision, overrideArguments, ...rest } = answer;
  if (decision === ReplyDecision.Refuse) return { ...rest, approved: false };
  if (decision === ReplyDecision.Approve) return { ...rest, approved: true };
  if (decision === ReplyDecision.ApproveWithChanges && isRecord(overrideArguments))
    return { ...rest, approved: true, overrideArguments };
  return { ...rest, decision };
}

/**
 * The numbers a correction raises above the call's own (#688): a reply's limit lowers a value, and
 * a model that "applies" a limit above the call raises it — money the approver never asked to
 * spend. A free-text reply may lower or change a value, never raise one; a raise is decided, not
 * read.
 */
export function raisedFieldsOf(answer: unknown, ask: unknown): readonly string[] {
  if (!isRecord(answer) || !isRecord(answer.overrideArguments) || !isRecord(ask)) return [];
  const asked = isRecord(ask.arguments) ? ask.arguments : {};
  return Object.entries(answer.overrideArguments).flatMap(([field, value]) => {
    const own = asked[field];
    return typeof value === "number" && typeof own === "number" && value > own ? [field] : [];
  });
}

function correctedCallOf(answer: unknown, ask: unknown): unknown {
  if (!isRecord(answer) || !isRecord(answer.overrideArguments) || !isRecord(ask)) return answer;
  if (!isRecord(ask.arguments)) return answer;
  return { ...answer, overrideArguments: { ...ask.arguments, ...answer.overrideArguments } };
}
