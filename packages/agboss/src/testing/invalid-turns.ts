import type { DtoClass } from "../dto/types.js";
import { toolNameOf, type ToolClass } from "./script.js";
import type { DeepPartial } from "./script-types.js";
import type {
  AnswerDetails,
  InvalidAnswerTurn,
  InvalidToolCallTurn,
  TruncatedToolCallTurn,
} from "./turns.js";

/**
 * The model's invalid turns (#395 PR 3): what a validation retry is tested with — each counts in
 * the step's `validationAttempts`, and the third invalid answer fails the step with
 * `AgentAnswerInvalidError`. No cast is needed: their arguments are deliberately not the tool's or
 * the class's input.
 */

/** The fields of a call or an answer as the model sent them, whatever their shape. */
export type InvalidFields = Readonly<Record<string, unknown>>;

/**
 * The model calls a tool with arguments its input check refuses:
 * `callToolWithInvalidArguments(LookupOrderTool, { orderId: 7 })` — the tool never runs, the call is
 * recorded `ToolCallStatus.InvalidArguments` and the model reads why.
 */
export function callToolWithInvalidArguments<TInput extends object>(
  tool: ToolClass<TInput>,
  args: InvalidFields,
): InvalidToolCallTurn {
  return { kind: "invalid-tool-call", tool: toolNameOf(tool), args: { ...args } };
}

/** JSON cut before its end, as a model stopped at its output limit sends it. */
const cutJson = (args: object): string => {
  const json = JSON.stringify(args);
  return json.slice(0, Math.max(1, json.length - 2));
};

/**
 * The model's call is cut at its output limit (`finish_reason: "length"`), its arguments no JSON:
 * `callToolWithTruncatedArguments(LookupOrderTool, { orderId: "7" })` sends `{"orderId":"7` — the
 * provider's `invalid_tool_calls`, recorded `ToolCallStatus.InvalidArguments`; the tool never runs.
 */
export function callToolWithTruncatedArguments<TInput extends object>(
  tool: ToolClass<TInput>,
  args: NoInfer<DeepPartial<TInput>>,
): TruncatedToolCallTurn {
  return { kind: "truncated-tool-call", tool: toolNameOf(tool), text: cutJson(args) };
}

/**
 * An agent with `output` answers through the answer tool of a class with fields that do not fit it:
 * `replyWithInvalidAnswer(DraftDto, { body: "no text field" })` (a list output: an array) — an
 * invalid answer, sent back to the model; the class must be one of the agent's output.
 */
export function replyWithInvalidAnswer<TDto extends DtoClass>(
  dto: TDto,
  value: InvalidFields,
  details?: AnswerDetails,
): InvalidAnswerTurn<InstanceType<TDto>, false>;
export function replyWithInvalidAnswer<TDto extends DtoClass>(
  dto: TDto,
  values: readonly InvalidFields[],
  details?: AnswerDetails,
): InvalidAnswerTurn<InstanceType<TDto>, true>;
export function replyWithInvalidAnswer(
  dto: DtoClass,
  value: InvalidFields | readonly InvalidFields[],
  details: AnswerDetails = {},
): InvalidAnswerTurn {
  return { kind: "invalid-answer", dto, value, details };
}
