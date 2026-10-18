import { AGBossError } from "../../core/errors.js";
import { DtoValidationError } from "../../dto/errors.js";
import { validate } from "../../dto/schema.js";
import type { DtoClass } from "../../dto/types.js";
import { WorkflowStartTextDto } from "../../dto/standard/framework.js";
import { NodeKind } from "../ast.js";
import { isFieldMap } from "../decorators/declaration.js";
import { Wrapper, type ListWrapper, type ValueShape } from "../dto-wrappers.js";
import type { RuntimeGraph, RuntimeNode } from "./graph-model.js";

/**
 * A start's input (#270 → Starts and finishes): one DTO, a list of them, or a map of fields. The
 * payload of `app.execute(Start, payload)` is checked against it before the first step — an invalid
 * one is rejected (`dto.invalid`, the field named, never the value).
 */

const elementClass = (list: ListWrapper): DtoClass | undefined =>
  typeof list.element === "function" ? list.element : undefined;

function validList(list: ListWrapper, value: unknown, field: string): unknown[] {
  const dto = elementClass(list);
  if (!Array.isArray(value) || dto === undefined) {
    throw new DtoValidationError(field, [{ path: "(root)", reason: "expected a list" }]);
  }
  return (value as readonly unknown[]).map((item) => validate(dto, item));
}

function validField(shape: ValueShape, value: unknown, field: string): unknown {
  if (typeof shape === "function") return validate(shape, value);
  if (shape.kind === Wrapper.List) return validList(shape, value, field);
  return value === undefined ? undefined : validField(shape.inner, value, field);
}

/** The start's input, checked: the validated value (a copy). */
export function validStartInput(node: RuntimeNode, payload: unknown): unknown {
  const { declaration } = node;
  if (declaration.kind !== NodeKind.Start) throw new TypeError(`${node.id} is not a start`);
  const { input } = declaration.options;
  if (!isFieldMap(input)) return validField(input, payload, node.id);
  const given: Readonly<Record<string, unknown>> =
    typeof payload === "object" && payload !== null
      ? Object.fromEntries(Object.entries(payload))
      : {};
  return Object.fromEntries(
    Object.entries(input).flatMap(([name, shape]) => {
      const value = validField(shape, given[name], `${node.id}.${name}`);
      return value === undefined ? [] : [[name, value] as const];
    }),
  );
}

/** The starts of a graph. */
export const startsOf = (graph: RuntimeGraph): readonly RuntimeNode[] =>
  [...graph.nodes.values()].filter((node) => node.kind === NodeKind.Start);

/** The start a plain text goes to: the one taking `WorkflowStartTextDto`. */
export function textStartOf(graph: RuntimeGraph): RuntimeNode | undefined {
  return startsOf(graph).find(
    (node) =>
      node.declaration.kind === NodeKind.Start &&
      node.declaration.options.input === WorkflowStartTextDto,
  );
}

/** `app.execute` from a class (or a name) that is not a `@WorkflowStart` of the app's workflow. */
export class NotAWorkflowStartError extends AGBossError {
  static override readonly code: string = "workflow.not-a-start";
  override name = "NotAWorkflowStartError";
}

/** The start of the graph by its `name`; anything else is a `NotAWorkflowStartError`. */
export function startNamed(graph: RuntimeGraph, name: string): RuntimeNode {
  const node = graph.nodes.get(name);
  if (node?.kind !== NodeKind.Start) {
    throw new NotAWorkflowStartError(`${name} is not a workflow start of "${graph.workflow}"`);
  }
  return node;
}

/** What starts an execution: its start's `name` and its input. */
export interface StartRequest {
  readonly start: string;
  readonly input: unknown;
}

/** A text for the graph's text start (eval tasks, `agboss run "…"`); none → `NotAWorkflowStartError`. */
export function textRequestOf(graph: RuntimeGraph, text: string): StartRequest {
  const start = textStartOf(graph);
  if (start === undefined) {
    throw new NotAWorkflowStartError(
      `"${graph.workflow}" has no workflow start with input WorkflowStartTextDto — a text cannot start it`,
    );
  }
  return { start: start.id, input: { text } };
}

const START_LINE = /^start (\S+): (.*)$/s;

/** The start and input of a thread's start line (`start <name>: <json>`, S8) — what replay re-runs. */
export function requestOfStartLine(line: string): StartRequest | undefined {
  const match = START_LINE.exec(line);
  if (match === null) return undefined;
  const [, start = "", json = "null"] = match;
  try {
    return { start, input: JSON.parse(json) as unknown };
  } catch {
    return undefined;
  }
}

/** A task as a golden set or a CLI gives it: a start line (S8) replays its start, a text goes to the text start. */
export const requestOfTask = (graph: RuntimeGraph, task: string): StartRequest =>
  requestOfStartLine(task) ?? textRequestOf(graph, task);
