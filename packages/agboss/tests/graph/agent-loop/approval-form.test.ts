import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool, type AnyTool } from "../../../src/tools/index.js";
import { callTools, harness, replyWith, runLoop, startInput, decision } from "./fixtures.js";

/**
 * A tool that names its approval by the new `approval` form (#1307) waits for it exactly as one
 * with the old `channel` does: the money path never runs a call nobody approved.
 */
const tool =
  (form: "approval" | "channel" | "both-hand-built") =>
  (log: (effect: string) => void): AnyTool[] => {
    const base = defineTool({
      name: "refund",
      description: "Refund a payment",
      input: z.object({ path: z.string(), content: z.string() }),
      output: z.string(),
      ...(form === "channel" ? { channel: "terminal" } : { approval: "terminal" }),
      run: () => {
        log("refunded");
        return Promise.resolve("refunded");
      },
    });
    // a Tool built by hand with only `approval` (no `channel`), as an adapter could hand it over
    return [form === "both-hand-built" ? { ...base, channel: undefined } : base];
  };

describe.each(["approval", "channel", "both-hand-built"] as const)(
  "a tool with the %s form",
  (form) => {
    it("does not run before its approval; runs once after it", async () => {
      const h = harness({
        moves: [
          callTools({ id: "r1", name: "refund", args: { path: "p", content: "c" } }),
          replyWith("done"),
        ],
        tools: tool(form),
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
        tools: tool(form),
      });
      await runLoop(h.graph, startInput(), "t");
      await runLoop(h.graph, decision({ approved: false, reason: "no" }), "t");
      expect(h.effects).toEqual([]);
    });
  },
);

describe("the two spellings of one approval", () => {
  const define = (extra: { channel?: string; approval?: string }) =>
    defineTool({
      name: "refund",
      description: "Refund",
      input: z.object({}),
      output: z.string(),
      ...extra,
      run: () => Promise.resolve("ok"),
    });

  it("approval is read as the tool's channel; the same name in both is one", () => {
    expect(define({ approval: "terminal" }).channel).toBe("terminal");
    expect(define({ approval: "terminal", channel: "terminal" }).channel).toBe("terminal");
  });

  it("two different names are refused, never one picked", () => {
    expect(() => define({ approval: "a-channel", channel: "b-channel" })).toThrow(
      "tool refund: channel and approval name different channels",
    );
  });
});
