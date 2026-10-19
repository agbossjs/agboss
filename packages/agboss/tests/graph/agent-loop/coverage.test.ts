// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
import { describe, it, expect, vi } from "vitest";
import { NO_BUDGET_CHECK } from "../../../src/budgets/execution-budgets.js";
import { makeReplyNode } from "../../../src/graph/agent-loop/reply-node.js";
import { NO_ANSWER_TOOLS } from "../../../src/flow/runtime/answer-tools.js";
import { makeToolNode } from "../../../src/graph/agent-loop/tools-node.js";
import { makeModelNode } from "../../../src/graph/agent-loop/model-node.js";
import { makeJudgeNode } from "../../../src/graph/agent-loop/judge-node.js";
import { JudgeVerdict } from "../../../src/components/judge-decorators.js";
import { makeApprovalNode } from "../../../src/graph/agent-loop/approval-node.js";
import { servicesFor } from "../../../src/app/parts.js";
import { createAppDeps } from "../../../src/app/app-deps.js";
import { workflowOf } from "../../../src/components/assemble.js";
import { CodeReview } from "../../testing/fixtures/code-review.workflow.js";
import { inTestFrame } from "../../helpers/frame.js";

describe("agent-loop coverage", () => {
  it("reply-node with non-string move content", async () => {
    const node = makeReplyNode({
      agent: { name: "Agent1", answerTools: NO_ANSWER_TOOLS },
    });

    const result = await node(
      { move: { content: [{ type: "text", text: "hello" }], text: "hello" }, runId: "run1" },
      { configurable: { run_id: "run1" } },
    );
    expect(result.reply).toBe("hello");
  });

  it("reply-node with string move content", async () => {
    const node = makeReplyNode({
      agent: { name: "Agent1", answerTools: NO_ANSWER_TOOLS },
    });
    const result = await node({ move: { content: "hello", text: "hello" }, runId: "run1" }, {});
    expect(result.reply).toBe("hello");
  });

  it("reply-node with no move content", async () => {
    const node = makeReplyNode({
      agent: { name: "Agent1", answerTools: NO_ANSWER_TOOLS },
    });
    const result = await node({ move: { content: [], text: "hello" }, runId: "run1" }, {});
    expect(result.reply).toBe("hello");
  });

  it("tools-node tool undefined", async () => {
    const node = makeToolNode({ agent: { name: "a1", tools: [] } });
    const result = await node({ callId: "c1", tool: "unknown", messages: [] }, {});
    expect(result).toEqual({});
  });

  it("tools-node tool throws", async () => {
    const tool = {
      name: "t1",
      channel: "c1",
      timeoutMs: 1000,
      invoke: async () => {
        throw new Error("some error");
      },
    };
    const deps = { bundle: {}, agent: { name: "a1", tools: [tool] }, resolveTool: () => tool };
    const node = makeToolNode(deps);
    const result = await node({ callId: "c1", tool: "t1", arguments: "{}" }, {});
    expect(result.results.c1.content).toContain("some error");
  });

  it("tools-node tool throws non-Error object", async () => {
    const tool = {
      name: "t1",
      channel: "c1",
      timeoutMs: 1000,
      invoke: async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw "some string error";
      },
    };
    const deps = { bundle: {}, agent: { name: "a1", tools: [tool] }, resolveTool: () => tool };
    const node = makeToolNode(deps);
    const result = await node({ callId: "c1", tool: "t1", arguments: "{}" }, {});
    expect(result.results.c1.content).toContain("some string error");
  });

  it("model-node model without bindTools throws", async () => {
    const deps = {
      agent: {
        name: "a1",
        instructions: "mock",
        tools: [],
        limits: { modelCalls: 10 },
        answerTools: {
          tools: [
            {
              name: "answer-x-dto",
              definition: { type: "function", function: { name: "answer-x-dto", parameters: {} } },
            },
          ],
          isList: false,
          hasVariants: false,
        },
        binding: {
          model: { invoke: async () => ({}), bindTools: undefined },
          settings: { model: "m" },
        },
      },
      resolveTools: () => [{ name: "t1" }],
      budgets: NO_BUDGET_CHECK,
    };
    const node = makeModelNode(deps);
    await expect(
      node({ messages: [], usage: [], from: { usage: 0 }, modelCalls: 0, flowPath: [] }, {}),
    ).rejects.toThrow("cannot call tools");
  });

  it("judge-node calls observer", async () => {
    const handler = { judge: () => Promise.resolve(JudgeVerdict.passed()) };
    const judges = [{ name: "j1", handler, binding: { settings: { model: "m" } } }];
    const observer = { onJudgeStart: vi.fn(), onJudgeEnd: vi.fn() };
    const deps = { agent: { name: "a1", judges, binding: {} }, observer };
    const node = makeJudgeNode(deps);
    await inTestFrame(() => node({ reply: "test", answer: null, runId: "1", messages: [] }, {}));
    expect(observer.onJudgeStart).toHaveBeenCalled();
    expect(observer.onJudgeEnd).toHaveBeenCalled();
  });

  it("createAppDeps fallbacks", async () => {
    const bundle = await workflowOf(CodeReview);
    const built = await createAppDeps(bundle, {
      gateway: { chatModel: () => ({}), embeddings: () => ({}) } as any,
      connectMcp: async () => ({ close: async () => undefined }),
    });
    const deps = built;
    expect(deps.guardrails?.inputOf("a1")).toEqual([]);
    expect(deps.guardrails?.outputOf("a1")).toEqual([]);
    await deps.close();
  });

  it("servicesFor router fallback", () => {
    const bundle = { config: { defaults: { router: "test", models: {} } } };
    const services = servicesFor(bundle, {}, {}, {});
    const router = services.router("main");
    expect(router).toBeDefined();
  });
});

