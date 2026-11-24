import { describe, expectTypeOf, it } from "vitest";
import { ToolInterceptor, type ToolCallDecision } from "../../src/index.js";

/** #1295: `@ToolInterceptor(options?)` takes no argument; `allow({ input })` takes an object. */
describe("#1295: @ToolInterceptor type pins", () => {
  it("options are optional", () => {
    expectTypeOf(ToolInterceptor).toBeCallableWith();
    expectTypeOf(ToolInterceptor).toBeCallableWith({ name: "audit" });
    // @ts-expect-error -- the options are an object
    ToolInterceptor("audit");
  });

  it("ToolCallDecision.allow({ input }) takes an object input", () => {
    expectTypeOf<typeof ToolCallDecision.allow>().toBeCallableWith();
    expectTypeOf<ToolCallDecision<{ id: string }>>().not.toBeAny();
  });
});
