/**
 * #946: a step key names no question by itself. The record a step finds by its key is reused only
 * for the question it was made for (its kind and its ask): another question's is refused with
 * `PauseStepKeyMismatchError` — never answered — and a reassigned pause's replacement is the same question.
 */
import { describe, expect, it } from "vitest";
import { answerRecordOf } from "../../src/infrastructure/pause-answer-log.js";
import { ChannelOutcome } from "../../src/channels/channel-outcome.js";
import { InMemoryPausedExecutionRepository } from "../../src/infrastructure/in-memory-paused-execution.repository.js";
import { NO_RECIPIENTS } from "../../src/infrastructure/pause-notices.js";
import { PauseKind, PauseResolution, PauseStatus } from "../../src/infrastructure/pause-record.js";
import { PauseStepKeyMismatchError } from "../../src/flow/runtime/pause-chain.js";
import { pauseStep } from "../../src/flow/runtime/pause.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { pauseOf } from "../../src/testing/contracts/paused-execution-data.js";
import { testFrame } from "../helpers/frame.js";
import { PauseRespondent } from "../../src/pause/respondent.js";
import { targetOfChannel, type FlatChannel } from "../helpers/pause-target.js";

const clock = new VirtualClock();
const toolCall = { callId: "call-1", tool: "refund", summary: "refund 7" };
const input = { orderId: "7" };
const question = { kind: PauseKind.Approval, step: "desk-clerk-agent", input, toolCall };
const channel: FlatChannel = {
  name: "refund-approval-channel",
  respondent: PauseRespondent.Delegate,
  sender: { send: () => Promise.resolve(ChannelOutcome.decided({ approved: true })) },
};
const answers = {
  savePauseAnswer: (): Promise<void> => Promise.resolve(),
  markPauseAnswerNotTaken: (): Promise<void> => Promise.resolve(),
  findPauseAnswersByTenantIdAndRootExecutionId: (): Promise<[]> => Promise.resolve([]),
};
const siteOf = (pauses: InMemoryPausedExecutionRepository) => ({
  pauses,
  answers,
  target: targetOfChannel(channel),
  frame: testFrame(),
  signal: undefined,
  clock,
  validate: (decision: unknown): unknown => decision,
  onSend: () => Promise.resolve(),
});

/** A pause already stored under the step's own key, answered, asking `stored`. */
async function storedUnderStepKey(stored: {
  readonly input: Readonly<Record<string, unknown>>;
  readonly toolCall?: typeof toolCall;
}) {
  const pauses = new InMemoryPausedExecutionRepository();
  const frame = testFrame();
  const stepKey = frame.step.idempotencyKey;
  const base = pauseOf("pause-x", stepKey);
  const record = {
    ...base,
    tenantId: frame.execution.tenant.tenantId,
    rootExecutionId: frame.execution.executionId,
    input: stored.input,
    ...(stored.toolCall === undefined ? {} : { toolCall: stored.toolCall }),
    isSent: true,
  };
  await pauses.findOrCreateByStepKey(record);
  await pauses.resolveByTenantIdAndPauseId(
    record.tenantId,
    "pause-x",
    { decision: { approved: true }, actor: { id: "someone" } },
    clock.now(),
    NO_RECIPIENTS,
  );
  return pauses;
}

describe("#946: a record found by a step key is reused only for its own question", () => {
  it("the same question (the keys of its arguments in another order too) is answered from the record", async () => {
    const reordered = {
      input: { orderId: "7" },
      toolCall: { summary: toolCall.summary, tool: "refund", callId: "call-1" },
    };
    const pauses = await storedUnderStepKey(reordered);

    const answer = await pauseStep(siteOf(pauses), question);

    expect(answer).toMatchObject({ decision: { approved: true }, by: "someone" });
  });

  it("another question under the same key is refused, never answered; the message names the key, not the id", async () => {
    const other = { input: { orderId: "8" }, toolCall };
    const pauses = await storedUnderStepKey(other);

    const refused: unknown = await pauseStep(siteOf(pauses), question).catch((e: unknown) => e);

    expect(refused).toBeInstanceOf(PauseStepKeyMismatchError);
    expect((refused as Error).message).not.toContain("pause-x");
    const [stored] = await pauses.findAllByTenantIdAndRootExecutionId(
      testFrame().execution.tenant.tenantId,
      testFrame().execution.executionId,
    );
    expect(stored?.status).toBe(PauseStatus.Resolved);
  });

  it("another kind under the same key is refused too", async () => {
    const pauses = await storedUnderStepKey({ input, toolCall });

    const refused: unknown = await pauseStep(siteOf(pauses), {
      ...question,
      kind: PauseKind.ExternalTask,
    }).catch((e: unknown) => e);

    expect(refused).toBeInstanceOf(PauseStepKeyMismatchError);
  });
});

describe("#946: the audit key of a pause", () => {
  it("a replacement's record is the step's own key; an ordinary key that ends in ~r1 is kept", () => {
    const ordinary = {
      ...pauseOf("p-1", "run-1:agent:1:call~r1"),
      resolvedAt: "2026-01-05T09:00:00.000Z",
    };
    const replacement = { ...ordinary, stepKey: "run-1:agent:1:call~r1~r2", reassignedFrom: "p-0" };

    expect(answerRecordOf(ordinary, PauseResolution.Replied).step.idempotencyKey).toBe(
      "run-1:agent:1:call~r1",
    );
    expect(answerRecordOf(replacement, PauseResolution.Replied).step.idempotencyKey).toBe(
      "run-1:agent:1:call~r1",
    );
  });
});
