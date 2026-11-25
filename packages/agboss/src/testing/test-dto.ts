import { maskDto } from "../dto/redact.js";
import { jsonSchemaOf, validate } from "../dto/schema.js";
import type { DtoClass } from "../dto/types.js";

/** One DTO on its own (#1328): what the framework does with its data, at `$0`. */
export interface DtoTestHarness<TDto extends object> {
  /** The raw data as the DTO takes it: the validated value, or `ValidationError.DtoInvalid` naming every issue. */
  validate(raw: unknown): TDto;
  /** The value as logs and traces show it: every `sensitive` field one-way masked, nested DTOs too. */
  mask(value: TDto): Record<string, unknown>;
  /** The JSON Schema the model sees for the DTO. */
  jsonSchema(): Readonly<Record<string, unknown>>;
}

/**
 * A DTO on its own (#1328): `testDto(OrderDto).validate({ … })`, `.mask(order)`, `.jsonSchema()`, no
 * application, no generated types, no model.
 */
export function testDto<TDto extends DtoClass>(dto: TDto): DtoTestHarness<InstanceType<TDto>> {
  return {
    validate: (raw) => validate(dto, raw) as InstanceType<TDto>,
    mask: (value) => maskDto(dto, value),
    jsonSchema: () => jsonSchemaOf(dto),
  };
}
