/** #1292a: `@Enum` takes values or a string enum; `@List` takes an enum's values; the renamed decorators give the schema they always gave. */
import { describe, expect, it } from "vitest";
import {
  Bool,
  Enum,
  Float,
  Integer,
  IsoDate,
  IsoDateTime,
  IsoDuration,
  List,
  Text,
} from "../../src/dto/index.js";
import { jsonSchemaOf, validate } from "../../src/dto/schema.js";

enum Status {
  Draft = "draft",
  Paid = "paid",
}

class InvoiceDto {
  @Enum(Status, { default: Status.Draft })
  status!: Status;

  @Enum(["low", "normal", "urgent"], { optional: true })
  priority?: "low" | "normal" | "urgent";

  @List(Status)
  history!: Status[];

  @List(["a", "b"], { optional: true })
  marks?: ("a" | "b")[];

  @List(Text, { minItems: 1 })
  tags!: readonly string[];

  @Float({ min: 0, max: 1 })
  taxRate!: number;

  @Bool({ default: false })
  expedited!: boolean;

  @IsoDate()
  issued!: string;

  @IsoDateTime()
  created!: string;

  @IsoDuration()
  grace!: string;

  @Integer()
  count!: number;
}

const valid = {
  history: ["paid"],
  tags: ["x"],
  taxRate: 0.5,
  issued: "2026-10-01",
  created: "2026-10-01T09:00:00+03:00",
  grace: "PT30M",
  count: 1,
};

describe("#1292a: @Enum and @List", () => {
  it("an enum object and a tuple give the same schema as the old values list", () => {
    const schema = jsonSchemaOf(InvoiceDto) as { properties: Record<string, unknown> };
    expect(schema.properties.status).toMatchObject({ type: "string", enum: ["draft", "paid"] });
    expect(schema.properties.priority).toMatchObject({ enum: ["low", "normal", "urgent"] });
    expect(schema.properties.history).toMatchObject({
      type: "array",
      items: { type: "string", enum: ["draft", "paid"] },
    });
    expect(schema.properties.marks).toMatchObject({ items: { enum: ["a", "b"] } });
  });

  it("the renamed scalars keep their formats", () => {
    const { properties } = jsonSchemaOf(InvoiceDto) as { properties: Record<string, object> };
    expect(properties.taxRate).toMatchObject({ type: "number", minimum: 0, maximum: 1 });
    expect(properties.expedited).toMatchObject({ type: "boolean" });
    expect(properties.issued).toMatchObject({ format: "date" });
    expect(properties.created).toMatchObject({ format: "date-time" });
    expect(properties.grace).toMatchObject({ format: "duration" });
  });

  it("validates values of an enum list and defaults the rest", () => {
    expect(validate(InvoiceDto, valid)).toMatchObject({ status: "draft", expedited: false });
    expect(() => validate(InvoiceDto, { ...valid, history: ["nope"] })).toThrow();
    expect(() => validate(InvoiceDto, { ...valid, marks: ["c"] })).toThrow();
    expect(() => validate(InvoiceDto, { ...valid, status: "other" })).toThrow();
  });
});
