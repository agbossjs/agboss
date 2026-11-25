import { describe, expectTypeOf, it } from "vitest";
import { Agent, type AgentOptions } from "../../../src/flow/decorators/agent.js";

/** #1313: `price` is gone from `@Agent` — a provider's `cost` and `models` table price its calls. */
describe("#1313: @Agent has no price", () => {
  it("AgentOptions has no price key, and a literal with one does not compile", () => {
    expectTypeOf<AgentOptions>().not.toHaveProperty("price");
    // @ts-expect-error `price` is not an option of @Agent
    const decorate = Agent({ name: "a-agent", description: "d", price: { inputPerMTok: 1 } });
    expectTypeOf(decorate).toBeFunction();
  });
});
