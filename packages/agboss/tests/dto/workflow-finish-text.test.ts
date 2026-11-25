import { describe, expect, it } from "vitest";
import { PlainTextDto, WorkflowFinishTextDto } from "../../src/dto/index.js";
import { jsonSchemaOf } from "../../src/dto/schema.js";
import { fieldsOf } from "../../src/dto/metadata.js";
import { isJudgedBy } from "../../src/flow/analyse/rules/text-agents.js";
import { describedShapeOf } from "../../src/flow/runtime/join-keys.js";
import { versionOf } from "../../src/turns/versions.js";

/**
 * #1290: `WorkflowFinishTextDto extends PlainTextDto`, so one `@Judge({ output: PlainTextDto })` judges an
 * agent's text and a text finish alike; the finish's own schema and hash did not change.
 */
describe("WorkflowFinishTextDto is a PlainTextDto", () => {
  it("is judged by a PlainTextDto judge, but a PlainTextDto is not judged by its own judge", () => {
    expect(isJudgedBy(WorkflowFinishTextDto, PlainTextDto)).toBe(true);
    expect(isJudgedBy(PlainTextDto, WorkflowFinishTextDto)).toBe(false);
    expect(Object.getPrototypeOf(WorkflowFinishTextDto)).toBe(PlainTextDto);
  });

  it("has one text field, its own: the inherited one is replaced, never listed twice", () => {
    expect(fieldsOf(WorkflowFinishTextDto).map((field) => field.name)).toEqual(["text"]);
    expect(fieldsOf(PlainTextDto).map((field) => field.name)).toEqual(["text"]);
  });

  it("keeps its schema and its hash byte-identical to the standalone class", () => {
    expect(jsonSchemaOf(WorkflowFinishTextDto)).toEqual({
      type: "object",
      properties: {
        text: { type: "string", description: "the text the run finishes with, in plain words" },
      },
      required: ["text"],
    });
    expect(jsonSchemaOf(PlainTextDto)).toMatchObject({
      properties: { text: { description: "the text" } },
    });
    expect(versionOf(describedShapeOf(WorkflowFinishTextDto))).toBe(
      "995443c3e65d690d23afc22acdd84ffcd749bc0ca1aebe61e1be5d39bf736344",
    );
  });
});
