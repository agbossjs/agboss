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
  "The reply neither approves nor refuses — unclear, off topic, a shrug, a maybe — or names a limit that would need converting: say why. Not a refusal: the question stays open. A yes with a limit is an approval, never this; a no is a refusal, never this — answer it with refuse.";

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
  const rest = Object.entries(parameters.properties).filter(([key]) => key !== "approved");
  const properties = {
    ...Object.fromEntries(rest),
    decision: DECISION_SCHEMA,
    overrideArguments: correctionOf(approves),
  };
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
 * the call it approves is the whole input, the fields the reply changed replaced — or why the
 * model's answer is none (#688: failing closed).
 */
export function withCorrectedCall(answer: unknown, ask: unknown): ReplyAnswer {
  const approval = approvalOf(answer);
  if (approval.kind !== "answer") return approval;
  const { answer: approved } = approval;
  const correction = isRecord(approved) ? approved.overrideArguments : undefined;
  if (correction !== undefined) {
    const why = isRecord(correction)
      ? recordChangeOf(correction, callArgumentsOf(ask), "")
      : "it is not the call's arguments";
    if (why !== undefined) return invalid(`its correction changes the call's shape: ${why}`);
  }
  return { kind: "answer", answer: correctedCallOf(approved, ask) };
}

/** The model's answer as the role's, or why it is none: never a guess (#688). */
export type ReplyAnswer =
  | { readonly kind: "answer"; readonly answer: unknown }
  | { readonly kind: "invalid"; readonly reason: string };

/** The keys an approval may carry: in the DTO's own shape (a script's), or beside a decision. */
const DTO_KEYS: ReadonlySet<string> = new Set(["approved", "reason", "overrideArguments"]);
const DECISION_KEYS: ReadonlySet<string> = new Set(["decision", "reason", "overrideArguments"]);

const invalid = (reason: string): ReplyAnswer => ({ kind: "invalid", reason });

/** Keys of `answer` outside `known`: an answer that says more than a decision can is none. */
const unknownKeysOf = (
  answer: Readonly<Record<string, unknown>>,
  known: ReadonlySet<string>,
): readonly string[] => Object.keys(answer).filter((key) => !known.has(key));

/** The reason, when the answer gives one as text. */
const reasonOf = (answer: Readonly<Record<string, unknown>>): { readonly reason?: string } =>
  typeof answer.reason === "string" && answer.reason !== "" ? { reason: answer.reason } : {};

/** The answer in the DTO's own shape (a script's): as it is, its keys the DTO's only. */
function dtoShaped(answer: Readonly<Record<string, unknown>>): ReplyAnswer {
  const extra = unknownKeysOf(answer, DTO_KEYS);
  return extra.length === 0 ? { kind: "answer", answer } : invalid(`it has ${extra.join(", ")}`);
}

/**
 * The model's decision as the role's answer (#688), failing closed: with a `decision` nothing else
 * of the answer counts — `approve` is the call as it is (a correction beside it dropped, never a
 * raise the reply did not ask for), `approve-with-changes` needs a correction of at least one field,
 * `refuse` is a refusal with its reason; an unknown decision, or a key beside it no decision has
 * (`approved` too), is no answer.
 */
function approvalOf(answer: unknown): ReplyAnswer {
  if (!isRecord(answer)) return { kind: "answer", answer };
  if (!("decision" in answer)) return dtoShaped(answer);
  const extra = unknownKeysOf(answer, DECISION_KEYS);
  if (extra.length > 0) return invalid(`it has ${extra.join(", ")} beside its decision`);
  const { decision, overrideArguments } = answer;
  const reason = reasonOf(answer);
  if (decision === ReplyDecision.Refuse)
    return { kind: "answer", answer: { ...reason, approved: false } };
  if (decision === ReplyDecision.Approve)
    return { kind: "answer", answer: { ...reason, approved: true } };
  if (decision !== ReplyDecision.ApproveWithChanges) return invalid("it names no decision");
  if (!isRecord(overrideArguments) || Object.keys(overrideArguments).length === 0)
    return invalid("an approval with changes that changes nothing");
  return { kind: "answer", answer: { ...reason, approved: true, overrideArguments } };
}

/** The kind of a JSON value, as a correction must keep it: an object, a list, or its `typeof`. */
const kindOf = (value: unknown): string =>
  value === null ? "null" : Array.isArray(value) ? "list" : typeof value;

/**
 * Why a correction's value is not the shape of the call's own (#688, structural): a new key at any
 * depth, another kind of value, a list of another length. What the values may be is the call's own
 * DTO validation, once the correction is laid over the call; what they should be — never above the
 * call's amount, in its currency — is a guardrail's or the tool's own rule, not the reply
 * interpreter's.
 */
function shapeChangeOf(value: unknown, own: unknown, path: string): string | undefined {
  if (kindOf(value) !== kindOf(own)) return `${path} is not the call's kind of value`;
  if (Array.isArray(value) && Array.isArray(own)) {
    if (value.length !== own.length) return `${path} is a list of another length than the call's`;
    for (const [index, item] of value.entries()) {
      const why = shapeChangeOf(item, own[index], `${path}.${String(index)}`);
      if (why !== undefined) return why;
    }
    return undefined;
  }
  return isRecord(value) && isRecord(own) ? recordChangeOf(value, own, path) : undefined;
}

/** A correction's object against the call's: its keys the call's only, each of the call's shape. */
function recordChangeOf(
  value: Readonly<Record<string, unknown>>,
  own: Readonly<Record<string, unknown>>,
  path: string,
): string | undefined {
  for (const [key, item] of Object.entries(value)) {
    const at = path === "" ? key : `${path}.${key}`;
    if (!Object.hasOwn(own, key)) return `${at}: the call has no such field`;
    const why = shapeChangeOf(item, own[key], at);
    if (why !== undefined) return why;
  }
  return undefined;
}

/** The call's own arguments, as the pause asked them (none when the ask has none). */
const callArgumentsOf = (ask: unknown): Readonly<Record<string, unknown>> =>
  isRecord(ask) && isRecord(ask.arguments) ? ask.arguments : {};

/** A correction laid over the call's own value: objects merged at every depth, the rest replaced. */
function laidOver(own: unknown, correction: unknown): unknown {
  if (!isRecord(own) || !isRecord(correction)) return correction;
  const merged: Record<string, unknown> = { ...own };
  for (const [key, item] of Object.entries(correction)) merged[key] = laidOver(own[key], item);
  return merged;
}

function correctedCallOf(answer: unknown, ask: unknown): unknown {
  if (!isRecord(answer) || !isRecord(answer.overrideArguments) || !isRecord(ask)) return answer;
  if (!isRecord(ask.arguments)) return answer;
  return { ...answer, overrideArguments: laidOver(ask.arguments, answer.overrideArguments) };
}
