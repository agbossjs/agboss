/**
 * #1366: the agent's side of the model boundary — without policies the request is the instructions and the conversation
 * as they are, with no spend and a move passes as it is; a final answer is checked in its text and in the arguments of
 * its tool calls (a reply, or any answer-tool call among others), a move that calls only other tools is not checked;
 * a move with tokens nobody gave is sent back as a human message (no calls) or a tool message per call.
 */
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { unknownTokenMessage } from "../../../src/prompts/pii.js";
import { maskedRequest, outgoingMove } from "../../../src/graph/agent-loop/model-pii.js";

function policySet() {
  const checked: string[] = [];
  const set = {
    mask: (text: string) => {
      checked.push(text);
      return Promise.resolve({ masked: { text, blocked: [] }, usage: [] });
    },
    refusalError: () => Promise.resolve(undefined),
  };
  return { set, checked };
}

const stateOf = () => ({
  piiTokens: {},
  piiValues: [],
  piiKey: null,
  invalidAnswers: 0,
  usage: [],
  from: { usage: 0 },
  messages: [new HumanMessage({ content: "hello" })],
});
const depsOf = (pii: unknown) => ({
  pii,
  agent: {
    name: "alpha",
    instructions: "be brief",
    answerTools: { tools: [{ name: "answer" }] },
  },
});
const withPolicies = (set: unknown) => ({ withValues: () => ({ withFieldKey: () => set }) });
const request = { messages: [], tokens: {}, cache: {}, blocked: [], usage: [] };

describe("#1366: a request and a move without policies", () => {
  it("the request is the instructions then the conversation, with nothing masked and nothing spent", async () => {
    const made = await maskedRequest(stateOf() as never, depsOf(undefined) as never);

    expect(made.messages.map((message) => message.content)).toEqual(["be brief", "hello"]);
    expect(made.usage).toEqual([]);
    expect(made.tokens).toEqual({});
    expect(made.blocked).toEqual([]);
  });

  it("the move passes as it is, a move, with no spend", async () => {
    const move = new AIMessage({ content: "done" });

    const out = await outgoingMove(
      move,
      request,
      stateOf() as never,
      depsOf(undefined) as never,
      [],
    );

    expect(out).toEqual({ kind: "move", move, usage: [] });
  });
});

describe("#1366: what of a move is checked", () => {
  it("a reply is checked in its text", async () => {
    const { set, checked } = policySet();

    await outgoingMove(
      new AIMessage({ content: "plain reply" }),
      request,
      stateOf() as never,
      depsOf(withPolicies(set)) as never,
      [],
    );

    expect(checked).toEqual(["plain reply"]);
  });

  it("an answer-tool call is checked in its arguments, though other calls go with it", async () => {
    const { set, checked } = policySet();
    const move = new AIMessage({
      content: "",
      tool_calls: [
        { id: "1", name: "lookup", args: { q: "other arg" } },
        { id: "2", name: "answer", args: { text: "answer arg" } },
      ],
    });

    await outgoingMove(move, request, stateOf() as never, depsOf(withPolicies(set)) as never, []);

    expect(checked).toContain("answer arg");
    expect(checked).toContain("other arg");
  });

  it("a single answer-tool call is checked", async () => {
    const { set, checked } = policySet();
    const move = new AIMessage({
      content: "",
      tool_calls: [{ id: "2", name: "answer", args: { text: "answer arg" } }],
    });

    await outgoingMove(move, request, stateOf() as never, depsOf(withPolicies(set)) as never, []);

    expect(checked).toContain("answer arg");
  });

  it("a move that calls only other tools is not an answer: nothing is checked", async () => {
    const { set, checked } = policySet();
    const move = new AIMessage({
      content: "",
      tool_calls: [{ id: "1", name: "lookup", args: { q: "other arg" } }],
    });

    const out = await outgoingMove(
      move,
      request,
      stateOf() as never,
      depsOf(withPolicies(set)) as never,
      [],
    );

    expect(checked).toEqual([]);
    expect(out.kind).toBe("move");
  });

  it("a move object without the tool_calls list is checked in its text, and not thrown at", async () => {
    const { set, checked } = policySet();
    const move = { content: "bare reply" } as never;

    const out = await outgoingMove(
      move,
      request,
      stateOf() as never,
      depsOf(withPolicies(set)) as never,
      [],
    );

    expect(checked).toEqual(["bare reply"]);
    expect(out.kind).toBe("move");
  });
});

describe("#1366: a move with a token nobody gave", () => {
  const unknown = "<email:7f3a91>";

  it("without calls it is sent back as one human message after the move", async () => {
    const { set } = policySet();

    const out = await outgoingMove(
      new AIMessage({ content: `write to ${unknown}` }),
      request,
      stateOf() as never,
      depsOf(withPolicies(set)) as never,
      [],
    );

    if (out.kind !== "invalid") throw new Error("expected an invalid answer");
    const raw = out.update.messages;
    const messages = Array.isArray(raw) ? raw : [];
    expect(messages).toHaveLength(2);
    expect(messages[1]).toBeInstanceOf(HumanMessage);
    expect(messages[1]?.content).toBe(unknownTokenMessage([unknown])); // what the model reads back
  });

  it("with calls each call gets a tool message of its id", async () => {
    const { set } = policySet();
    const move = new AIMessage({
      content: "",
      tool_calls: [
        { id: "c1", name: "answer", args: { to: unknown } },
        { id: "c2", name: "lookup", args: { q: "x" } },
      ],
    });

    const out = await outgoingMove(
      move,
      request,
      stateOf() as never,
      depsOf(withPolicies(set)) as never,
      [],
    );

    if (out.kind !== "invalid") throw new Error("expected an invalid answer");
    const raw = out.update.messages;
    const messages = Array.isArray(raw) ? raw : [];
    expect(messages).toHaveLength(3);
    expect(
      messages.slice(1).map((message) => message instanceof ToolMessage && message.tool_call_id),
    ).toEqual(["c1", "c2"]);
  });
});
