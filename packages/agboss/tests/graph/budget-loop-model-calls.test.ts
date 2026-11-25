/**
 * #1366 (budget-loop shard) — the request of a model call and the ids of the tool calls it asks for, each rule on its
 * own over fakes: the tools as the model sees them (its own and the answer tools, by name, keys sorted), a model that
 * cannot call tools is refused only when the agent has some, and every tool call gets an id unique within the run —
 * the call's idempotency key, the same one when a recovered step replays the move (#335, #395).
 */
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeModelNode,
  toolDefinitionsOf,
  ToolCallingUnsupportedError,
} from "../../src/graph/agent-loop/model-node.js";
import { withCallIds } from "../../src/graph/agent-loop/call-ids.js";
import {
  loopPoliciesOf,
  maskedRequest,
  outgoingMove,
} from "../../src/graph/agent-loop/model-pii.js";
import { attemptOf } from "../../src/graph/agent-loop/answer-stream.js";
import { AgentFailedError } from "../../src/graph/errors.js";

vi.mock("../../src/graph/agent-loop/answer-stream.js", async (original) => ({
  ...(await original<typeof import("../../src/graph/agent-loop/answer-stream.js")>()),
  attemptOf: vi.fn(),
}));
vi.mock("../../src/flow/observers/execution-event.js", () => ({
  reportNodeEvent: vi.fn((work: (base: object) => unknown) => Promise.resolve(work({}))),
}));
vi.mock("../../src/flow/runtime/answer-tools.js", () => ({
  toolBindingOf: vi.fn(() => ({ bound: true })),
}));
vi.mock("../../src/tools/index.js", () => ({
  toolDefinitionOf: vi.fn((tool: { name: string; parameters: object }) => ({
    type: "function",
    function: { name: tool.name, parameters: tool.parameters },
  })),
}));
vi.mock("../../src/graph/agent-loop/model-pii.js", () => ({
  loopPoliciesOf: vi.fn(),
  maskedRequest: vi.fn(),
  outgoingMove: vi.fn(),
}));

const definition = (name: string) => ({ type: "function", function: { name, parameters: {} } });

describe("#1366: the tools as the model sees them", () => {
  it("are the agent's own and its answer tools, ordered by name whatever the order they were declared in", () => {
    const agent = {
      tools: [
        { name: "write", parameters: {} },
        { name: "append", parameters: {} },
        { name: "zip", parameters: {} },
      ],
      answerTools: {
        tools: [{ definition: definition("final") }, { definition: definition("a-answer") }],
      },
    };

    const names = toolDefinitionsOf(agent as never).map((tool) => tool.function.name);

    expect(names).toEqual(["a-answer", "append", "final", "write", "zip"]);
  });

  it("every own tool's JSON schema has its keys sorted: the same bytes in every execution", () => {
    const agent = {
      tools: [{ name: "write", parameters: { zeta: 1, alpha: { two: 2, one: 1 } } }],
      answerTools: { tools: [] },
    };

    const [tool] = toolDefinitionsOf(agent as never);

    expect(JSON.stringify(tool?.function.parameters)).toBe('{"alpha":{"one":1,"two":2},"zeta":1}');
  });

  it("two tools of one name keep the order they were declared in", () => {
    const agent = {
      tools: [
        { name: "same", parameters: { first: true } },
        { name: "same", parameters: { second: true } },
      ],
      answerTools: { tools: [] },
    };

    const found = toolDefinitionsOf(agent as never).map((tool) => tool.function.parameters);

    expect(found).toEqual([{ first: true }, { second: true }]);
  });

  it("an agent with no tools has none", () => {
    expect(toolDefinitionsOf({ tools: [], answerTools: { tools: [] } } as never)).toEqual([]);
  });
});

