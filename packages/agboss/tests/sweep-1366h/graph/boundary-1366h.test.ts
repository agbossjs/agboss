import { argsDigestOf } from "../../../src/graph/agent-loop/move-entries.js";
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
  unpreparedCalls,
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
  prepared: {} as Record<string, unknown>,
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

/** What a prepared call records of the call it was prepared for: its tool and the digest of the model's arguments. */
const forCall = (tool: string) => ({ tool, argsDigest: argsDigestOf({ q: 1 }) });

/** The calls of `tool` prepared as ready (#1295c), by id, with the arguments `call` gives. */
const ready = (tool: string, ...ids: string[]) =>
  Object.fromEntries(
    ids.map((id) => [
      id,
      { kind: "ready", args: { q: 1 }, shown: { q: 1 }, from: "model", ...forCall(tool) },
    ]),
  );

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
    const waiting = { ...baseState, move: move(call("c1", "pay")), prepared: ready("pay", "c1") };
    expect(routeToActions(deps(approvalTool))(waiting as never)).toBe("approval");

    const done = { ...waiting, results: { c1: { callId: "c1" } } };
    expect(awaitingApproval(done as never, deps(approvalTool))).toStrictEqual([]);
    expect(routeToActions(deps(approvalTool))(done as never)).toBe("collect");
  });

  it("a question call waits for its answer, and no longer once answered", () => {
    const asked = { ...baseState, move: move(call("c1", "ask")), prepared: ready("ask", "c1") };
    expect(routeToActions(deps(questionTool))(asked as never)).toBe("approval");
    const answered = { ...asked, questionAnswers: { c1: { answer: "yes" } } };
    expect(awaitingApproval(answered as never, deps(questionTool))).toStrictEqual([]);
  });

  it("a call with a stored result runs no second time; an unresolved one does", () => {
    const state = {
      ...baseState,
      move: move(call("c1", "read"), call("c2", "read")),
      results: { c1: { callId: "c1" } },
      prepared: ready("read", "c2"),
    };
    const routed = routeToActions(deps(plainTool))(state as never) as Send[];
    expect(routed.map((send) => (send.args as { callId: string }).callId)).toStrictEqual(["c2"]);
  });

  it("a refused call does not run, an approved one runs with the overriding arguments", () => {
    const state = {
      ...baseState,
      move: move(call("c1", "pay"), call("c2", "pay")),
      decisions: { c1: { approved: false }, c2: { approved: true, overrideArguments: { q: 9 } } },
      prepared: {
        ...ready("pay", "c1"),
        c2: { kind: "ready", args: { q: 9 }, shown: { q: 9 }, from: "approver", ...forCall("pay") },
      },
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
      prepared: ready("ask", "c1"),
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

describe("#1295c: a call is prepared before it is asked about or run", () => {
  it("a call nobody prepared goes to the prepare node first, whatever its tool needs", () => {
    const state = { ...baseState, move: move(call("c1", "pay"), call("c2", "read")) };

    expect(routeToActions(deps(approvalTool, plainTool))(state as never)).toBe("prepare");
    expect(unpreparedCalls(state as never).map((c) => c.callId)).toStrictEqual(["c1", "c2"]);
  });

  it("a call with a stored result is never prepared", () => {
    const state = {
      ...baseState,
      move: move(call("c1", "ghost")),
      results: { c1: { callId: "c1" } },
    };

    expect(unpreparedCalls(state as never)).toStrictEqual([]);
  });

  it("an approver's override is arguments nobody checked: the call goes through the prepare node again, once", () => {
    const decided = {
      ...baseState,
      move: move(call("c1", "pay")),
      decisions: { c1: { approved: true, overrideArguments: { q: 9 } } },
      prepared: ready("pay", "c1"),
    };
    expect(routeToActions(deps(approvalTool))(decided as never)).toBe("prepare");

    const again = {
      ...decided,
      prepared: {
        c1: { kind: "ready", args: { q: 9 }, shown: {}, from: "approver", ...forCall("pay") },
      },
    };
    expect(unpreparedCalls(again as never)).toStrictEqual([]);
    expect(routeToActions(deps(approvalTool))(again as never)).toBeInstanceOf(Array);
  });

  it.each([
    ["invalid", { kind: "invalid" }],
    ["refused", { kind: "refused", content: "no", refusal: {} }],
    ["replied", { kind: "replied", message: "m" }],
    ["stopped", { kind: "stopped", stop: { kind: "blocked", interceptor: "i", reason: "r" } }],
  ])(
    "a call prepared as %s never waits for an approval; its task ends it without running",
    (_n, end) => {
      const state = {
        ...baseState,
        move: move(call("c1", "pay")),
        prepared: { c1: { args: { q: 1 }, from: "model", ...forCall("pay"), ...end } },
      };

      expect(awaitingApproval(state as never, deps(approvalTool))).toStrictEqual([]);
      const [send] = routeToActions(deps(approvalTool))(state as never) as Send[];
      expect(send?.args).toMatchObject({ callId: "c1", prepared: { kind: end.kind } });
    },
  );

  it("a call with no preparing is routed to the prepare node, never to run: nothing runs unchecked", () => {
    const state = {
      ...baseState,
      move: move(call("c1", "read")),
      prepared: ready("read", "c1"),
    };
    const routed = routeToActions(deps(plainTool))({ ...state, prepared: {} } as never);
    expect(routed).toBe("prepare");
  });
});

describe("#1366: the boundary node", () => {
  it("no move: no message, no unreadable-call keys", async () => {
    const node = makeBoundaryNode(deps(plainTool));
    const update = await node({ ...baseState, move: null } as never, {});
    expect(update).toStrictEqual({
      messages: [],
      results: {},
      callRecords: {},
      decisions: {},
      prepared: {},
      questionAnswers: {},
    });
  });

  it("a move: the move is the message; an unknown tool is answered at once and recorded", async () => {
    const node = makeBoundaryNode(deps(plainTool));
    const m = move(call("c1", "ghost"), call("c2", "read"));
    const update = await node({ ...baseState, move: m } as never, {});
    expect(update.messages).toStrictEqual([m]);
    // a key set to undefined is the move channels' way to drop an entry of an earlier move (#1295c)
    const kept = (record: object | undefined) =>
      Object.entries(record ?? {})
        .filter(([, value]) => value !== undefined)
        .map(([key]) => key);
    expect(kept(update.results)).toStrictEqual(["c1"]);
    expect(kept(update.callRecords)).toStrictEqual(["c1"]);
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
