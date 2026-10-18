import { maskedDtoValue, type FieldMask } from "../dto/redact.js";
import type { DtoClass } from "../dto/types.js";
import { isWrapper, Wrapper, type AnyWrapper } from "../flow/dto-wrappers.js";
import { PiiActionKind } from "./actions.js";
import { kindPlaceholder, partReplaced } from "./replacement.js";
import { tokenOf, type PiiTokenMap } from "./tokens.js";

/**
 * `sensitive: PiiAction.…` fields on the way into a model (#120 AC8): their values through their
 * actions before the text is built — a token is one of the execution's `piiTokens`, revealed when
 * the model gives it back like any other.
 */

/** A field mask that makes tokens, and the tokens it made. */
export interface TokenFieldMask {
  readonly mask: FieldMask;
  readonly tokens: Readonly<Record<string, string>>;
}

/** The mask of the model boundary: tokens with `key`, new ones collected. */
export function tokenFieldMask(key: string, known: PiiTokenMap): TokenFieldMask {
  const tokens: Record<string, string> = {};
  const mask: FieldMask = (action, label, value) => {
    switch (action.kind) {
      case PiiActionKind.ReplacePart:
        return partReplaced(value, action.part);
      case PiiActionKind.ReplaceWithKind:
        return kindPlaceholder(label);
      case PiiActionKind.ReplaceWithToken: {
        const token = tokenOf(label, value, key, { ...known, ...tokens });
        tokens[token] = value;
        return token;
      }
    }
  };
  return { mask, tokens };
}

/** The type of a shape: a DTO, a wrapper — or what an input field reads. */
export type ShapeOf = DtoClass | AnyWrapper;

function dtoOfShape(shape: ShapeOf, variant: string | undefined): DtoClass | undefined {
  if (!isWrapper(shape)) return shape;
  switch (shape.kind) {
    case Wrapper.Optional:
      return dtoOfShape(shape.inner, variant);
    case Wrapper.List:
      return dtoOfShape(shape.element, variant);
    case Wrapper.History:
      return shape.dto;
    case Wrapper.OneOf:
      return shape.variants.find((dto) => dto.name === variant);
  }
}

/** A value of a shape with its sensitive fields masked (each element of a list). */
export function maskedShapeValue(
  shape: ShapeOf,
  value: unknown,
  mask: FieldMask,
  variant?: string,
): unknown {
  if (Array.isArray(value))
    return value.map((item: unknown) => maskedShapeValue(shape, item, mask, variant));
  const dto = dtoOfShape(shape, variant);
  return dto === undefined ? value : maskedDtoValue(dto, value, mask);
}
