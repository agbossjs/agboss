/** #1294 at compile time: `execute` is the tool method, sync or async; `run` is not one. */
import { describe, expectTypeOf, it } from "vitest";
import { Tool, type ToolHandler } from "../../src/index.js";
import { Text } from "../../src/dto/index.js";
import type { ToolInputOf, ToolOutputOf } from "../../src/testing/index.js";

class Query {
  @Text({ prompt: "q" })
  q!: string;
}

class Found {
  @Text({ prompt: "f" })
  f!: string;
}

const options = { name: "pin-tool", description: "d", input: Query, output: Found };

describe("#1294: the tool method", () => {
  it("ToolHandler is execute, returning the output or a promise of it", () => {
    expectTypeOf<ToolHandler<Query, Found>["execute"]>().toEqualTypeOf<
      (input: Query) => Found | Promise<Found>
    >();
    expectTypeOf<ToolHandler<Query, Found>>().not.toHaveProperty("run");
  });

  it("a synchronous, an asynchronous and a parameterless execute compile, with no implements", () => {
    @Tool(options)
    class Sync {
      execute(input: Query): Found {
        return { f: input.q };
      }
    }
    @Tool(options)
    class Async {
      execute(input: Query): Promise<Found> {
        return Promise.resolve({ f: input.q });
      }
    }
    @Tool(options)
    class Parameterless {
      execute(): Found {
        return { f: "" };
      }
    }

    expectTypeOf<ToolInputOf<Sync>>().toEqualTypeOf<Query>();
    expectTypeOf<ToolOutputOf<Sync>>().toEqualTypeOf<Found>();
    expectTypeOf<ToolOutputOf<Async>>().toEqualTypeOf<Found>();
    expectTypeOf(Parameterless).toBeConstructibleWith();
  });

  it("run is not a tool method; a wrong sync output does not compile", () => {
    // @ts-expect-error — the method is `execute`; `run` (0.1.0) is gone
    @Tool(options)
    class Old {
      run(): Promise<Found> {
        return Promise.resolve({ f: "" });
      }
    }
    // @ts-expect-error — execute returns what the output DTO does not allow
    @Tool(options)
    class Wrong {
      execute(): number {
        return 1;
      }
    }

    expectTypeOf(Old).toBeConstructibleWith();
    expectTypeOf(Wrong).toBeConstructibleWith();
  });
});
