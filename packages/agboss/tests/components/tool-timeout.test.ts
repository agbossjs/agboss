/**
 * #268 AC11: every timeout is a value with units — `@Tool({ timeout: seconds(5) })`; `timeoutMs`
 * does not exist and a bare number is not a duration (compile-time, checked by `tsc`).
 */
import { describe, expect, it } from "vitest";
import { Tool, type ToolHandler } from "../../src/index.js";
import { McpTool } from "../../src/components/decorators.js";
import { Text } from "../../src/dto/index.js";
import { testTool } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";

class Query {
  @Text({ prompt: "what to look up" })
  query!: string;
}

@Tool({ name: "quick-tool", description: "d", input: Query, output: Query, timeout: seconds(5) })
class QuickTool implements ToolHandler<Query, Query> {
  run(input: Query): Promise<Query> {
    return Promise.resolve(input);
  }
}

describe("#268 AC11: a tool's timeout has units", () => {
  it("timeout: seconds(5) compiles; timeoutMs and a bare number do not", async () => {
    const options = { name: "x-tool", description: "d", input: Query, output: Query };
    // @ts-expect-error — timeoutMs does not exist: a timeout is `timeout: seconds(5)`
    Tool({ ...options, timeoutMs: 5000 });
    // @ts-expect-error — a bare number is not a duration
    Tool({ ...options, timeout: 5000 });
    // @ts-expect-error — the same for an MCP tool
    McpTool({ ...options, server: QuickTool, timeoutMs: 5000 });

    const { output } = await testTool(QuickTool)({ query: "x" });

    expect(output).toEqual({ query: "x" });
  });
});
