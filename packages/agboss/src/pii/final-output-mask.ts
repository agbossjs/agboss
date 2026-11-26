import { ComponentKind } from "../flow/runtime/records.js";
import { displayMask, maskedDtoValue, type FieldMask } from "../dto/redact.js";
import { FileDto } from "../dto/standard/file.js";
import { strictMatchOf } from "../dto/schema.js";
import type { DtoClass } from "../dto/types.js";
import { outputClassesOf } from "../flow/finish-output.js";
import { isFieldMap } from "../flow/decorators/declaration.js";
import { Wrapper, type ValueShape } from "../flow/dto-wrappers.js";
import { throughKeepingFiles } from "../a2a/files/a2a-file-scrub.js";
import { startLine } from "../flow/runtime/history.js";
import type { RuntimeGraph } from "../flow/runtime/graph-model.js";
import { tokenFieldMask } from "./field-masks.js";
import type { PiiRuntime } from "./runtime.js";
import type { PiiTokenMap } from "./tokens.js";

/**
 * A final output as it is stored (#1301, #1321d): the finish DTO's `sensitive` fields through
 * their actions — a `tokenize()` field as its token, a `mask()` field as its mask — before the
 * output is written anywhere (the finish line, the history record, an A2A task, a case's past turn).
 * The caller of `execute` keeps the value as it is; whatever outlives the run holds this one.
 */

/** The keys of the execution's field tokens when it has them (its state's `piiKey` and `piiTokens`). */
export interface FieldTokenKeys {
  readonly piiKey?: string | null | undefined;
  readonly piiTokens?: PiiTokenMap | undefined;
}

/**
 * How a stored output's sensitive fields are shown: tokens made under the execution's key (else the
 * workflow's field key), `mask()` as its placeholder. Without a PII runtime nothing can make a
 * token: every sensitive field is its placeholder — it fails closed.
 */
export function storedFieldMask(pii: PiiRuntime | undefined, keys?: FieldTokenKeys): FieldMask {
  if (pii === undefined) return displayMask;
  const key = keys?.piiKey ?? undefined;
  return tokenFieldMask(
    key ?? pii.fieldKey,
    keys?.piiTokens ?? {},
    key === undefined ? pii.previousFieldKey : undefined,
  ).mask;
}

/** One value as one of the classes it may be: its match, else through every class (fails closed). */
function maskedItem(classes: readonly DtoClass[], item: unknown, mask: FieldMask): unknown {
  const [only] = classes;
  const matched = classes.length === 1 ? only : strictMatchOf(classes, item);
  if (matched !== undefined) return maskedDtoValue(matched, item, mask, FileDto);
  return classes.reduce((shown, dto) => maskedDtoValue(dto, shown, mask, FileDto), item);
}

/** A finish's output (a DTO, or a list of its items) with its classes' sensitive fields through `mask`. */
export function maskedOutputOf(
  classes: readonly DtoClass[],
  output: unknown,
  mask: FieldMask,
): unknown {
  if (classes.length === 0) return output;
  return Array.isArray(output)
    ? (output as readonly unknown[]).map((item) => maskedItem(classes, item, mask))
    : maskedItem(classes, output, mask);
}

/** The output of the graph's finish node `finish` as it is stored; unchanged for a name that is no finish. */
export function maskedFinishOutput(
  graph: Pick<RuntimeGraph, "nodes">,
  finish: string,
  output: unknown,
  mask: FieldMask,
): unknown {
  const declaration = graph.nodes.get(finish)?.declaration;
  if (declaration?.kind !== ComponentKind.WorkflowFinish) return output;
  return maskedOutputOf(outputClassesOf(declaration.options.output), output, mask);
}

/** What a workflow's run deps give to mask a stored output: its graph and its PII runtime. */
export interface FinalOutputDeps {
  readonly graph: Pick<RuntimeGraph, "nodes">;
  readonly pii?: PiiRuntime | undefined;
}

/** A finish's output as a record, an event or a stored state keeps it, under the workflow's own key. */
export const storedOutputOf = (deps: FinalOutputDeps, finish: string, output: unknown): unknown =>
  maskedFinishOutput(deps.graph, finish, output, storedFieldMask(deps.pii));

/**
 * The output an eval's judge reads (#1301, #1328): the stored one, then the observability policies
 * over it — a DTO's class kept, for a code judge. The judge's model reads it masked again.
 */
export async function storedJudgedOutput(
  deps: FinalOutputDeps,
  finish: string | undefined,
  output: unknown,
): Promise<unknown> {
  const stored = finish === undefined ? output : storedOutputOf(deps, finish, output);
  return deps.pii === undefined ? stored : deps.pii.observability.value(stored);
}

/** One declared value of a start's input (a DTO, a list of them, or an optional one) as it is stored. */
function maskedShape(shape: ValueShape, value: unknown, mask: FieldMask): unknown {
  if (typeof shape === "function") return maskedDtoValue(shape, value, mask, FileDto);
  if (shape.kind === Wrapper.Optional) {
    return value === undefined ? value : maskedShape(shape.inner, value, mask);
  }
  return Array.isArray(value)
    ? (value as readonly unknown[]).map((item) => maskedItem(shape.variants, item, mask))
    : maskedItem(shape.variants, value, mask);
}

/**
 * The input of the graph's start `start` as it is stored (#1301): the DTO's `sensitive` fields —
 * a DTO, a list of them, or each field of a map of fields — through `mask`. Unchanged for a name
 * that is no start.
 */
export function maskedStartInput(
  graph: Pick<RuntimeGraph, "nodes">,
  start: string,
  input: unknown,
  mask: FieldMask,
): unknown {
  const declaration = graph.nodes.get(start)?.declaration;
  if (declaration?.kind !== ComponentKind.WorkflowStart) return input;
  const declared = declaration.options.input;
  if (!isFieldMap(declared)) return maskedShape(declared, input, mask);
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  return Object.fromEntries(
    Object.entries(input).map(([name, value]) => {
      const shape = declared[name];
      return [name, shape === undefined ? value : maskedShape(shape, value, mask)];
    }),
  );
}

/** A start's input as a record, an event, a history or a child's record keeps it, under the workflow's own key. */
export const storedInputOf = (deps: FinalOutputDeps, start: string, input: unknown): unknown =>
  maskedStartInput(deps.graph, start, input, storedFieldMask(deps.pii));

/**
 * The start line of a turn as it is written to the store: the start DTO's sensitive fields first,
 * then the observability policies, like the finish line (`maskedFinishLine`). What a thread's
 * memory reads of its past turns holds the token or the mask, never the value. A file stays its
 * descriptor, which a later turn reads again.
 */
export async function storedStartLine(
  deps: FinalOutputDeps,
  start: string,
  input: unknown,
): Promise<string> {
  const stored = storedInputOf(deps, start, input);
  const { pii } = deps;
  return startLine(
    start,
    pii === undefined
      ? stored
      : await throughKeepingFiles(stored, (rest) => pii.observability.value(rest)),
  );
}
