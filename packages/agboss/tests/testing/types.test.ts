/**
 * AC12 (#135): `callTool(Tool, args)` is typed by the tool's input DTO. `make check` runs `tsc`; an
 * `@ts-expect-error` whose line compiles would itself fail the build — so every marked line below
 * must stay a compile error (the documented pattern for compile-time tests, Wiki → Testing).
 */
import { describe, expect, it } from "vitest";
import { callTool } from "../../src/testing/index.js";
import { OrderStatus, SaveNote } from "./fixtures/desk.workflow.js";

/** A class that is not a tool. */
class NotATool {
  readonly name = "not a tool";
}

describe("AC12: callTool(Tool, args) is checked by the compiler", () => {
  it("accepts the tool's input DTO and refuses anything else", () => {
    const ok = callTool(OrderStatus, { orderId: "42" });
    const note = callTool(SaveNote, { title: "t", text: "x" });

    // @ts-expect-error — orderId is a string in the tool's input DTO
    callTool(OrderStatus, { orderId: 42 });
    // @ts-expect-error — the input DTO has no field "order"
    callTool(OrderStatus, { order: "42" });
    // @ts-expect-error — a required field is missing
    callTool(SaveNote, { title: "t" });
    expect(() =>
      // @ts-expect-error — not a tool class: its instances have no run(input)
      callTool(NotATool, {}),
    ).toThrow("NotATool is not a @Tool, @McpTool, @Rag or question role");

    expect([ok, note].map((turn) => turn.kind)).toEqual(["tool-call", "tool-call"]);
  });
});
