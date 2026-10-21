import { describe, expect, it } from "vitest";
import { toolOf } from "../../src/testing/index.js";
import { renderToolResult, toolDefinitionOf } from "../../src/tools/index.js";
import { Clock } from "../fixtures/test-workflow/test.workflow.js";

describe("LangChain adapter", () => {
  it("renders values as JSON, strings as is, errors readably", () => {
    expect(renderToolResult({ kind: "ok", value: { a: 1 } })).toBe('{"a":1}');
    expect(renderToolResult({ kind: "ok", value: "plain" })).toBe("plain");
    expect(renderToolResult({ kind: "error", message: "boom" })).toBe("Tool error: boom");
  });

  it("#150: describes a tool to the model — name, description, input JSON Schema; running stays in invoke", () => {
    const tool = toolOf(new Clock(() => new Date("2026-09-24T10:00:00Z")));
    const definition = toolDefinitionOf(tool);

    expect(definition.type).toBe("function");
    expect(definition.function.name).toBe("current-time-tool");
    expect(definition.function.description).toContain("IANA");
    expect(definition.function.parameters).toMatchObject({ type: "object" });
    expect(definition.function.parameters).not.toHaveProperty("$schema");
  });
});
