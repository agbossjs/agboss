import { MemorySaver } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import {
  replyWith,
  callTools,
  decision,
  harness,
  read,
  runLoop,
  startInput,
  stateOf,
  toolMessagesOf,
  write,
} from "./fixtures.js";

const approve = decision({ approved: true });

describe("AC6: approval at the move boundary — one call per pause", () => {
  it("pauses before a write with the pending call; a fresh graph resumes it, the tool runs once, the turn is not asked again", async () => {
    const checkpointer = new MemorySaver();
    const moves = [callTools(write("w1", "a.ts")), replyWith("written")];
    const before = harness({ moves }, checkpointer);

    const paused = await runLoop(before.graph, startInput(), "t");
    const after = harness({ moves }, checkpointer);
    const done = await runLoop(after.graph, approve, "t");

    expect(paused).toEqual({
      kind: "paused",
      pending: {
        callId: "w1",
        tool: "write_file",
        arguments: { path: "a.ts", content: "x" },
        summary: 'call write_file with {"path":"a.ts","content":"x"}',
      },
    });
    expect(before.effects).toEqual([]);
    expect(after.effects).toEqual(["write a.ts=x"]);
    expect(before.modelCalls).toEqual([0]);
    expect(after.modelCalls).toEqual([1]);
    expect(done).toEqual({ kind: "answered", reply: "written" });
  });

  it("two calls needing approval in one turn: two pauses in call order, each write once", async () => {
    const h = harness({
      moves: [callTools(write("w1", "a.ts"), write("w2", "b.ts")), replyWith("both")],
    });

    const first = await runLoop(h.graph, startInput(), "t");
    const second = await runLoop(h.graph, approve, "t");
    const done = await runLoop(h.graph, approve, "t");

    expect(first).toMatchObject({ kind: "paused", pending: { callId: "w1" } });
    expect(second).toMatchObject({ kind: "paused", pending: { callId: "w2" } });
    expect(done).toEqual({ kind: "answered", reply: "both" });
    expect(h.effects).toEqual(["write a.ts=x", "write b.ts=x"]);
  });

  it("a rejected call does not run; the model reads who rejected it and why, and the loop goes on", async () => {
    const h = harness({ moves: [callTools(write("w1", "a.ts")), replyWith("not written")] });
    await runLoop(h.graph, startInput(), "t");

    const done = await runLoop(h.graph, decision({ approved: false, reason: "not now" }), "t");

    expect(done).toEqual({ kind: "answered", reply: "not written" });
    expect(h.effects).toEqual([]);
    expect(toolMessagesOf(h.model.sent[1])).toEqual([
      ["w1", "Tool error: the call was rejected by the thread's owner: not now"],
    ]);
    expect((await stateOf(h.graph, "t")).approvals).toEqual([
      {
        agent: "coder",
        tool: "write_file",
        args: { path: "a.ts", content: "x" },
        approved: false,
        by: "the thread's owner",
        result: "Tool error: the call was rejected by the thread's owner: not now",
      },
    ]);
  });

  it("after a reject the next pause asks about the next call; an approved one records the tool's result", async () => {
    const h = harness({
      moves: [callTools(write("w1", "a.ts"), write("w2", "b.ts")), replyWith("one of two")],
    });
    await runLoop(h.graph, startInput(), "t");
    await runLoop(h.graph, decision({ approved: false }), "t");

    const done = await runLoop(h.graph, approve, "t");

    expect(done).toEqual({ kind: "answered", reply: "one of two" });
    expect(h.effects).toEqual(["write b.ts=x"]);
    expect(toolMessagesOf(h.model.sent[1])).toEqual([
      ["w1", "Tool error: the call was rejected by the thread's owner"],
      ["w2", "wrote b.ts"],
    ]);
    expect((await stateOf(h.graph, "t")).approvals.map((record) => record.result)).toEqual([
      "Tool error: the call was rejected by the thread's owner",
      "wrote b.ts",
    ]);
  });

  it("a read in the same turn runs once, after the decision; without a pause seam nothing waits", async () => {
    const seam = harness({
      moves: [callTools(read("r1", "a.ts"), write("w1", "a.ts")), replyWith("ok")],
    });
    const open = harness({
      moves: [callTools(read("r1", "a.ts"), write("w1", "a.ts")), replyWith("ok")],
      approval: false,
    });

    await runLoop(seam.graph, startInput(), "t");
    await runLoop(seam.graph, approve, "t");
    const unpaused = await runLoop(open.graph, startInput(), "t");

    expect([...seam.effects].sort()).toEqual(["read a.ts", "write a.ts=x"]);
    expect(unpaused).toEqual({ kind: "answered", reply: "ok" });
    expect([...open.effects].sort()).toEqual(["read a.ts", "write a.ts=x"]);
  });
});
