/**
 * #395 PR 2 (S4): the trajectory matchers on a run result — `toHaveCalledTools([A, B])` (each at
 * least once, any order; `.not`: none of them) and `toHaveToolCallMatching(Tool, partialOrCheck)`
 * (`.not`: no call matches) — read from `result.toolCalls`; the script matcher is
 * `toHaveScriptedToolCalls`.
 */
import { describe, expect, it } from "vitest";
import { Tool, type ToolHandler } from "../../src/index.js";
import { Text } from "../../src/dto/index.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import {
  ClerkAgent,
  ClerkStart,
  LookupOrderTool,
  TrajectoryApplication,
} from "../app/fixtures/trajectory.workflow.js";

class RefundQuery {
  @Text() orderId!: string;
}

class RefundDone {
  @Text() status!: string;
}

/** A tool no agent of the application has: never in a trajectory. */
@Tool({ name: "refund-order-tool", description: "Refunds", input: RefundQuery, output: RefundDone })
class RefundOrderTool implements ToolHandler<RefundQuery, RefundDone> {
  run(): Promise<RefundDone> {
    return Promise.resolve({ status: "refunded" });
  }
}

const test = testWith(TrajectoryApplication);

/** The clerk looks up order "lost" (failed), then order 7 (found), then answers. */
const LOOKUPS = [
  callTool(LookupOrderTool, { orderId: "lost" }),
  callTool(LookupOrderTool, { orderId: "7" }),
  replyWith("Order 7 has shipped."),
] as const;

describe("toHaveCalledTools", () => {
  test("passes when each tool was called at least once, whatever the order and status", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ClerkAgent).thenReturn(...LOOKUPS);
    const result = await execute(app, ClerkStart, { text: "where are lost and 7?" });

    expect(result).toHaveCalledTools([LookupOrderTool]);
    expect(result).toHaveCalledTools([]);
  });

  test("fails naming what was called when one of them never was", async ({ app, mockLlm }) => {
    mockLlm(ClerkAgent).thenReturn(...LOOKUPS);
    const result = await execute(app, ClerkStart, { text: "where are lost and 7?" });

    expect(() => {
      expect(result).toHaveCalledTools([LookupOrderTool, RefundOrderTool]);
    }).toThrow(
      "expected a call of each of lookup-order-tool, refund-order-tool, it called lookup-order-tool (failed), lookup-order-tool (succeeded)",
    );
  });

  test(".not passes when none of them was called, and fails when one of them was", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ClerkAgent).thenReturn(...LOOKUPS);
    const result = await execute(app, ClerkStart, { text: "where are lost and 7?" });

    expect(result).not.toHaveCalledTools([RefundOrderTool]);
    expect(() => {
      expect(result).not.toHaveCalledTools([RefundOrderTool, LookupOrderTool]);
    }).toThrow("expected not any of refund-order-tool, lookup-order-tool to be called");
  });
});

describe("toHaveToolCallMatching", () => {
  test("a partial of the input: some call matches", async ({ app, mockLlm }) => {
    mockLlm(ClerkAgent).thenReturn(...LOOKUPS);
    const result = await execute(app, ClerkStart, { text: "where are lost and 7?" });

    expect(result).toHaveToolCallMatching(LookupOrderTool, { orderId: "7" });
    expect(result).not.toHaveToolCallMatching(LookupOrderTool, { orderId: "9" });
  });

  test("a check of the input, typed by the tool's input", async ({ app, mockLlm }) => {
    mockLlm(ClerkAgent).thenReturn(...LOOKUPS);
    const result = await execute(app, ClerkStart, { text: "where are lost and 7?" });

    expect(result).toHaveToolCallMatching(LookupOrderTool, (input) => input.orderId.length > 1);
    expect(result).not.toHaveToolCallMatching(LookupOrderTool, (input) => input.orderId === "");
    // @ts-expect-error -- the partial is typed by the tool's input: orderId is a string
    expect(result).not.toHaveToolCallMatching(LookupOrderTool, { orderId: 7 });
  });

  test("fails listing the tool's calls", async ({ app, mockLlm }) => {
    mockLlm(ClerkAgent).thenReturn(...LOOKUPS);
    const result = await execute(app, ClerkStart, { text: "where are lost and 7?" });

    expect(() => {
      expect(result).toHaveToolCallMatching(LookupOrderTool, { orderId: "9" });
    }).toThrow('its calls: {"orderId":"lost"}, {"orderId":"7"}');
  });
});

describe("the receiver", () => {
  it("is a run result, else the matcher says so", () => {
    expect(() => {
      expect({}).toHaveCalledTools([LookupOrderTool]);
    }).toThrow("toHaveCalledTools: expected a run result (app.execute / app.resume)");
    expect(() => {
      expect({}).toHaveToolCallMatching(LookupOrderTool, {});
    }).toThrow("toHaveToolCallMatching: expected a run result");
  });
});
