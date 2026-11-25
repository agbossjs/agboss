import { hydrated } from "../../dto/hydrate.js";
import { strictMatchOf } from "../../dto/schema.js";
import type { DtoClass } from "../../dto/types.js";
import type { InputFieldShape } from "../decorators/declaration.js";
import { Wrapper } from "../dto-wrappers.js";
import { Metadata, trackValue } from "../metadata.js";
import type { RuntimeGraph } from "./graph-model.js";

/**
 * Hydration by a field's shape (#1288): a value read back from the scope (a checkpoint's JSON after a
 * resume) or given by a test is an instance of its class, so `item instanceof XDto` holds as in a
 * live run.
 */

/** The class a field's value is of: the variant a `oneOf` gave, else the class its shape names. */
export function classOfValue(
  graph: RuntimeGraph,
  shape: InputFieldShape | undefined,
  variant: string | undefined,
): DtoClass | undefined {
  const named = variant === undefined ? undefined : graph.dtos.get(variant);
  if (named !== undefined) return named;
  if (shape === undefined || typeof shape === "function") return shape;
  switch (shape.kind) {
    case Wrapper.History:
      return shape.dto;
    case Wrapper.Optional:
      return classOfValue(graph, shape.inner, undefined);
    default:
      return shape.variants.length === 1 ? shape.variants[0] : undefined;
  }
}

/** A value of a slot as an instance of its class (what the shape and the variant name); unknown classes stay. */
export function hydratedValue(
  graph: RuntimeGraph,
  shape: InputFieldShape | undefined,
  value: unknown,
  variant: string | undefined,
): unknown {
  const dto = classOfValue(graph, shape, variant);
  return dto === undefined ? value : hydrated(dto, value);
}

/**
 * A value a test (or any caller) gives for a field of this shape, as the flow would hand it:
 * instances of the shape's classes. A polymorphic list's items are told apart by their strict
 * schema; a value that fits none stays as it is.
 */
export function hydratedForShape(shape: InputFieldShape, value: unknown): unknown {
  if (value === undefined || value === null) return value;
  if (typeof shape === "function") return keepingFacts(value, hydrated(shape, value));
  switch (shape.kind) {
    case Wrapper.Optional:
      return hydratedForShape(shape.inner, value);
    case Wrapper.History:
      return value;
    default:
      return Array.isArray(value)
        ? (value as readonly unknown[]).map((item) => hydratedItem(shape.variants, item))
        : value;
  }
}

/** A hydrated copy of a value a test gave with `Metadata.with(…)` keeps what was stated about it. */
function keepingFacts(original: unknown, copy: unknown): unknown {
  if (typeof original !== "object" || original === null || copy === original) return copy;
  const facts = Metadata.of(original);
  return facts === undefined ? copy : trackValue(copy, facts);
}

function hydratedItem(variants: readonly [DtoClass, ...DtoClass[]], item: unknown): unknown {
  const dto = variants.length === 1 ? variants[0] : strictMatchOf(variants, item);
  return dto === undefined ? item : keepingFacts(item, hydrated(dto, item));
}
