import type { ToolDefinition } from "@langchain/core/language_models/base";
import { jsonSchemaOf, validate } from "../../dto/schema.js";
import { DtoValidationError } from "../../dto/errors.js";
import type { DtoClass } from "../../dto/types.js";
import { answerToolName } from "../analyse/rules/models.js";
import { Wrapper, type OutputShape } from "../dto-wrappers.js";
import { withSortedKeys } from "./json.js";

/**
 * How an agent with `output` answers (#272 S6): one answer tool per allowed class,
 * `answer-<kebab of the DTO class>`, next to its own tools. The step ends when the model calls
 * exactly one answer tool and no regular tool in that message; the variant is the tool's name,
 * never the shape. A list output answers `{ items: [...] }`; a list of `oneOf` classes may call
 * several answer tools in one message, their items joined in call order.
 */

/** One answer tool: its name, the class it answers with, and its definition as the model sees it. */
export interface AnswerTool {
  readonly name: string;
  readonly dto: DtoClass;
  readonly definition: ToolDefinition;
}

/** What an agent's answers are checked against. */
export interface AnswerTools {
  readonly tools: readonly AnswerTool[];
  /** The output is a list: each answer carries `items`. */
  readonly isList: boolean;
  /** The output is a `oneOf` (or a list of one): the value carries its class. */
  readonly hasVariants: boolean;
}

export const NO_ANSWER_TOOLS: AnswerTools = { tools: [], isList: false, hasVariants: false };

const answerDefinition = (name: string, dto: DtoClass, isList: boolean): ToolDefinition => {
  const schema = jsonSchemaOf(dto);
  const parameters = isList
    ? {
        type: "object",
        properties: { items: { type: "array", items: schema } },
        required: ["items"],
      }
    : schema;
  return {
    type: "function",
    function: {
      name,
      description: `Finish with your answer as ${dto.name}${isList ? " items" : ""}`,
      parameters: withSortedKeys(parameters),
    },
  };
};

const classesOf = (output: OutputShape): readonly DtoClass[] => {
  if (typeof output === "function") return [output];
  if (output.kind === Wrapper.OneOf) return output.variants;
  return classesOf(output.element);
};

/** The answer tools of an agent's `output`; none for a text agent. */
export function answerToolsOf(output: OutputShape | undefined): AnswerTools {
  if (output === undefined) return NO_ANSWER_TOOLS;
  const isList = typeof output !== "function" && output.kind === Wrapper.List;
  const classes = classesOf(output);
  return {
    tools: classes.map((dto) => {
      const name = answerToolName(dto);
      return { name, dto, definition: answerDefinition(name, dto, isList) };
    }),
    isList,
    hasVariants: classes.length > 1,
  };
}

/** One call of an answer tool. */
export interface AnswerCall {
  readonly tool: AnswerTool;
  readonly args: Readonly<Record<string, unknown>>;
}

/** A checked answer: its value (a list's items as `{ variant, value }` when it has variants). */
export interface AgentAnswer {
  readonly value: unknown;
  readonly variant?: string;
}

export type AnswerReading =
  | { readonly kind: "valid"; readonly answer: AgentAnswer }
  | { readonly kind: "invalid"; readonly problem: string };

const problemOf = (error: unknown): string =>
  error instanceof DtoValidationError ? error.message : String(error);

/** Checks one or more answer calls of a message against the agent's output. */
export function readAnswer(tools: AnswerTools, calls: readonly AnswerCall[]): AnswerReading {
  try {
    if (!tools.isList) {
      const [only] = calls;
      if (only === undefined) return { kind: "invalid", problem: "no answer tool was called" };
      const value = validate(only.tool.dto, only.args);
      return {
        kind: "valid",
        answer: tools.hasVariants ? { value, variant: only.tool.dto.name } : { value },
      };
    }
    const items = calls.flatMap((call) => itemsOf(call).map((item) => ({ call, item })));
    const value = items.map(({ call, item }) => {
      const checked = validate(call.tool.dto, item);
      return tools.hasVariants ? { variant: call.tool.dto.name, value: checked } : checked;
    });
    return { kind: "valid", answer: { value } };
  } catch (error) {
    return { kind: "invalid", problem: problemOf(error) };
  }
}

function itemsOf(call: AnswerCall): readonly unknown[] {
  const { items } = call.args;
  if (!Array.isArray(items)) throw new Error(`${call.tool.name}: "items" must be a list`);
  return items;
}
