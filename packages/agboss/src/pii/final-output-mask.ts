import { displayMask, maskedDtoValue, type FieldMask } from "../dto/redact.js";
import { FileDto } from "../dto/standard/file.js";
import { strictMatchOf } from "../dto/schema.js";
import type { DtoClass } from "../dto/types.js";
import { outputClassesOf } from "../flow/finish-output.js";
import { NodeKind } from "../flow/ast.js";
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
  if (declaration?.kind !== NodeKind.Finish) return output;
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
