/**
 * #1328: what `testWith` and the test app take besides the application — `startAt` (the clock's first
 * moment), `runTool` / `runAgent` / `runRouter` (one component on its own), `mockTool(T).thenReturn`.
 */
import { describe, expect } from "vitest";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { DeskApplication, OrderStatus, Support } from "./fixtures/desk.workflow.js";

const start = testWith(DeskApplication, { startAt: "2026-03-01T10:00:00Z" });
const plain = testWith(DeskApplication);

describe("#1328: testWith({ startAt })", () => {
  start("the test clock starts at the given moment", ({ clock }) => {
    expect(clock.now().toISOString()).toBe("2026-03-01T10:00:00.000Z");
  });

  plain("without it, the clock starts at the default moment", ({ clock }) => {
    expect(clock.now().toISOString()).toBe("2026-01-05T09:00:00.000Z");
  });
});

describe("#1328: mockTool(T).thenReturn and app.runTool", () => {
  plain(
    "the next call returns the scripted output; the tool is not run",
    async ({ app, mockTool }) => {
      mockTool(OrderStatus).thenReturn({ status: "shipped" });

      const output = await app.runTool(OrderStatus, { orderId: "7" });

      expect(output).toMatchObject({ kind: "ok", value: { status: "shipped" } });
    },
  );

  plain(
    "an agent reads the scripted output as the tool's own",
    async ({ app, mockLlm, mockTool }) => {
      mockTool(OrderStatus).thenReturn({ status: "lost" });
      mockLlm(Support).thenReturn(
        callTool(OrderStatus, { orderId: "7" }),
        replyWith("It is lost."),
      );

      expect(await app.runAgent(Support, "Where is order 7?")).toBe("It is lost.");
    },
  );

  plain.fails("an output no call took fails the test at its end", ({ mockTool }) => {
    mockTool(OrderStatus).thenReturn({ status: "never read" });
  });
});
