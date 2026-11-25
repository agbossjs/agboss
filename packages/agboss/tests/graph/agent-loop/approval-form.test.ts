import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool, type AnyTool } from "../../../src/tools/index.js";
import { callTools, harness, replyWith, runLoop, startInput, decision } from "./fixtures.js";

/**
 * A tool that names its `approval` (#1307) waits for it: the money path never runs a call nobody
 * approved. A tool with no approval runs at once.
 */
const tool =
  (isApproved: boolean) =>
  (log: (effect: string) => void): AnyTool[] => [
    defineTool({
      name: "refund",
      description: "Refund a payment",
      input: z.object({ path: z.string(), content: z.string() }),
      output: z.string(),
      ...(isApproved ? { approval: "terminal-tool-approval" } : {}),
      run: () => {
        log("refunded");
        return Promise.resolve("refunded");
      },
    }),
  ];

describe("a tool with an approval", () => {
  it("does not run before its approval; runs once after it", async () => {
    const h = harness({
      moves: [
        callTools({ id: "r1", name: "refund", args: { path: "p", content: "c" } }),
        replyWith("done"),
      ],
      tools: tool(true),
    });

    const paused = await runLoop(h.graph, startInput(), "t");
    expect(paused).toMatchObject({ kind: "paused", pending: { callId: "r1", tool: "refund" } });
    expect(h.effects).toEqual([]);

    await runLoop(h.graph, decision({ approved: true }), "t");
    expect(h.effects).toEqual(["refunded"]);
  });

  it("a declined call never runs", async () => {
    const h = harness({
      moves: [
        callTools({ id: "r1", name: "refund", args: { path: "p", content: "c" } }),
        replyWith("no"),
      ],
      tools: tool(true),
    });
    await runLoop(h.graph, startInput(), "t");
    await runLoop(h.graph, decision({ approved: false, reason: "no" }), "t");
    expect(h.effects).toEqual([]);
  });

  it("a tool with no approval runs at once", async () => {
    const h = harness({
      moves: [
        callTools({ id: "r1", name: "refund", args: { path: "p", content: "c" } }),
        replyWith("done"),
      ],
      tools: tool(false),
    });

    await runLoop(h.graph, startInput(), "t");

    expect(h.effects).toEqual(["refunded"]);
  });
});
