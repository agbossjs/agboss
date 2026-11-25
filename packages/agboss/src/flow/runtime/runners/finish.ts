import { ExecutionError } from "../../../core/error-families/run-errors.js";
import { validate } from "../../../dto/schema.js";
import type { DtoClass } from "../../../dto/types.js";
import { NodeKind } from "../../ast.js";
import type { ListWrapper } from "../../dto-wrappers.js";
import type { RuntimeNode } from "../graph-model.js";
import type { NodeRunner } from "../node-runner.js";
import type { ScopeRecords } from "../records.js";

/** A finish (#270 Q50, #1271): the latest value of its `output` type on the path. */
function passedThrough(node: RuntimeNode, scope: ScopeRecords) {
  const [field] = node.fields;
  const record = field === undefined ? undefined : scope[field.slot];
  return { value: record?.value, read: record === undefined ? [] : [record.valueId] };
}

/** One element of a list output: a plain value, or `{ value, variant }` of a `oneOf` list. */
interface VariantElement {
  readonly value: unknown;
  readonly variant: string;
}

/** A list output checked element by element; each element of a `oneOf` list by its own class. */
function validList(node: RuntimeNode, output: ListWrapper, value: unknown): unknown[] {
  if (!Array.isArray(value))
    throw new ExecutionError.OutputInvalid({ message: `${node.id} found no list for its output` });
  const { element } = output;
  return (value as readonly unknown[]).map((item) => {
    if (typeof element === "function") return validate(element, item);
    const { value: inner, variant } = item as VariantElement;
    const dto: DtoClass | undefined = element.variants.find((each) => each.name === variant);
    if (dto === undefined)
      throw new ExecutionError.OutputInvalid({
        message: `${node.id}: an element of its output is none of ${element.variants.map((each) => each.name).join(", ")}`,
      });
    return validate(dto, inner);
  });
}

/**
 * A workflow finish: the pass-through of its `output` — one DTO, or a list of them — checked
 * against it. The output is the execution's `result.output`.
 */
export function finishRunner(node: RuntimeNode): NodeRunner {
  const { declaration } = node;
  if (declaration.kind !== NodeKind.Finish) throw new TypeError(`${node.id} is not a finish`);
  const { output } = declaration.options;
  return (state) => {
    const built = passedThrough(node, state.scope);
    const checked =
      typeof output === "function"
        ? validate(output, built.value)
        : validList(node, output, built.value);
    return Promise.resolve({ finish: { output: checked }, read: built.read });
  };
}