describe("#1366: the ids of the tool calls a move asks for", () => {
  const state = { runId: "run-1", flowPath: ["a", "b"], modelCalls: 2 };
  const call = (id: string | undefined, name = "write") => ({
    name,
    args: {},
    type: "tool_call" as const,
    ...(id === undefined ? {} : { id }),
  });
  const move = (calls: object[], invalid?: object[]) =>
    ({
      content: "text",
      tool_calls: calls,
      ...(invalid === undefined ? {} : { invalid_tool_calls: invalid }),
    }) as never;
  const idsOf = (message: AIMessage) => (message.tool_calls ?? []).map((found) => found.id);

  it("keeps the ids the provider gave, and the move's content", () => {
    const out = withCallIds(move([call("call_1"), call("call_2")]), state);

    expect(idsOf(out)).toEqual(["call_1", "call_2"]);
    expect(out.content).toBe("text");
  });

  it("a call with no id gets one unique within the run: run, depth of the visit, turn and position", () => {
    const out = withCallIds(move([call("call_1"), call(undefined), call("")]), state);

    expect(idsOf(out)).toEqual(["call_1", "run-1:2:3:1", "run-1:2:3:2"]);
  });

  it("an id the provider repeats within the move gets its position, each of the repeats; the others stay", () => {
    const out = withCallIds(move([call("dup"), call("one"), call("dup")]), state);

    expect(idsOf(out)).toEqual(["dup:0", "one", "dup:2"]);
  });

  it("a move with no tool calls has none", () => {
    const out = withCallIds({ content: "just text" } as never, state);

    expect(out.tool_calls).toEqual([]);
    expect(out.invalid_tool_calls).toEqual([]);
  });

  it("unparsable calls keep their place and each gets an id when it has none", () => {
    const invalid = (id: string | undefined) => ({
      name: "write",
      args: "{",
      error: "bad json",
      type: "invalid_tool_call" as const,
      ...(id === undefined ? {} : { id }),
    });

    const out = withCallIds(move([], [invalid("given"), invalid(undefined), invalid("")]), state);

    expect((out.invalid_tool_calls ?? []).map((found) => found.id)).toEqual([
      "given",
      "run-1:2:3:invalid:1",
      "run-1:2:3:invalid:2",
    ]);
    expect(out.invalid_tool_calls?.[0]).toMatchObject({ name: "write", error: "bad json" });
  });
});

describe("#1366: a model that cannot call tools", () => {
  const stateOf = () =>
    ({
      runId: "run-1",
      usage: [],
      from: { usage: 0 },
      flowPath: ["a"],
      modelCalls: 0,
      toolCalls: 0,
      piiTokens: {},
    }) as never;

  function setup(options: { tools: object[]; canBind: boolean }) {
    const invoke = vi.fn((_messages: unknown, _call: unknown) =>
      Promise.resolve(
        new AIMessage({ content: "answer", response_metadata: { usage: { cost: 0.25 } } }),
      ),
    );
    const bindTools = vi.fn((_tools: unknown, _binding: unknown) => ({ invoke }));
    const deps = {
      agent: {
        name: "alpha",
        tools: options.tools,
        answerTools: { tools: [] },
        limits: { modelCalls: 3, toolCalls: 2 },
        binding: {
          model: { invoke, ...(options.canBind ? { bindTools } : {}) },
          settings: { model: "m" },
        },
      },
      budgets: {
        exhausted: new AbortController().signal,
        check: vi.fn(),
        tally: vi.fn((r: unknown) => r),
      },
    };
    vi.mocked(maskedRequest).mockResolvedValue({
      messages: [new SystemMessage("rules"), new HumanMessage("hi")],
      tokens: {},
      cache: {},
      blocked: [],
      usage: [],
    });
    vi.mocked(loopPoliciesOf).mockReturnValue(undefined);
    vi.mocked(attemptOf).mockReturnValue(undefined);
    vi.mocked(outgoingMove).mockImplementation((moved) =>
      Promise.resolve({ kind: "move" as const, move: moved, usage: [] }),
    );
    return { node: makeModelNode(deps as never), invoke, bindTools };
  }

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("an agent with no tools calls the model as it is, though it cannot bind tools", async () => {
    const { node, invoke } = setup({ tools: [], canBind: false });

    const out = await node(stateOf(), undefined);

    expect(invoke).toHaveBeenCalledOnce();
    expect(out.modelCalls).toBe(1);
  });

  it("an agent with tools binds them, with their binding, and calls the bound model", async () => {
    const { node, invoke, bindTools } = setup({
      tools: [{ name: "write", parameters: {} }],
      canBind: true,
    });

    await node(stateOf(), undefined);

    expect(bindTools).toHaveBeenCalledWith([definition("write")], { bound: true });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("an agent with tools on a model that cannot bind them fails with the model's name in the cause", async () => {
    const { node } = setup({ tools: [{ name: "write", parameters: {} }], canBind: false });

    const failure = await node(stateOf(), undefined).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AgentFailedError);
    const cause = (failure as AgentFailedError).cause;
    expect(cause).toBeInstanceOf(ToolCallingUnsupportedError);
    expect(cause).toMatchObject({
      name: "ToolCallingUnsupportedError",
      message: 'The model of agent "alpha" cannot call tools',
    });
  });
});
