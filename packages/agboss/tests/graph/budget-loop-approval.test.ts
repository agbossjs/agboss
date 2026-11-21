/**
 * #1366 (budget-loop shard) — the approval of a tool call at the loop's approval step, each rule on its own over
 * fakes: the interpreter's spend of a free-text reply is the loop's spend from now on (#267 PR 3), what the approver
 * decided is kept by the call's id, a declined call is recorded without running, and a failed ask fails the agent with
 * the loop's spend — a channel's failure with its own cause.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DtoValidationError } from "../../src/dto/errors.js";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../src/finops/usage.js";
import { ChannelSendError } from "../../src/flow/runtime/pause.js";
import { AgentFailedError } from "../../src/graph/errors.js";
import { makeApprovalNode } from "../../src/graph/agent-loop/approval-node.js";
import { awaitingApproval } from "../../src/graph/agent-loop/boundary.js";
import { callStepOf, declinedCallRecordOf } from "../../src/graph/agent-loop/call-records.js";

vi.mock("../../src/graph/agent-loop/boundary.js", () => ({ awaitingApproval: vi.fn() }));
vi.mock("../../src/graph/agent-loop/call-records.js", () => ({
  callStepOf: vi.fn(() => ({ step: true })),
  declinedCallRecordOf: vi.fn(() => ({ declined: true })),
}));
vi.mock("../../src/flow/runtime/tool-keys.js", () => ({
  toolRecordOf: vi.fn((tool: { name: string }) => ({ name: tool.name, kind: "tool" })),
}));
vi.mock("../../src/flow/context/frame.js", async (original) => ({
  ...(await original<typeof import("../../src/flow/context/frame.js")>()),
  inToolCallFrame: vi.fn((_id: unknown, _services: unknown, work: () => unknown) => work()),
}));

const record = (costUsd: number, caller = "x"): UsageRecord => ({
  ...ZERO_USAGE,
  caller,
  model: "m",
  costUsd,
  costSource: CostSource.Api,
});

const stateOf = () =>
  ({
    runId: "run-1",
    usage: [record(1, "before"), record(0.5, "loop")],
    from: { usage: 1 },
    flowPath: ["a"],
    toolLoopIteration: 0,
  }) as never;

const call = { callId: "c1", tool: "write-tool", args: { to: "x" } };

function setup(options: { tool?: object | undefined; approval?: object | undefined } = {}) {
  const requestApproval = vi.fn((..._args: unknown[]) =>
    Promise.resolve<Record<string, unknown>>({
      approved: true,
      by: "boss",
      usage: [record(0.25, "interpreter")],
    }),
  );
  const tool = "tool" in options ? options.tool : { name: "write-tool", channel: "ch", input: {} };
  const approval = "approval" in options ? options.approval : { requestApproval };
  const deps = {
    agent: { name: "alpha", tools: tool === undefined ? [] : [tool] },
    budgets: {},
    approval,
  };
  vi.mocked(awaitingApproval).mockReturnValue([call] as never);
  return { node: makeApprovalNode(deps as never), requestApproval };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("#1366: the spend of an approval", () => {
  it("the interpreter's calls are the loop's spend; what was decided is kept by the call's id", async () => {
    const { node, requestApproval } = setup();

    const out = await node(stateOf(), { signal: new AbortController().signal });

    // strictly: a reason or arguments the approver did not give are no keys with `undefined`
    expect(out).toStrictEqual({
      decisions: { c1: { approved: true, by: "boss" } },
      usage: [record(0.25, "interpreter")],
    });
    const [ask, agent, tool, signal] = requestApproval.mock.calls[0] ?? [];
    expect(ask).toEqual({
      callId: "c1",
      tool: "write-tool",
      arguments: { to: "x" },
      summary: expect.stringContaining("call write-tool with"),
    });
    expect(agent).toBe("alpha");
    expect(tool).toMatchObject({ name: "write-tool" });
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("the reason and the arguments the approver gave are kept, and nothing the approver did not give", async () => {
    const { node, requestApproval } = setup();
    requestApproval.mockResolvedValue({
      approved: true,
      by: "boss",
      reason: "fine",
      overrideArguments: { to: "y" },
      usage: [],
    });

    const out = await node(stateOf(), undefined);

    expect(out.decisions).toEqual({
      c1: { approved: true, by: "boss", reason: "fine", overrideArguments: { to: "y" } },
    });
    expect(out.usage).toEqual([]);
  });

  it("a declined call never runs: its record is made here, and what the interpreter cost is still the loop's", async () => {
    const { node, requestApproval } = setup();
    requestApproval.mockResolvedValue({
      approved: false,
      by: "boss",
      usage: [record(0.25, "interpreter")],
    });

    const out = await node(stateOf(), undefined);

    expect(out).toMatchObject({
      decisions: { c1: { approved: false, by: "boss" } },
      usage: [record(0.25, "interpreter")],
      callRecords: { c1: { declined: true } },
    });
    expect(vi.mocked(callStepOf).mock.calls[0]?.[1]).toBe("c1");
    expect(vi.mocked(callStepOf).mock.calls[0]?.[3]).toBe("alpha");
    expect(vi.mocked(declinedCallRecordOf).mock.calls[0]?.[0]).toEqual({ step: true });
    expect(vi.mocked(declinedCallRecordOf).mock.calls[0]?.[1]).toEqual({ to: "x" });
    expect(vi.mocked(declinedCallRecordOf).mock.calls[0]?.[2]).toBeInstanceOf(Date);
  });

  it("an approved call has no record made here", async () => {
    const { node } = setup();

    const out = await node(stateOf(), undefined);

    expect("callRecords" in out).toBe(false);
    expect(declinedCallRecordOf).not.toHaveBeenCalled();
  });
});

describe("#1366: no one is asked", () => {
  it("a call that waits for no approval asks nobody", async () => {
    const { node, requestApproval } = setup();
    vi.mocked(awaitingApproval).mockReturnValue([]);

    expect(await node(stateOf(), undefined)).toEqual({});
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it("an agent with no approval to ask asks nobody", async () => {
    const { node } = setup({ approval: undefined });

    expect(await node(stateOf(), undefined)).toEqual({});
  });

  it("a tool with no channel, or no tool of that name, asks nobody", async () => {
    const noChannel = setup({ tool: { name: "write-tool", input: {} } });
    const noTool = setup({ tool: undefined });

    expect(await noChannel.node(stateOf(), undefined)).toEqual({});
    expect(await noTool.node(stateOf(), undefined)).toEqual({});
    expect(noChannel.requestApproval).not.toHaveBeenCalled();
    expect(noTool.requestApproval).not.toHaveBeenCalled();
  });
});

describe("#1366: a failed ask fails the agent with the loop's spend", () => {
  it("a channel that could not send: its own cause, the loop's spend", async () => {
    const { node, requestApproval } = setup();
    const cause = new Error("smtp down");
    requestApproval.mockRejectedValue(new ChannelSendError("mail", cause));

    const failure = await node(stateOf(), undefined).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(AgentFailedError);
    expect((failure as AgentFailedError).cause).toBe(cause);
    expect((failure as AgentFailedError).usage).toEqual([record(0.5, "loop")]);
  });

  it("any other failure of an approval rises as it is, a validation of the decision too", async () => {
    const { node, requestApproval } = setup();
    const invalid = new DtoValidationError({
      dto: "Decision",
      issues: [{ path: "by", reason: "Required" }],
    });
    requestApproval.mockRejectedValue(invalid);

    await expect(node(stateOf(), undefined)).rejects.toBe(invalid);

    requestApproval.mockRejectedValue(new Error("broke"));
    await expect(node(stateOf(), undefined)).rejects.toThrow("broke");
  });
});