describe("agent-loop missing branches coverage", () => {
  it("reply-node with move null", async () => {
    const node = makeReplyNode({
      agent: { name: "Agent1", answerTools: NO_ANSWER_TOOLS },
    });
    const result = await node({ move: null, runId: "run1" }, {});
    expect(result.reply).toBe("");
    expect(result.messages).toEqual([]);
  });

  it("approval-node deps.approval undefined", async () => {
    const deps = { agent: { name: "a1", tools: [] } };
    const node = makeApprovalNode(deps);
    const result = await node(
      {
        decisions: {},
        results: {},
        pendingPause: { tool: "t1", callId: "c1" },
        runId: "1",
        move: null,
      },
      {},
    );
    expect(result).toEqual({});
  });

  it("approval-node tool undefined", async () => {
    const deps = { agent: { name: "a1", tools: [] }, approval: {} };
    const node = makeApprovalNode(deps);
    const result = await node(
      {
        decisions: {},
        results: {},
        pendingPause: { tool: "t1", callId: "c1" },
        runId: "1",
        move: null,
      },
      {},
    );
    expect(result).toEqual({});
  });
});

describe("app-deps branches coverage", () => {
  it("channelOf throws on unknown channel", async () => {
    const bundle = await workflowOf(CodeReview);
    const built = await createAppDeps(bundle, {
      gateway: { chatModel: () => ({}), embeddings: () => ({}) } as any,
      connectMcp: async () => ({ close: async () => undefined }),
    });
    const deps = built;
    expect(() => deps.channelOf("unknown-channel")).toThrow("Unknown channel");
    await deps.close();
  });

  it("approval-node tool without channel", async () => {
    const deps = {
      agent: { name: "a1", tools: [{ name: "t1" }] }, // No channel defined!
      approval: {},
      resolveTool: () => ({ name: "t1" }),
    };
    const node = makeApprovalNode(deps);
    const result = await node(
      {
        decisions: {},
        results: {},
        pendingPause: undefined,
        move: {
          tool_calls: [
            { name: "t1", id: "c1", type: "function", function: { name: "t1", arguments: "{}" } },
          ],
        },
        runId: "1",
      },
      {},
    );
    expect(result).toEqual({});
  });

  it("app-deps channelOf gives the channel of that name", async () => {
    // We need a channel to be returned by bundle.channels
    const mockChannel = { send: vi.fn().mockResolvedValue(undefined) };
    const bundle = await workflowOf(CodeReview);
    const originalChannels = bundle.channels;
    bundle.channels = () => new Map([["my-channel", mockChannel]]);

    const built = await createAppDeps(bundle, {
      gateway: { chatModel: () => ({}), embeddings: () => ({}) } as any,
      connectMcp: async () => ({ close: async () => undefined }),
    });

    expect(built.channelOf("my-channel")).toBe(mockChannel);

    bundle.channels = originalChannels;
    await built.close();
  });
});
