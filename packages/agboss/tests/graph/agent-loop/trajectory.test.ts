/**
 * #395 PR 1 — the agent loop's trajectory: each call's record (its status, input, output, error),
 * in call order, and the `invalid_tool_calls` fix — a call whose arguments are no JSON is an
 * `InvalidArguments` call the model reads about, counted in `validationAttempts`, never a silent
 * empty reply.
 */
import { HumanMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolCallStatus } from "../../../src/flow/runtime/tool-calls.js";
import { ComponentKind } from "../../../src/flow/runtime/records.js";
import { endedCallRecordOf } from "../../../src/graph/agent-loop/call-records.js";
import { ToolCallStopKind } from "../../../src/graph/agent-loop/tool-stops.js";
import { defineTool, type AnyTool } from "../../../src/tools/index.js";
import { seconds } from "../../../src/units/index.js";
import {
  callTools,
  callTruncated,
  decision,
  harness,
  read,
  repoTools,
  replyWith,
  runLoop,
  startInput,
  stateOf,
  write,
} from "./fixtures.js";

const TRUNCATED = {
  id: "u1",
  name: "read-file-tool",
  args: '{"path": "a.',
  error: "Unexpected end of JSON input",
};

/** The repository's tools and one that never ends within its 20 ms timeout. */
const withSlowTool = (log: (effect: string) => void): AnyTool[] => [
  ...repoTools(log),
  defineTool({
    name: "slow",
    description: "Never answers in time",
    timeout: seconds(0.02),
    input: z.object({}),
    output: z.string(),
    run: (_input, ctx) =>
      new Promise((_resolve, reject) => {
        ctx.signal.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      }),
  }),
];

describe("a call whose arguments are no JSON (invalid_tool_calls)", () => {
  it("is never an empty reply: the model reads why and tries again", async () => {
    const h = harness({ moves: [callTruncated(TRUNCATED), replyWith("done")] });

    const end = await runLoop(h.graph, startInput(), "t");

    expect(end).toEqual({ kind: "answered", reply: "done" });
    const sent = h.model.sent[1] ?? [];
    const told = sent.filter((message) => HumanMessage.isInstance(message)).at(-1);
    expect(told?.text).toContain("read-file-tool: Unexpected end of JSON input");
    expect(h.effects).toEqual([]);
  });

  it("is an InvalidArguments record, counted as a failed validation of the step", async () => {
    const h = harness({ moves: [callTruncated(TRUNCATED), replyWith("done")] });

    await runLoop(h.graph, startInput(), "t");

    const state = await stateOf(h.graph, "t");
    expect(state.invalidArguments).toBe(1);
    expect(state.trajectory).toEqual([
      expect.objectContaining({
        status: ToolCallStatus.InvalidArguments,
        input: '{"path": "a.',
        output: undefined,
        error: expect.objectContaining({ message: "Unexpected end of JSON input" }),
        step: expect.objectContaining({
          callId: "u1",
          component: expect.objectContaining({ name: "read-file-tool" }),
          validationAttempts: 0,
        }),
      }),
    ]);
  });

  it("beside a read call: the read one runs, the record keeps both in the move's order", async () => {
    const h = harness({
      moves: [callTruncated(TRUNCATED, read("c1", "b.ts")), replyWith("done")],
    });

    await runLoop(h.graph, startInput(), "t");

    expect(h.effects).toEqual(["read b.ts"]);
    const { trajectory } = await stateOf(h.graph, "t");
    expect(trajectory.map((call) => [call.step.callId, call.status])).toEqual([
      ["c1", ToolCallStatus.Succeeded],
      ["u1", ToolCallStatus.InvalidArguments],
    ]);
  });
});

