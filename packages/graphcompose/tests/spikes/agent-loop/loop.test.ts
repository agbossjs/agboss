import { ToolMessage } from "@langchain/core/messages";
import { expect, it } from "vitest";
import { harness } from "./fixtures.js";
import { runLoop, startInput, loopStateOf } from "./run.js";
import { answer, callTools } from "./scripted-model.js";

const thread = { thread: "t-loop" };

it("runs the model call and each tool call as separate nodes and stores results by call id", async () => {
  const h = harness({
    moves: [callTools({ id: "c1", name: "read-file", args: { path: "a.ts" } }), answer("done")],
  });

  const result = await runLoop(h.graph, startInput("read a.ts"), thread);

  expect(result).toEqual({ kind: "done", answer: "done" });
  expect(h.effects).toEqual(["read a.ts"]);
  const state = await loopStateOf(h.graph, "t-loop");
  expect(state.results).toEqual({
    c1: { callId: "c1", tool: "read-file", outcome: { kind: "ok", text: "contents of a.ts" } },
  });
});

it("returns invalid tool arguments to the model as a recoverable result", async () => {
  const h = harness({
    moves: [callTools({ id: "c1", name: "read-file", args: { file: "a.ts" } }), answer("sorry")],
  });

  const result = await runLoop(h.graph, startInput("read a.ts"), thread);

  expect(result.kind).toBe("done");
  const state = await loopStateOf(h.graph, "t-loop");
  expect(state.results.c1?.outcome.kind).toBe("error");
  expect(h.effects).toEqual([]);
});

it("answers a call to an unknown tool without running anything", async () => {
  const h = harness({
    moves: [callTools({ id: "c1", name: "delete-repo", args: {} }), answer("ok")],
  });

  const result = await runLoop(h.graph, startInput("go"), thread);

  expect(result.kind).toBe("done");
  const state = await loopStateOf(h.graph, "t-loop");
  const toolMessage = state.messages.find((m) => ToolMessage.isInstance(m));
  expect(toolMessage?.text).toContain("there is no tool delete-repo");
});
