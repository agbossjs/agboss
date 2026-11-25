/**
 * #1295c security review: a call id the model reuses never meets an old approval, a call whose
 * arguments are no input of its tool never reaches the tool, an unknown tool ends as an invalid call.
 */
import type { AnyTool, ToolOutput } from "../../../src/tools/index.js";
import { describe, expect, it } from "vitest";
import { makePrepareNode } from "../../../src/graph/agent-loop/prepare-node.js";
import {
  callTools,
  decision,
  harness,
  repoTools,
  replyWith,
  runLoop,
  startInput,
  stateOf,
  toolMessagesOf,
  write,
} from "./fixtures.js";

describe("#1295c: a reused call id is a new call", () => {
  it("new arguments under a reused call id are checked again and asked about again, never run under the old approval", async () => {
    const h = harness({
      moves: [
        callTools(write("w1", "a.ts", "first")),
        callTools(write("w1", "b.ts", "second")),
        replyWith("done"),
      ],
    });

    const first = await runLoop(h.graph, startInput(), "t");
    expect(first).toMatchObject({ kind: "paused", pending: { callId: "w1" } });

    const second = await runLoop(h.graph, decision({ approved: true }), "t");

    // the second move is a new call: it waits for its own approval and has not run
    expect(second).toMatchObject({ kind: "paused", pending: { callId: "w1" } });
    expect(JSON.stringify(second)).toContain("b.ts");
    expect(h.effects).toEqual(["write a.ts=first"]);

    const end = await runLoop(h.graph, decision({ approved: false, reason: "no" }), "t");

    expect(end).toEqual({ kind: "answered", reply: "done" });
    expect(h.effects).toEqual(["write a.ts=first"]);
  });
});

describe("#1295c: a call that is no input of its tool never reaches the tool", () => {
  it("invoke is not called; the model reads the paths and reasons", async () => {
    const invoked: unknown[] = [];
    const h = harness({
      moves: [
        callTools({ id: "r1", name: "read-file-tool", args: { path: 7 } }),
        replyWith("done"),
      ],
      tools: (log) =>
        repoTools(log).map((tool): AnyTool => {
          if (tool.name !== "read-file-tool") return tool;
          const spy = (args: unknown): Promise<ToolOutput<unknown>> => {
            invoked.push(args);
            return Promise.resolve({ kind: "ok", value: "ran" });
          };
          return Object.assign(
            Object.create(Object.getPrototypeOf(tool) as object) as AnyTool,
            tool,
            {
              invoke: spy,
            },
          );
        }),
    });

    const end = await runLoop(h.graph, startInput(), "t");

    expect(end).toEqual({ kind: "answered", reply: "done" });
    expect(invoked).toEqual([]);
    const content = toolMessagesOf(h.model.sent.at(-1))[0]?.[1];
    expect(content).toContain("invalid input");
    expect(content).toContain("path");
  });
});

describe("#1295c: a tool the agent does not have", () => {
  it("is prepared as an invalid call, never left unprepared", async () => {
    const node = makePrepareNode({
      agent: { name: "coder", tools: [] },
    } as never);
    const move = (await import("@langchain/core/messages")).AIMessage;
    const state = {
      ...(await stateOfEmpty()),
      move: new move({
        content: "",
        tool_calls: [{ id: "x1", name: "nope", args: { a: 1 }, type: "tool_call" }],
      }),
    };

    const update = await node(state as never, undefined);

    expect((update.prepared as Record<string, unknown>).x1).toMatchObject({
      kind: "invalid",
      tool: "nope",
    });
  });
});

async function stateOfEmpty(): Promise<Record<string, unknown>> {
  const h = harness({ moves: [replyWith("x")] });
  await runLoop(h.graph, startInput(), "e");
  return { ...(await stateOf(h.graph, "e")), prepared: {}, results: {}, decisions: {} };
}
