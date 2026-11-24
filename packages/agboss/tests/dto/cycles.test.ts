/**
 * #1080: a DTO that holds itself (through `@Nested` or `@List`, directly or via other DTOs) is a
 * typed error, never a stack overflow; a DTO used twice and a deep finite chain are fine.
 */
import { describe, expect, it } from "vitest";
import type { DtoClass } from "../../src/dto/types.js";
import { dtoCycleOf } from "../../src/dto/cycles.js";
import { DtoError } from "../../src/dto/errors.js";
import { hasSensitiveFields } from "../../src/dto/redact.js";
import { jsonSchemaOf, objectSchemaOf, validate } from "../../src/dto/schema.js";
import { chainOf, DiamondDto, PingDto, PongDto, SelfDto, TreeDto } from "./fixtures-cycles.js";

const names = (cycle: ReturnType<typeof dtoCycleOf>): string[] | undefined =>
  cycle?.map((dto) => dto.name);

describe("#1080 dtoCycleOf", () => {
  it("finds a DTO holding itself", () => {
    expect(names(dtoCycleOf(SelfDto))).toEqual(["SelfDto", "SelfDto"]);
  });

  it("finds a cycle through two DTOs, from either end", () => {
    expect(names(dtoCycleOf(PingDto))).toEqual(["PingDto", "PongDto", "PingDto"]);
    expect(names(dtoCycleOf(PongDto))).toEqual(["PongDto", "PingDto", "PongDto"]);
  });

  it("finds a cycle through List", () => {
    expect(names(dtoCycleOf(TreeDto))).toEqual(["TreeDto", "TreeDto"]);
  });

  it("a DTO used twice is not a cycle", () => {
    expect(dtoCycleOf(DiamondDto)).toBeUndefined();
  });

  it("a deep finite chain is not a cycle and cannot overflow the walk", () => {
    expect(dtoCycleOf(chainOf(20_000))).toBeUndefined();
  });
});

describe("#1080 every DTO walk refuses a cycle with dto.cyclic", () => {
  const cyclic: readonly (readonly [string, DtoClass, string])[] = [
    ["a direct self-cycle", SelfDto, "SelfDto → SelfDto"],
    ["a two-DTO cycle", PingDto, "PingDto → PongDto → PingDto"],
    ["a cycle through List", TreeDto, "TreeDto → TreeDto"],
  ];

  it.each(cyclic)("%s: the runtime schema", (_label, dto, path) => {
    expect(() => objectSchemaOf(dto)).toThrow(DtoError);
    expect(() => objectSchemaOf(dto)).toThrow(path);
  });

  it.each(cyclic)("%s: the model-facing JSON Schema", (_label, dto, path) => {
    expect(() => jsonSchemaOf(dto)).toThrow(/dto\.cyclic/);
    expect(() => jsonSchemaOf(dto)).toThrow(path);
  });

  it.each(cyclic)("%s: validate", (_label, dto) => {
    expect(() => validate(dto, {})).toThrow(/dto\.cyclic/);
  });

  it.each(cyclic)("%s: the sensitive-field walk terminates", (_label, dto) => {
    expect(hasSensitiveFields(dto)).toBe(false);
  });

  it("a diamond and a deep finite chain build their schemas", () => {
    expect(jsonSchemaOf(DiamondDto)).toMatchObject({ type: "object" });
    expect(jsonSchemaOf(chainOf(150))).toMatchObject({ type: "object" });
  });
});
