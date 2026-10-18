import { tool } from "@langchain/core/tools";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Integer, OneOf, schemaOf, Text } from "./dto.js";
import { FileWrite, TestRun, runTestsTool } from "./fixture.js";
import { toolDefinition } from "./request.js";

const inputSchema = (dto: Parameters<typeof schemaOf>[0]): string =>
  JSON.stringify(z.toJSONSchema(schemaOf(dto), { io: "input" }));

class OptionsInOneOrder {
  @Integer({ prompt: "how many", min: 1, max: 5, optional: true })
  count?: number;

  @OneOf({ values: ["a", "b"], prompt: "which", example: "a" })
  pick!: "a" | "b";
}

class OptionsInAnotherOrder {
  @Integer({ optional: true, max: 5, min: 1, prompt: "how many" })
  count?: number;

  @OneOf({ example: "a", prompt: "which", values: ["a", "b"] })
  pick!: "a" | "b";
}

class FileWriteRenamed {
  @Text({ prompt: "relative to the repository root" })
  path!: string;

  @Text({ prompt: "the whole new content of the file" })
  content!: string;
}

class FileWriteReordered {
  @Text({ prompt: "the whole new content of the file" })
  content!: string;

  @Text({ prompt: "relative to the repository root" })
  path!: string;
}

class FileWriteSensitive {
  @Text({ prompt: "relative to the repository root", sensitive: "mask" })
  path!: string;

  @Text({ prompt: "the whole new content of the file" })
  content!: string;
}

describe("spike #115 — JSON Schema from DTO classes is deterministic", () => {
  it("produces byte-identical schema text on every call", () => {
    expect(inputSchema(FileWrite)).toBe(inputSchema(FileWrite));
  });

  it("does not depend on the order of options inside a field decorator", () => {
    expect(inputSchema(OptionsInOneOrder)).toBe(inputSchema(OptionsInAnotherOrder));
  });

  it("does not contain the class name: renaming the DTO class changes nothing", () => {
    expect(inputSchema(FileWriteRenamed)).toBe(inputSchema(FileWrite));
  });

  it("keeps fields in declaration order — properties and required alike", () => {
    const schema = z.toJSONSchema(schemaOf(FileWriteReordered), { io: "input" });

    expect(Object.keys(schema.properties ?? {})).toEqual(["content", "path"]);
    expect(schema.required).toEqual(["content", "path"]);
  });

  it("leaves optional and defaulted fields out of required on the input side", () => {
    const schema = z.toJSONSchema(schemaOf(TestRun), { io: "input" });

    expect(schema.required).toBeUndefined();
    expect(schema.properties?.project).toMatchObject({
      default: "unit",
      description: "which project",
    });
  });

  it("puts `prompt` in `description`, `example` in `examples`, and never `sensitive`", () => {
    expect(JSON.parse(inputSchema(OptionsInOneOrder))).toMatchObject({
      properties: { pick: { description: "which", examples: ["a"] } },
    });
    expect(inputSchema(FileWriteSensitive)).toBe(inputSchema(FileWrite));
  });

  it("is rewritten by LangChain on the way to the model: $schema becomes draft-07", async () => {
    const wire = await toolDefinition(runTestsTool("/nowhere"));

    expect(wire.parameters.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(z.toJSONSchema(schemaOf(TestRun)).$schema).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
  });

  it("differs by path: a zod schema handed to LangChain is serialised as output (defaulted fields required, closed)", () => {
    const fromZod = convertToOpenAITool(
      tool(() => "", { name: "run-tests", description: "d", schema: schemaOf(TestRun) }),
    ).function.parameters;

    expect(fromZod).toMatchObject({ required: ["project"], additionalProperties: false });
  });
});