describe("the visit's trajectory", () => {
  it("records each call's status: succeeded, failed, invalid arguments, timed out", async () => {
    const h = harness({
      tools: withSlowTool,
      moves: [
        callTools(read("c1", "a.ts"), { id: "c2", name: "boom", args: {} }),
        callTools({ id: "c3", name: "read-file-tool", args: { path: 5 } }),
        callTools({ id: "c4", name: "slow", args: {} }),
        replyWith("done"),
      ],
    });

    await runLoop(h.graph, startInput(), "t");

    const state = await stateOf(h.graph, "t");
    expect(state.trajectory.map((call) => [call.step.callId, call.status])).toEqual([
      ["c1", ToolCallStatus.Succeeded],
      ["c2", ToolCallStatus.Failed],
      ["c3", ToolCallStatus.InvalidArguments],
      ["c4", ToolCallStatus.TimedOut],
    ]);
    const [succeeded, failed, invalid, timedOut] = state.trajectory;
    expect(succeeded).toMatchObject({ input: { path: "a.ts" }, output: "contents of a.ts" });
    expect(failed?.error).toMatchObject({ message: "disk on fire" });
    expect(invalid).toMatchObject({ input: { path: 5 }, output: undefined });
    expect(timedOut?.error).toMatchObject({ code: "tool.timeout" });
    expect(state.trajectory.map((call) => call.step.toolLoopIteration)).toEqual([1, 1, 2, 3]);
    expect(state.trajectory.map((call) => call.step.validationAttempts)).toEqual([0, 0, 0, 1]);
  });

  it("a call to a tool the agent does not have is UnknownTool (#395 S6)", async () => {
    const h = harness({
      moves: [callTools({ id: "x1", name: "nope", args: { a: 1 } }), replyWith("ok")],
    });

    await runLoop(h.graph, startInput(), "t");

    const { trajectory } = await stateOf(h.graph, "t");
    expect(trajectory).toEqual([
      expect.objectContaining({
        status: ToolCallStatus.UnknownTool,
        input: { a: 1 },
        step: expect.objectContaining({
          callId: "x1",
          component: expect.objectContaining({ name: "nope" }),
        }),
        error: expect.objectContaining({ message: 'Tool error: there is no tool "nope"' }),
      }),
    ]);
  });

  it("a call its approval declined is Declined: it never ran", async () => {
    const h = harness({ moves: [callTools(write("w1", "a.ts")), replyWith("ok")] });

    await runLoop(h.graph, startInput(), "t");
    await runLoop(h.graph, decision({ approved: false, reason: "not now" }), "t");

    const { trajectory } = await stateOf(h.graph, "t");
    expect(trajectory).toEqual([
      expect.objectContaining({
        status: ToolCallStatus.Declined,
        input: { path: "a.ts", content: "x" },
        output: undefined,
        step: expect.objectContaining({ callId: "w1" }),
      }),
    ]);
    expect(h.effects).toEqual([]);
  });
});

describe("a call its interceptors stopped (#384)", () => {
  const [tool] = repoTools(() => undefined);
  const step = {
    component: {
      name: "read-file-tool",
      kind: ComponentKind.Tool,
      promptHash: undefined,
      schemaHash: undefined,
    },
    nodeId: "coder",
    visitNumber: 1,
    copyNumber: 1,
    itemIndex: undefined,
    idempotencyKey: "k",
    callId: "c1",
    toolLoopIteration: 1,
    validationAttempts: 0,
  } as const;
  const times = { startedAt: new Date(0), endedAt: new Date(0) };
  const call = { step, args: { path: "a.ts" }, isResultTruncated: false };

  it("blocked: Blocked, its error a ToolBlockedError record", () => {
    if (tool === undefined) throw new Error("no tool");
    const stop = {
      kind: ToolCallStopKind.Blocked,
      interceptor: "deny-tool-interceptor",
      reason: "no",
    };

    const record = endedCallRecordOf({ ...call, tool, stop }, times);

    expect(record).toMatchObject({
      status: ToolCallStatus.Blocked,
      input: { path: "a.ts" },
      output: undefined,
      error: { code: "step.tool-blocked" },
    });
  });

  it("an interceptor that failed: Failed, its reason the error", () => {
    if (tool === undefined) throw new Error("no tool");
    const stop = {
      kind: ToolCallStopKind.Failed,
      interceptor: "broken-tool-interceptor",
      reason: "boom",
    };

    const record = endedCallRecordOf({ ...call, tool, stop }, times);

    expect(record).toMatchObject({ status: ToolCallStatus.Failed, error: { message: "boom" } });
  });
});
