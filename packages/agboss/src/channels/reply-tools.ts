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
  return approval.kind === "answer"
    ? { kind: "answer", answer: correctedCallOf(approval.answer, ask) }
    : approval;
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

/** A text that reads as a number: `"900"`, `"-1.5"`. */
const NUMERIC_TEXT = /^\s*-?\d+(?:\.\d+)?\s*$/u;

/** A value of another kind than the call's: no correction of it. */
const otherKind = (path: string): string => `${path} is not the call's kind of value`;

/** A value above the call's own: a raise. */
const raise = (path: string): string => `the reply would raise ${path} above the call's own`;

/** The first refusal of a list of values, `undefined` when none. */
function firstRefusalOf(
  entries: Iterable<readonly [string, unknown]>,
  ownOf: (key: string) => unknown,
  path: string,
  has: (key: string) => boolean,
): string | undefined {
  for (const [key, item] of entries) {
    if (!has(key)) return `${path}.${key} is new: the call has no such field`;
    const why = valueRefusalOf(item, ownOf(key), `${path}.${key}`);
    if (why !== undefined) return why;
  }
  return undefined;
}

/** A list: the same length as the call's, item by item. */
function listRefusalOf(value: unknown, own: readonly unknown[], path: string): string | undefined {
  if (!Array.isArray(value)) return otherKind(path);
  if (value.length !== own.length) return `${path} is a list of another length than the call's`;
  const items = value.map((item, index): readonly [string, unknown] => [String(index), item]);
  return firstRefusalOf(
    items,
    (key) => own[Number(key)],
    path,
    () => true,
  );
}

/** An object: only the call's fields, each in turn. */
function recordRefusalOf(
  value: unknown,
  own: Readonly<Record<string, unknown>>,
  path: string,
): string | undefined {
  if (!isRecord(value)) return otherKind(path);
  return firstRefusalOf(
    Object.entries(value),
    (key) => own[key],
    path,
    (key) => Object.hasOwn(own, key),
  );
}

/** A text: changes freely, unless it reads as a number — then as a number, never raised. */
function textRefusalOf(value: string, own: string, path: string): string | undefined {
  const isNumeric = NUMERIC_TEXT.test(value);
  if (!NUMERIC_TEXT.test(own))
    return isNumeric ? `${path} reads as a number where the call's is text` : undefined;
  if (!isNumeric) return otherKind(path);
  return Number(value) > Number(own) ? raise(path) : undefined;
}

/** A number: finite, never above the call's own. */
const numberRefusalOf = (value: number, own: number, path: string): string | undefined => {
  if (!Number.isFinite(value)) return `${path} is not a finite number`;
  return value > own ? raise(path) : undefined;
};

/** A flag: only turned off. */
const flagRefusalOf = (value: boolean, own: boolean, path: string): string | undefined =>
  value && !own ? raise(path) : undefined;

/** A value that is no list or object: by its kind, which must be the call's. */
function primitiveRefusalOf(value: unknown, own: unknown, path: string): string | undefined {
  if (typeof value === "number" && typeof own === "number")
    return numberRefusalOf(value, own, path);
  if (typeof value === "string" && typeof own === "string") return textRefusalOf(value, own, path);
  if (typeof value === "boolean" && typeof own === "boolean")
    return flagRefusalOf(value, own, path);
  return value === own ? undefined : otherKind(path);
}

/** Why one value of a correction is no correction of the call's own (#688); `undefined`: it is one. */
function valueRefusalOf(value: unknown, own: unknown, path: string): string | undefined {
  if (Array.isArray(own)) return listRefusalOf(value, own, path);
  if (isRecord(own)) return recordRefusalOf(value, own, path);
  return primitiveRefusalOf(value, own, path);
}

/**
 * Why a correction cannot be read from a reply (#688, fail closed): a reply's limit lowers a value,
 * and a model that "applies" a limit above the call raises it — money the approver never asked to
 * spend. So a correction may change only fields the call already has (nested ones too), each to a
 * value of the same kind no greater than the call's own: numbers compared as numbers (a number
 * written as text only where the call's is such a text), a flag only turned off, a list of the same
 * length item by item; text may change. Anything else — a raise, a new field, another kind of
 * value — is not understood: decided, never read. `undefined` when the correction may stand.
 */
export function correctionRefusalOf(answer: unknown, ask: unknown): string | undefined {
  if (!isRecord(answer) || answer.overrideArguments === undefined) return undefined;
  const asked = isRecord(ask) && isRecord(ask.arguments) ? ask.arguments : {};
  if (!isRecord(answer.overrideArguments)) return "the correction is not the call's arguments";
  for (const [field, value] of Object.entries(answer.overrideArguments)) {
    if (!Object.hasOwn(asked, field)) return `${field} is new: the call has no such field`;
    const why = valueRefusalOf(value, asked[field], field);
    if (why !== undefined) return why;
  }
  return undefined;
}

function correctedCallOf(answer: unknown, ask: unknown): unknown {
  if (!isRecord(answer) || !isRecord(answer.overrideArguments) || !isRecord(ask)) return answer;
  if (!isRecord(ask.arguments)) return answer;
  return { ...answer, overrideArguments: { ...ask.arguments, ...answer.overrideArguments } };
}
