/**
 * #1294: a tool's method is `execute(input)` and may return its output directly; a tool needs no
 * `implements`. The old `run` is not a tool method any more (compile-time pins in
 * `tool-execute.test-d.ts`).
 */
import { describe, expect, it } from "vitest";
import { Tool } from "../../src/index.js";
import { toolOf } from "../../src/components/runtime.js";
import { Text } from "../../src/dto/index.js";
import { testTool } from "../../src/testing/index.js";

class Query {
  @Text({ prompt: "what to look up" })
  query!: string;
}

class Found {
  @Text({ prompt: "what was found" })
  found!: string;
}

@Tool({ name: "sync-lookup", description: "d", input: Query, output: Found })
class SyncLookup {
  execute({ query }: Query): Found {
    return { found: query.toUpperCase() };
  }
}

@Tool({ name: "async-lookup", description: "d", input: Query, output: Found })
class AsyncLookup {
  execute({ query }: Query): Promise<Found> {
    return Promise.resolve({ found: query });
  }
}

describe("#1294: execute returns the output or a promise of it", () => {
  it("a synchronous tool runs and its output is validated", async () => {
    const run = testTool(SyncLookup);

    expect((await run({ query: "ab" })).output).toEqual({ found: "AB" });
  });

  it("an asynchronous tool runs the same way", async () => {
    const run = testTool(AsyncLookup);

    expect((await run({ query: "ab" })).output).toEqual({ found: "ab" });
  });

  it("toolOf invokes a synchronous execute as a tool", async () => {
    const tool = toolOf(new SyncLookup());

    const result = await tool.invoke({ query: "ab" });

    expect(result).toEqual({ kind: "ok", value: { found: "AB" } });
  });
});
