/** #118 AC5: the JSON Schema the model sees for a DTO. */
import { describe, expect, it } from "vitest";
import { Integer, ListOf, NoInputDto, OneOf, Text } from "../../src/dto/index.js";
import { jsonSchemaOf } from "../../src/dto/schema.js";
import { PiiAction } from "../../src/pii/actions.js";

class Task {
  @Text({ prompt: "what to do", example: "write tests" })
  title!: string;

  @OneOf({ values: ["low", "high"], prompt: "how urgent" })
  priority!: "low" | "high";

  @Integer({ prompt: "minutes it may take", min: 1, default: 30 })
  minutes!: number;

  @ListOf(Text, { optional: true, maxItems: 3 })
  labels?: string[];

  @Text({ sensitive: PiiAction.replaceWithKind() })
  owner!: string;
}

describe("DTO JSON Schema (#118)", () => {
  it("AC5: declaration order, description = prompt, examples, io input, no $schema", () => {
    // JSON text keeps the order the model reads (a snapshot of the object would sort keys)
    expect(JSON.stringify(jsonSchemaOf(Task), null, 2)).toMatchInlineSnapshot(`
      "{
        "type": "object",
        "properties": {
          "title": {
            "type": "string",
            "description": "what to do",
            "examples": [
              "write tests"
            ]
          },
          "priority": {
            "type": "string",
            "enum": [
              "low",
              "high"
            ],
            "description": "how urgent"
          },
          "minutes": {
            "default": 30,
            "description": "minutes it may take",
            "type": "integer",
            "minimum": 1,
            "maximum": 9007199254740991
          },
          "labels": {
            "maxItems": 3,
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "owner": {
            "type": "string"
          }
        },
        "required": [
          "title",
          "priority",
          "owner"
        ]
      }"
    `);
  });

  it("AC5: property order follows declaration order", () => {
    class Reversed {
      @Text() zeta!: string;
      @Text() alpha!: string;
    }

    expect(Object.keys(jsonSchemaOf(Reversed).properties as object)).toEqual(["zeta", "alpha"]);
  });

  it("AC5: an empty DTO is an object with no properties", () => {
    expect(jsonSchemaOf(NoInputDto)).toEqual({ type: "object", properties: {} });
  });
});
