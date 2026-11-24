/**
 * #1366: the loop's routing after a move and its boundary node — a call that has a result is neither awaited
 * nor run again; a question's answer or its invalid ask reaches the tool task; a call that waits for an answer
 * pauses at the approval node; a boundary with no move adds no message; a move without unreadable calls adds
 * no unreadable-call keys, and one with them counts them.
 */
import { AIMessage } from "@langchain/core/messages";
import { Send } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import {
  awaitingApproval,
  makeBoundaryNode,
  routeToActions,
} from "../../../src/graph/agent-loop/boundary.js";

const call = (id: string, name: string) => ({
  id,
  name,
  args: { q: 1 },
  type: "tool_call" as const,
});
const move = (...calls: ReturnType<typeof call>[]) =>
  new AIMessage({ content: "", tool_calls: calls });

const baseState = {
  move: null as AIMessage | null,
  results: {} as Record<string, unknown>,
  decisions: {} as Record<string, unknown>,
  questionAnswers: {} as Record<string, unknown>,
  usage: [],
  from: { usage: 0 },
  flowPath: ["flow"],
  runId: "r",
  piiKey: undefined,
  piiValues: {},
  fileTally: { count: 0, bytes: 0 },
  fileTranscripts: {},
  modelCalls: 2,
  invalidAnswers: 1,
  invalidArguments: 0,
};

const approvalTool = { name: "pay", channel: { name: "ops" } };
const questionTool = { name: "ask", channel: { name: "ops" }, question: {} };
const plainTool = { name: "read" };
const deps = (...tools: object[]) =>
  ({
    agent: { name: "alpha", tools, limits: { modelCalls: 10 } },
    approval: {},
    budgets: {},
  }) as never;

describe("#1366: which calls wait and which run", () => {
  it("a call that waits for a decision: the approval node; with a stored result it waits for nothing and is not run", () => {
    const waiting = { ...baseState, move: move(call("c1", "pay")) };
    expect(routeToActions(deps(approvalTool))(waiting as never)).toBe("approval");

    const done = { ...waiting, results: { c1: { callId: "c1" } } };
    expect(awaitingApproval(done as never, deps(approvalTool))).toStrictEqual([]);
    expect(routeToActions(deps(approvalTool))(done as never)).toBe("collect");
  });

  it("a question call waits for its answer, and no longer once answered", () => {
    const asked = { ...baseState, move: move(call("c1", "ask")) };
    expect(routeToActions(deps(questionTool))(asked as never)).toBe("approval");
    const answered = { ...asked, questionAnswers: { c1: { answer: "yes" } } };
    expect(awaitingApproval(answered as never, deps(questionTool))).toStrictEqual([]);
  });

  it("a call with a stored result runs no second time; an unresolved one does", () => {
    const state = {
      ...baseState,
      move: move(call("c1", "read"), call("c2", "read")),
      results: { c1: { callId: "c1" } },
    };
    const routed = routeToActions(deps(plainTool))(state as never) as Send[];
    expect(routed.map((send) => (send.args as { callId: string }).callId)).toStrictEqual(["c2"]);
  });

  it("a refused call does not run, an approved one runs with the overriding arguments", () => {
    const state = {
      ...baseState,
      move: move(call("c1", "pay"), call("c2", "pay")),
      decisions: { c1: { approved: false }, c2: { approved: true, overrideArguments: { q: 9 } } },
    };
    const routed = routeToActions(deps(approvalTool))(state as never) as Send[];
    expect(routed).toHaveLength(1);
    expect(routed[0]?.args).toMatchObject({ callId: "c2", args: { q: 9 } });
  });

  it("an answered question's answer reaches its task, an invalid ask reaches it as invalidAsk and carries no answer", () => {
    const answered = {
      ...baseState,
      move: move(call("c1", "ask")),
      questionAnswers: { c1: { answer: "yes" } },
    };
    const [good] = routeToActions(deps(questionTool))(answered as never) as Send[];
    expect(good?.args.answer).toBe("yes");
    expect("invalidAsk" in (good?.args ?? {})).toBe(false);

    const invalid = { ...answered, questionAnswers: { c1: { answer: "x", problem: "no good" } } };
    const [bad] = routeToActions(deps(questionTool))(invalid as never) as Send[];
    expect(bad?.args.invalidAsk).toBe("no good");
    expect("answer" in (bad?.args ?? {})).toBe(false);
  });
});

describe("#1366: the boundary node", () => {
  it("no move: no message, no unreadable-call keys", async () => {
    const node = makeBoundaryNode(deps(plainTool));
    const update = await node({ ...baseState, move: null } as never, {});
    expect(update).toStrictEqual({ messages: [], results: {}, callRecords: {} });
  });

  it("a move: the move is the message; an unknown tool is answered at once and recorded", async () => {
    const node = makeBoundaryNode(deps(plainTool));
    const m = move(call("c1", "ghost"), call("c2", "read"));
    const update = await node({ ...baseState, move: m } as never, {});
    expect(update.messages).toStrictEqual([m]);
    expect(Object.keys(update.results ?? {})).toStrictEqual(["c1"]);
    expect(Object.keys(update.callRecords ?? {})).toStrictEqual(["c1"]);
    expect("invalidArguments" in update).toBe(false);
  });

  it("calls with unreadable arguments are recorded and counted", async () => {
    const node = makeBoundaryNode(deps(plainTool));
    const m = new AIMessage({
      content: "",
      invalid_tool_calls: [
        { id: "u1", name: "ghost", args: "{oops", error: "bad", type: "invalid_tool_call" },
        { id: "u2", name: "ghost", args: "{oops", error: "bad", type: "invalid_tool_call" },
      ],
    });
    const update = await node({ ...baseState, move: m } as never, {});
    expect(update.invalidArguments).toBe(2);
    expect(Object.keys(update.callRecords ?? {})).toStrictEqual(["u1", "u2"]);
  });
});
