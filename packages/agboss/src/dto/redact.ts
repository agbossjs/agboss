import { PiiActionKind, type MaskingPiiAction } from "../pii/actions.js";
import { kindPlaceholder, partReplaced } from "../pii/replacement.js";
import { fieldsOf } from "./metadata.js";
import type { DtoClass, FieldSpec } from "./types.js";

/**
 * `sensitive: PiiAction.…` on a DTO field (#120 AC8): the field's value goes through its action
 * wherever it leaves the execution — to a model (the boundary makes the tokens), to a channel and
 * its logs (#202), to an observer. A sensitive field's label is its name in kebab case (`<author>`).
 */

/** What a sensitive field's value becomes: its action, its label and the value as text. */
export type FieldMask = (action: MaskingPiiAction, label: string, value: string) => string;

/** `userId` → `user-id`: the label of a sensitive field's placeholder or token. */
export const fieldLabelOf = (name: string): string =>
  name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

/**
 * Where people see a value (a channel's request, a pending pause): one-way — a token field shows
 * as its placeholder, like `replaceWithKind()`.
 */
export const displayMask: FieldMask = (action, label, value) =>
  action.kind === PiiActionKind.ReplacePart
    ? partReplaced(value, action.part)
    : kindPlaceholder(label);

/** The DTO each object schema was built from (`schemaOf`), so a tool's input can be masked. */
const dtoOfSchema = new WeakMap<object, DtoClass>();

/** Remembers which DTO a schema was built from (internal: `objectSchemaOf`). */
export const rememberDtoOf = (schema: object, dto: DtoClass): void => {
  dtoOfSchema.set(schema, dto);
};

/** The DTO a schema was built from; none for a schema of its own (an MCP tool). */
export const dtoOf = (schema: object): DtoClass | undefined => dtoOfSchema.get(schema);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const textOf = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);

function maskedField(field: FieldSpec, value: unknown, mask: FieldMask): unknown {
  if (value === undefined || value === null) return value;
  const action = field.settings.sensitive;
  if (action !== undefined) return mask(action, fieldLabelOf(field.name), textOf(value));
  const element = field.element;
  if (element?.kind !== "dto") return value;
  return Array.isArray(value)
    ? value.map((item: unknown) => maskedDtoValue(element.dto, item, mask))
    : maskedDtoValue(element.dto, value, mask);
}

/** A DTO's fields with every `sensitive` one (nested and listed DTOs included) through `mask`. */
function maskedRecord(
  dto: DtoClass,
  value: Record<string, unknown>,
  mask: FieldMask,
): Record<string, unknown> {
  const fields = new Map(fieldsOf(dto).map((field) => [field.name, field]));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      const field = fields.get(key);
      return [key, field === undefined ? item : maskedField(field, item, mask)];
    }),
  );
}

/** A DTO's value with every `sensitive` field through `mask`; anything but an object stays. */
export const maskedDtoValue = (dto: DtoClass, value: unknown, mask: FieldMask): unknown =>
  isRecord(value) ? maskedRecord(dto, value, mask) : value;

/** A DTO's value as people may see it: every `sensitive` field one-way masked. */
export const redactedDto = (dto: DtoClass, value: unknown): unknown =>
  maskedDtoValue(dto, value, displayMask);

/**
 * Tool arguments as they may be shown (#202): the fields the tool's input DTO marks `sensitive`
 * masked. Arguments of a schema not built from a DTO (an MCP tool) are returned as they are.
 */
export function redactedArguments(
  schema: object,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const dto = dtoOfSchema.get(schema);
  return dto === undefined ? args : maskedRecord(dto, args, displayMask);
}

/** Whether a DTO (or a nested one) has a `sensitive` field. */
export const hasSensitiveFields = (dto: DtoClass): boolean =>
  fieldsOf(dto).some(
    (field) =>
      field.settings.sensitive !== undefined ||
      (field.element?.kind === "dto" && hasSensitiveFields(field.element.dto)),
  );
