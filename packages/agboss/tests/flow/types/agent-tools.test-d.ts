import { describe, expectTypeOf, it } from "vitest";
import type { AgentToolNamesOf, ToolNameOf } from "../../../src/flow/generated-types.js";
import { callTool, callTools, replyWith } from "../../../src/testing/index.js";
import type { TurnFor } from "../../../src/testing/script-types.js";
import { BookBedTool, FreeBedsTool } from "../fixtures/clinic.fixture.js";
import { RefundCardTool, RefundClerkAgent } from "../fixtures/refunds.fixture.js";

/**
 * #679 AC1: `callTools(…)` is one of an agent's typed turns — two calls in one move compile without
 * a cast — and every call names a tool the agent lists (the generated `AgentTools`, each tool class
 * branded with its name): a tool of another agent does not compile, alone or inside `callTools`.
 */

type ClerkTurn = TurnFor<RefundClerkAgent>;

const card = { orderId: "A-1", amountCents: 500 };

describe("#679 AC1: an agent's tool calls are typed by the tools it lists", () => {
  it("the generated tables: the agent's tool names, each tool class by its name", () => {
    expectTypeOf<AgentToolNamesOf<RefundClerkAgent>>().toEqualTypeOf<"refund-card-tool">();
    expectTypeOf<ToolNameOf<RefundCardTool>>().toEqualTypeOf<"refund-card-tool">();
  });

  it("two calls of its tool in one move are one of its turns; one call is too", () => {
    const twice = callTools(callTool(RefundCardTool, card), callTool(RefundCardTool, card));

    expectTypeOf(twice).toExtend<ClerkTurn>();
    expectTypeOf(callTool(RefundCardTool, card)).toExtend<ClerkTurn>();
    expectTypeOf(replyWith("refunded")).toExtend<ClerkTurn>();
  });

  it("a tool the agent does not list does not compile, alone or among its own", () => {
    const other = callTool(FreeBedsTool, { unit: "icu" });
    const mixed = callTools(callTool(RefundCardTool, card), callTool(BookBedTool, { unit: "icu" }));

    expectTypeOf(other).not.toExtend<ClerkTurn>();
    expectTypeOf(mixed).not.toExtend<ClerkTurn>();
    // @ts-expect-error — free-beds-tool is not one of refund-clerk-agent's tools
    const refused: ClerkTurn = other;
    expectTypeOf(refused).not.toBeNever();
  });
});
