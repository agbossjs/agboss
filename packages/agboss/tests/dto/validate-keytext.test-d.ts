import { describe, expectTypeOf, it } from "vitest";
import {
  KeyText,
  Text,
  Validate,
  jsonSchemaOf,
  maskDto,
  validate,
  type DtoCheck,
  type ValidationIssue,
} from "../../src/dto/index.js";

/** #1292b: type pins of @Validate, @KeyText, validate, jsonSchemaOf and maskDto. */
describe("#1292b: type pins", () => {
  it("@KeyText decorates a string field and nothing else", () => {
    class Ok {
      @KeyText()
      id!: string;
      @KeyText({ optional: true })
      maybe?: string;
    }
    class Wrong {
      // @ts-expect-error -- a key's text is a string
      @KeyText()
      id!: number;
    }
    expectTypeOf<typeof Ok>().toBeConstructibleWith();
    expectTypeOf<typeof Wrong>().toBeConstructibleWith();
  });

  it("@Validate takes a check of the class's own type", () => {
    @Validate<Range>(({ from, to }) => from <= to || { field: "to", reason: "x" })
    class Range {
      @Text()
      from!: string;
      @Text()
      to!: string;
    }
    // @ts-expect-error -- a field that is not the DTO's
    @Validate<Range>(() => ({ field: "nope", reason: "x" }))
    class Bad {
      @Text()
      x!: string;
    }
    expectTypeOf<ValidationIssue<Range>>().toEqualTypeOf<
      string | { readonly field?: "from" | "to"; readonly reason: string }
    >();
    expectTypeOf<DtoCheck<Range>>().parameter(0).toEqualTypeOf<Range>();
    expectTypeOf<typeof Bad>().toBeConstructibleWith();
  });

  it("validate returns the DTO; jsonSchemaOf a readonly record; maskDto a record", () => {
    class Dto {
      @Text()
      x!: string;
    }
    expectTypeOf(validate(Dto, {})).toEqualTypeOf<Dto>();
    expectTypeOf(jsonSchemaOf(Dto)).toEqualTypeOf<Readonly<Record<string, unknown>>>();
    expectTypeOf(maskDto(Dto, { x: "" })).toEqualTypeOf<Record<string, unknown>>();
  });
});
