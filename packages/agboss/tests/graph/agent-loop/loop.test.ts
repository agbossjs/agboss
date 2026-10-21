import { describe, expect, it } from "vitest";
import {
  JudgeOwner,
  JudgePoint,
  type JudgePoints,
  type JudgeVisit,
} from "../../../src/graph/agent-loop/index.js";
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
import { ExecutionStatus } from "../../../src/app/types.js";

describe("AC1: a model turn runs its tool calls, stores each result by callId, the model sees them in call order", () => {
  it("runs the calls, stores every result under its callId and answers with the next turn", async () => {
    const h = harness({
      moves: [callTools(read("c1", "a.ts"), read("c2", "b.ts")), replyWith("done")],
    });

    const end = await runLoop(h.graph, startInput(), "t");

    expect(end).toEqual({ kind: "answered", reply: "done" });
    expect([...h.effects].sort()).toEqual(["read a.ts", "read b.ts"]);
    expect((await stateOf(h.graph, "t")).results).toEqual({
      c1: { callId: "c1", tool: "read_file", content: "contents of a.ts" },
      c2: { callId: "c2", tool: "read_file", content: "contents of b.ts" },
    });
    expect(toolMessagesOf(h.model.sent[1])).toEqual([
      ["c1", "contents of a.ts"],
      ["c2", "contents of b.ts"],
    ]);
  });

  it("a reply without calls leaves the loop as the agent's text answer, its model call accounted", async () => {
    const h = harness({ moves: [replyWith("  nothing to change  ")] });

    await runLoop(h.graph, startInput(), "t");

    const state = await stateOf(h.graph, "t");
    expect(state.reply).toBe("nothing to change");
    expect(state.usage).toHaveLength(1);
    expect(state.usage[0]).toMatchObject({ caller: "coder", inputTokens: 100, outputTokens: 20 });
    expect(h.modelCalls).toEqual([0]);
  });

  it("assigns a callId when the model gives none — unique within the run", async () => {
    const h = harness({
      moves: [
        callTools({ name: "read_file", args: { path: "a.ts" } }),
        callTools({ name: "read_file", args: { path: "b.ts" } }),
        replyWith("ok"),
      ],
    });

    await runLoop(h.graph, startInput(), "t");

    const ids = Object.keys((await stateOf(h.graph, "t")).results);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => id.startsWith("run-1:"))).toBe(true);
  });
});

describe("AC2: tool errors are recoverable — the model reads them and the loop continues", () => {
  it("a tool exception reaches the model as `Tool error: …`", async () => {
    const h = harness({
      moves: [callTools({ id: "b1", name: "boom", args: {} }), replyWith("sorry")],
    });

    const end = await runLoop(h.graph, startInput(), "t");

    expect(end).toEqual({ kind: "answered", reply: "sorry" });
    expect(toolMessagesOf(h.model.sent[1])).toEqual([["b1", "Tool error: disk on fire"]]);
  });

  it("invalid arguments and an unknown tool come back as tool errors; nothing runs", async () => {
    const h = harness({
      moves: [
        callTools(
          { id: "c1", name: "read_file", args: { file: "a.ts" } },
          { id: "c2", name: "delete_repo", args: {} },
        ),
        replyWith("ok"),
      ],
    });

    await runLoop(h.graph, startInput(), "t");

    const [invalid, unknown] = toolMessagesOf(h.model.sent[1]);
    expect(invalid?.[1]).toMatch(/^Tool error: invalid input/);
    expect(unknown).toEqual(["c2", 'Tool error: there is no tool "delete_repo"']);
    expect(h.effects).toEqual([]);
  });
});

describe("AC8: the judge points", () => {
  it("are the loop's four moments and the two owners", () => {
    expect(Object.values(JudgePoint)).toHaveLength(4);
    expect(Object.values(JudgeOwner)).toEqual(["tool", "agent"]);
  });
});
