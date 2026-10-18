// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
import { describe, it, expect, vi } from "vitest";
import { NO_BUDGET_CHECK } from "../../../src/budgets/execution-budgets.js";
import { makeReplyNode } from "../../../src/graph/agent-loop/reply-node.js";
import { NO_ANSWER_TOOLS } from "../../../src/flow/runtime/answer-tools.js";
import {
  mergePolicies,
  visitToolThenAgent,
  visitAgentAnswer,
} from "../../../src/graph/agent-loop/judge-points.js";
import { makeToolNode } from "../../../src/graph/agent-loop/tools-node.js";
import { makeModelNode } from "../../../src/graph/agent-loop/model-node.js";
import { makeJudgeNode } from "../../../src/graph/agent-loop/judge-node.js";
import { makeApprovalNode } from "../../../src/graph/agent-loop/approval-node.js";
import { servicesFor } from "../../../src/app/parts.js";
import { createAppDeps } from "../../../src/app/app-deps.js";
import { workflowOf } from "../../../src/components/assemble.js";
import { CodeReview } from "../../testing/fixtures/code-review.workflow.js";

describe("agent-loop coverage", () => {
  it("reply-node with non-string move content", async () => {
    const node = makeReplyNode({
      agent: { name: "Agent1", answerTools: NO_ANSWER_TOOLS },
      workflowGuardrails: [],
      guardrails: () => [],
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
      workflowGuardrails: [],
      guardrails: () => [],
    });
    const result = await node({ move: { content: "hello", text: "hello" }, runId: "run1" }, {});
    expect(result.reply).toBe("hello");
  });

  it("reply-node with no move content", async () => {
    const node = makeReplyNode({
      agent: { name: "Agent1", answerTools: NO_ANSWER_TOOLS },
      workflowGuardrails: [],
      guardrails: () => [],
    });
    const result = await node({ move: { content: [], text: "hello" }, runId: "run1" }, {});
    expect(result.reply).toBe("hello");
  });

  it("mergePolicies tPolicies override and disable", () => {
    class Guard1 {
      public x = 1;
    }
    class Guard2 {
      public x = 2;
    }

    const policies1 = mergePolicies([], undefined, {
      override: true,
      instances: [new Guard1()],
      disable: [],
    });
    expect(policies1.length).toBe(1);

    const policies2 = mergePolicies([new Guard1(), new Guard2()], undefined, {
      override: false,
      instances: [],
      disable: [Guard1],
    });
    expect(policies2.length).toBe(1);
  });

  it("visitToolThenAgent override arguments", async () => {
    const observer = { onGuardrailStart: vi.fn(), onGuardrailEnd: vi.fn() };
    const guardrail = {
      beforeToolCall: async () => ({ overrideArguments: { a: 1 } }),
    };
    const ctx = { call: { args: null } };
    await visitToolThenAgent([guardrail], "beforeToolCall", ctx, undefined, observer, {
      runId: "r1",
    });
    expect(ctx.call.args).toEqual({ a: 1 });
    expect(observer.onGuardrailStart).toHaveBeenCalled();
    expect(observer.onGuardrailEnd).toHaveBeenCalled();
  });

  it("visitAgentAnswer calls observer", async () => {
    const observer = { onGuardrailStart: vi.fn(), onGuardrailEnd: vi.fn() };
    const guardrail = { beforeAgentAnswer: async () => ({}) };
    await visitAgentAnswer([guardrail], {}, observer, { runId: "r1" });
    expect(observer.onGuardrailStart).toHaveBeenCalled();
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
      node(
        { messages: [], usage: [], from: { usage: 0 }, modelCalls: 0, flowPath: [] },
        {},
      ),
    ).rejects.toThrow("cannot call tools");
  });

  it("judge-node calls observer", async () => {
    const handler = { judge: () => Promise.resolve({ passed: true }) };
    const judges = [{ name: "j1", handler, binding: { settings: { model: "m" } } }];
    const observer = { onJudgeStart: vi.fn(), onJudgeEnd: vi.fn() };
    const deps = { agent: { name: "a1", judges, binding: {} }, observer };
    const node = makeJudgeNode(deps);
    await node({ reply: "test", runId: "1", messages: [] }, {});
    expect(observer.onJudgeStart).toHaveBeenCalled();
    expect(observer.onJudgeEnd).toHaveBeenCalled();
  });

  it("approval-node calls pii policy observer and maskers", async () => {
    const observer = { onPiiPolicyStart: vi.fn(), onPiiPolicyEnd: vi.fn() };
    const policy = { mask: async (v) => String(v), maskJson: async (v) => String(v) };
    const deps = {
      agent: { name: "a1", tools: [{ name: "t1", channel: "c1" }] },
      approval: {
        requestApproval: async () => ({ approved: true, feedback: "fb", overrideArguments: {} }),
      },
      workflowPiiPolicies: [policy],
      piiPolicies: { override: false, disable: [], instances: [] },
      toolPiiPolicies: () => ({ override: false, disable: [], instances: [] }),
      resolveTool: () => ({ name: "t1", channel: "c1" }),
      observer,
    };
    const node = makeApprovalNode(deps);
    await node(
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
    expect(observer.onPiiPolicyStart).toHaveBeenCalled();
  });

  it("createAppDeps fallbacks", async () => {
    const bundle = await workflowOf(CodeReview);
    const built = await createAppDeps(bundle, {
      gateway: { chatModel: () => ({}), embeddings: () => ({}) } as any,
      connectMcp: async () => ({ close: async () => undefined }),
    });
    const deps = built;
    expect(deps.toolPiiPolicies("t1")).toEqual({ override: false, instances: [], disable: [] });
    expect(deps.toolGuardrails("t1")).toEqual({ override: false, instances: [], disable: [] });
    expect(deps.piiPolicies("a1")).toEqual({ override: false, instances: [], disable: [] });
    expect(deps.guardrails("a1")).toEqual({ override: false, instances: [], disable: [] });
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
      workflowGuardrails: [],
      guardrails: () => [],
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

  it("approval-node unknown policy constructor", async () => {
    const observer = { onPiiPolicyStart: vi.fn(), onPiiPolicyEnd: vi.fn() };
    class UnknownPolicy {
      async mask(v) {
        return String(v);
      }
      async maskJson(v) {
        return String(v);
      }
    }
    Object.defineProperty(UnknownPolicy, "name", { value: "" });
    const policy = new UnknownPolicy();

    const deps = {
      agent: { name: "a1", tools: [{ name: "t1", channel: "c1" }] },
      approval: {
        requestApproval: async () => ({ approved: true, feedback: "fb", overrideArguments: {} }),
      },
      workflowPiiPolicies: [policy],
      piiPolicies: { override: false, disable: [], instances: [] },
      toolPiiPolicies: () => ({ override: false, disable: [], instances: [] }),
      resolveTool: () => ({ name: "t1", channel: "c1" }),
      observer,
    };
    const node = makeApprovalNode(deps);
    await node(
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
    expect(observer.onPiiPolicyStart).toHaveBeenCalled();
  });
});

describe("app-deps branches coverage", () => {
  it("requestApproval throws on unknown channel", async () => {
    const bundle = await workflowOf(CodeReview);
    const built = await createAppDeps(bundle, {
      gateway: { chatModel: () => ({}), embeddings: () => ({}) } as any,
      connectMcp: async () => ({ close: async () => undefined }),
    });
    const deps = built;
    await expect(deps.requestApproval("unknown-channel", {})).rejects.toThrow("Unknown channel");
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

  it("app-deps requestApproval successful call", async () => {
    // We need a channel to be returned by bundle.channels
    const mockChannel = { requestApproval: vi.fn().mockResolvedValue(undefined) };
    const bundle = await workflowOf(CodeReview);
    const originalChannels = bundle.channels;
    bundle.channels = () => new Map([["my-channel", mockChannel]]);

    const built = await createAppDeps(bundle, {
      gateway: { chatModel: () => ({}), embeddings: () => ({}) } as any,
      connectMcp: async () => ({ close: async () => undefined }),
    });

    await built.requestApproval("my-channel", {});
    expect(mockChannel.requestApproval).toHaveBeenCalled();

    bundle.channels = originalChannels;
    await built.close();
  });
});
