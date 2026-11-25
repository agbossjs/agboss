/**
 * #1366, #1065 (shard `cancel-x-pauses`): what the expiry of one pause records (`pause-expiry.ts`) — the
 * channel's decision asked in the pause's frame under its timeout, a handler that fails, times out or returns
 * what is no decision falls back to `fail()` with the fixed problem logged, the instance's stop records
 * nothing — and what a closed pause leaves behind (its notices, its tally, its log row).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { duePausesOf, expirePauses } from "../../src/app/pause-expiry.js";
import { NoticeTimeoutError } from "../../src/app/pause-notice-call.js";
import { PauseExpiration } from "../../src/channels/pause-expiration.js";
import {
  ExpiryProblem,
  PauseExpiryBound,
  PauseKind,
  pauseKeyOf,
  PauseResolution,
  PauseStatus,
} from "../../src/infrastructure/pause-record.js";
import { RECIPIENTS } from "../../src/testing/contracts/paused-execution-data.js";
import { DEFAULT_TOOL_TIMEOUT } from "../../src/tools/index.js";
import { seconds } from "../../src/units/index.js";
import { PauseRespondent } from "../../src/pause/respondent.js";

const mocks = vi.hoisted(() => ({
  isCancelRequested: vi.fn(),
  callInFrame: vi.fn(),
  pauseTreeOf: vi.fn(),
  pauseFrameOf: vi.fn(),
  treeStateOf: vi.fn(),
  answerValidatorOf: vi.fn(),
  validate: vi.fn(),
  treeToolsOf: vi.fn(),
  treeQuestionAnswersOf: vi.fn(),
}));
vi.mock("../../src/app/cancel-requests.js", () => ({ isCancelRequested: mocks.isCancelRequested }));
vi.mock("../../src/app/pause-notice-call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/app/pause-notice-call.js")>()),
  callInFrame: mocks.callInFrame,
}));
vi.mock("../../src/app/pause-frame.js", () => ({
  pauseTreeOf: mocks.pauseTreeOf,
  pauseFrameOf: mocks.pauseFrameOf,
  treeStateOf: mocks.treeStateOf,
}));
vi.mock("../../src/channels/decision.js", () => ({ answerValidatorOf: mocks.answerValidatorOf }));
vi.mock("../../src/app/child-deps.js", () => ({
  treeToolsOf: mocks.treeToolsOf,
  treeQuestionAnswersOf: mocks.treeQuestionAnswersOf,
}));

const NOW = new Date("2026-01-01T12:00:00.000Z");
const pause = (overrides: Record<string, unknown> = {}) => ({
  pauseId: "p-1",
  tenantId: "acme",
  rootExecutionId: "root-1",
  workflow: "desk-workflow",
  channel: "refund-channel",
  target: "refund-tool-approval",
  status: PauseStatus.Pending,
  kind: PauseKind.Approval,
  respondent: PauseRespondent.Delegate,
  step: "desk-clerk-agent",
  input: {},
  toolCall: { callId: "c-1", tool: "refund", summary: "refund" },
  trail: [],
  askedAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-01-01T11:00:00.000Z",
  expiryBound: PauseExpiryBound.Pause,
  ...overrides,
});

function partsOf(
  options: {
    sender?: unknown;
    channelOf?: unknown;
    pauseStores?: boolean;
    applied?: Record<string, unknown> | undefined;
    toolTimeout?: number;
  } = {},
) {
  const expire = vi.fn((_t: string, id: string, _e: unknown, _at: Date, _r: unknown) =>
    Promise.resolve(
      "applied" in options
        ? options.applied
        : { ...pause({ pauseId: id }), resolution: PauseResolution.Expired },
    ),
  );
  const savePauseAnswer = vi.fn(() => Promise.resolve());
  const warn = vi.fn();
  const delivered = vi.fn();
  const closed = vi.fn();
  const tools = vi.fn((_tool: string) => ({ timeout: options.toolTimeout ?? 7000 }));
  const deps = {
    config: { name: "desk-workflow" },
    graph: { nodes: new Map(), type: Error },
    channelOf:
      "channelOf" in options ? options.channelOf : () => ({ sender: options.sender ?? {} }),
    // the expiry is the target's call (`onExpired`), kept here under the old option's name
    targetOf: () => ({
      onExpired: (options.sender as { onPauseExpired?: unknown } | undefined)?.onPauseExpired,
    }),
    tools,
    log: { warn },
    pause:
      options.pauseStores === false
        ? undefined
        : {
            pauses: {
              findAllByTenantIdAndRootExecutionId: vi.fn(() => Promise.resolve([])),
              expireByTenantIdAndPauseId: expire,
            },
            answers: { savePauseAnswer },
            notices: { recipientsOf: () => RECIPIENTS, delivered, tally: { closed } },
          },
  };
  const trees = { id: "trees" };
  const clock = { now: () => NOW, id: "clock" };
  return {
    parts: { deps, trees, clock } as never,
    deps,
    trees,
    clock,
    expire,
    savePauseAnswer,
    warn,
    delivered,
    closed,
    tools,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isCancelRequested.mockResolvedValue(false);
  mocks.treeStateOf.mockResolvedValue({ state: true });
  mocks.pauseTreeOf.mockResolvedValue("the tree");
  mocks.pauseFrameOf.mockReturnValue("the frame");
  mocks.treeToolsOf.mockReturnValue("the tools");
  mocks.treeQuestionAnswersOf.mockReturnValue("the questions");
  mocks.answerValidatorOf.mockReturnValue(mocks.validate);
  mocks.validate.mockImplementation((answer: unknown) => ({ validated: answer }));
  mocks.callInFrame.mockImplementation((_call: unknown, work: () => Promise<unknown>) => work());
});

describe("#1366: the pauses due", () => {
  it("a workflow with no pause stores has none due", async () => {
    const { parts } = partsOf({ pauseStores: false });

    expect(await duePausesOf(parts, { tenantId: "acme", runId: "root-1" }, NOW)).toEqual([]);
  });

  it("a pause with no deadline is never due, however late", async () => {
    const { parts, deps } = partsOf();
    deps.pause?.pauses.findAllByTenantIdAndRootExecutionId.mockResolvedValue([
      pause({ pauseId: "none", expiresAt: undefined }),
      pause({ pauseId: "due" }),
    ] as never);

    const found = await duePausesOf(
      parts,
      { tenantId: "acme", runId: "root-1" },
      new Date("2100-01-01T00:00:00.000Z"),
    );

    expect(found.map((one) => one.pauseId)).toEqual(["due"]);
    expect(deps.pause?.pauses.findAllByTenantIdAndRootExecutionId).toHaveBeenCalledWith(
      "acme",
      "root-1",
    );
  });
});

describe("#1366: the channel's decision on an expiry", () => {
  it("asked in the pause's own frame under the tool's timeout for an approval; the handler is told the pause and its ask", async () => {
    const onPauseExpired = vi.fn(() => PauseExpiration.fail());
    const { parts, expire, tools, clock } = partsOf({
      sender: { onPauseExpired },
      toolTimeout: 7000,
    });
    const signal = new AbortController().signal;

    expect(await expirePauses(parts, [pause() as never], signal)).toBe(1);

    expect(mocks.treeStateOf).toHaveBeenCalledWith(expect.anything(), "root-1");
    expect(mocks.pauseTreeOf).toHaveBeenCalledWith(expect.anything(), pause(), { state: true });
    expect(mocks.pauseFrameOf).toHaveBeenCalledWith(expect.anything(), pause(), "the tree");
    expect(tools).toHaveBeenCalledWith("refund");
    expect(mocks.callInFrame).toHaveBeenCalledWith(
      { frame: "the frame", timeout: 7000, clock, interruption: signal },
      expect.any(Function),
    );
    expect(onPauseExpired).toHaveBeenCalledWith(
      expect.objectContaining({
        pauseKey: pauseKeyOf("acme", "p-1"),
        input: pause().input,
        trail: [],
      }),
    );
    expect(expire).toHaveBeenCalledWith("acme", "p-1", {}, NOW, RECIPIENTS);
  });

  it("a question asks under the default tool timeout, and no tool is looked up", async () => {
    const { parts, tools } = partsOf({ sender: { onPauseExpired: () => PauseExpiration.fail() } });

    await expirePauses(parts, [
      pause({ kind: PauseKind.ExternalTask, ask: { question: "?" } }) as never,
    ]);

    expect(tools).not.toHaveBeenCalled();
    expect(mocks.callInFrame.mock.calls[0]?.[0]).toMatchObject({ timeout: DEFAULT_TOOL_TIMEOUT });
  });

  it("decide(answer): the answer is validated like a resume's, against the tree's tools and questions, and recorded as the channel's", async () => {
    const { parts, expire } = partsOf({
      sender: { onPauseExpired: () => PauseExpiration.decide({ approved: true } as never) },
    });

    await expirePauses(parts, [pause() as never]);

    expect(mocks.answerValidatorOf).toHaveBeenCalledWith(pause(), {
      tools: "the tools",
      questions: "the questions",
    });
    expect(mocks.validate).toHaveBeenCalledWith({ approved: true });
    expect(expire).toHaveBeenCalledWith(
      "acme",
      "p-1",
      { answer: { decision: { validated: { approved: true } }, actor: undefined } },
      NOW,
      RECIPIENTS,
    );
  });

  it("an answer that does not validate: the pause expires as fail(), the fixed problem recorded and logged", async () => {
    const { parts, expire, warn } = partsOf({
      sender: { onPauseExpired: () => PauseExpiration.decide({ approved: "maybe" } as never) },
    });
    mocks.validate.mockImplementation(() => {
      throw new Error("not a decision");
    });

    await expirePauses(parts, [pause() as never]);

    expect(expire).toHaveBeenCalledWith(
      "acme",
      "p-1",
      { problem: ExpiryProblem.AnswerInvalid },
      NOW,
      RECIPIENTS,
    );
    expect(warn).toHaveBeenCalledWith(
      "pause.expiry-handler-failed",
      `pause expiry decision of target refund-tool-approval fell back to fail(): ${ExpiryProblem.AnswerInvalid} (pauseKey ${pauseKeyOf("acme", "p-1")})`,
      { tenantId: "acme", executionId: "root-1" },
    );
  });

  it("a handler that returns no decision: fail() with the handler-failed problem", async () => {
    const { parts, expire, warn } = partsOf({ sender: { onPauseExpired: () => "later" } });

    await expirePauses(parts, [pause() as never]);

    expect(expire).toHaveBeenCalledWith(
      "acme",
      "p-1",
      { problem: ExpiryProblem.HandlerFailed },
      NOW,
      RECIPIENTS,
    );
    expect(warn).toHaveBeenCalledOnce();
  });

  it("fail(): nothing is validated, nothing is logged, the expiry is empty", async () => {
    const { parts, expire, warn } = partsOf({
      sender: { onPauseExpired: () => PauseExpiration.fail() },
    });

    await expirePauses(parts, [pause() as never]);

    expect(expire).toHaveBeenCalledWith("acme", "p-1", {}, NOW, RECIPIENTS);
    expect(mocks.answerValidatorOf).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("a handler that times out, or throws: fail() with its problem — each its own", async () => {
    for (const [error, problem] of [
      [new NoticeTimeoutError(seconds(1)), ExpiryProblem.HandlerTimeout],
      [new Error("the handler failed"), ExpiryProblem.HandlerFailed],
    ] as const) {
      const { parts, expire } = partsOf({
        sender: { onPauseExpired: () => Promise.reject(error) },
      });

      await expirePauses(parts, [pause() as never]);

      expect(expire).toHaveBeenCalledWith("acme", "p-1", { problem }, NOW, RECIPIENTS);
    }
  });

  it("the instance stopping: no decision is recorded, the failure is the look's, the pause stays pending", async () => {
    const stop = new AbortController();
    stop.abort(new Error("stop"));
    const failure = new Error("interrupted");
    const { parts, expire, warn } = partsOf({
      sender: { onPauseExpired: () => Promise.reject(failure) },
    });

    await expect(expirePauses(parts, [pause() as never], stop.signal)).rejects.toBe(failure);

    expect(expire).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("a frame that cannot be read is the look's to retry, never a decision recorded against the channel", async () => {
    const { parts, expire } = partsOf({ sender: { onPauseExpired: () => PauseExpiration.fail() } });
    mocks.pauseTreeOf.mockRejectedValue(new Error("the store failed"));

    await expect(expirePauses(parts, [pause() as never])).rejects.toThrow("the store failed");

    expect(expire).not.toHaveBeenCalled();
  });

  it("a channel a deploy removed, or a workflow with no channels: fail(), no handler", async () => {
    for (const channelOf of [
      () => {
        throw new Error("Unknown channel");
      },
      undefined,
    ]) {
      const { parts, expire } = partsOf({ channelOf });

      await expirePauses(parts, [pause() as never]);

      expect(expire).toHaveBeenCalledWith("acme", "p-1", {}, NOW, RECIPIENTS);
      expect(mocks.callInFrame).not.toHaveBeenCalled();
    }
  });

  it("a channel with no expiry handler: fail(), the frame never read", async () => {
    const { parts, expire } = partsOf({ sender: {} });

    await expirePauses(parts, [pause() as never]);

    expect(expire).toHaveBeenCalledWith("acme", "p-1", {}, NOW, RECIPIENTS);
    expect(mocks.treeStateOf).not.toHaveBeenCalled();
  });

  it("a pause bound by the run's deadline or a quorum's is expired with no handler, though its channel has one", async () => {
    const onPauseExpired = vi.fn();
    const { parts, expire } = partsOf({ sender: { onPauseExpired } });

    await expirePauses(parts, [
      pause({ pauseId: "a", expiryBound: PauseExpiryBound.RunDeadline }) as never,
      pause({ pauseId: "b", expiryBound: PauseExpiryBound.Quorum }) as never,
    ]);

    expect(onPauseExpired).not.toHaveBeenCalled();
    expect(expire).toHaveBeenCalledTimes(2);
  });
});

describe("#1366: what a closed pause leaves behind, and what stops the expiring", () => {
  it("a workflow with no pause stores closes none and asks nothing", async () => {
    const { parts } = partsOf({ pauseStores: false });

    expect(await expirePauses(parts, [pause() as never])).toBe(0);

    expect(mocks.isCancelRequested).not.toHaveBeenCalled();
  });

  it("a cancel is looked for on the pause's tree before and after the handler", async () => {
    const { parts, trees } = partsOf();

    await expirePauses(parts, [pause() as never]);

    expect(mocks.isCancelRequested).toHaveBeenCalledTimes(2);
    expect(mocks.isCancelRequested).toHaveBeenNthCalledWith(1, trees, {
      tenantId: "acme",
      rootExecutionId: "root-1",
    });
    expect(mocks.isCancelRequested).toHaveBeenNthCalledWith(2, trees, {
      tenantId: "acme",
      rootExecutionId: "root-1",
    });
  });

  it("a closed pause: its notices looked for, its tally told, its close logged as the store recorded it", async () => {
    const { parts, delivered, closed, savePauseAnswer } = partsOf({
      applied: { ...pause(), resolution: PauseResolution.DecidedOnExpiry },
    });

    expect(await expirePauses(parts, [pause() as never])).toBe(1);

    expect(delivered).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledWith({
      ...pause(),
      resolution: PauseResolution.DecidedOnExpiry,
    });
    expect(savePauseAnswer).toHaveBeenCalledWith(
      "acme",
      "root-1",
      expect.objectContaining({ resolution: PauseResolution.DecidedOnExpiry }),
    );
  });

  it("a close the store names no resolution for is logged as expired", async () => {
    const { parts, savePauseAnswer } = partsOf({ applied: { ...pause(), resolution: undefined } });

    await expirePauses(parts, [pause() as never]);

    expect(savePauseAnswer).toHaveBeenCalledWith(
      "acme",
      "root-1",
      expect.objectContaining({ resolution: PauseResolution.Expired }),
    );
  });

  it("a pause the store refuses (closed meanwhile) leaves nothing behind and the next is still tried", async () => {
    const { parts, expire, delivered, closed } = partsOf();
    expire.mockResolvedValueOnce(undefined);

    expect(
      await expirePauses(parts, [
        pause({ pauseId: "a" }) as never,
        pause({ pauseId: "b" }) as never,
      ]),
    ).toBe(1);

    expect(expire).toHaveBeenCalledTimes(2);
    expect(delivered).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledOnce();
  });
});
