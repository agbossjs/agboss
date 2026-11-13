/**
 * #1006 AC1: the text of a turn that goes to a tool is retracted (`tool-turn`) and the next turn is
 * the next attempt; the text of a model call that breaks after partial chunks is retracted
 * (`stream-broken`) before the failure goes on.
 */
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { describe, expect, it } from "vitest";
import type { ExecutionStreamEvent } from "../../src/run/types.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import {
  AskStart,
  Desk,
  QuickLookup,
  RemoteDeskApplication,
} from "../a2a/fixtures/remote.workflow.js";
import { execute } from "../helpers/flow.js";
import { fakeChatFactory, fakeDeps, routeTo, runText } from "../helpers.js";
import { CANARY, useCanary } from "./canary.js";

const desk = testWith(RemoteDeskApplication);

describe("#1006: text before a tool call", () => {
  useCanary();

  desk(
    "AC1: the turn's text is discarded as a tool turn; the next turn is attempt 2",
    async ({ app, mockLlm }) => {
      mockLlm(Desk).thenReturn(
        callTool(QuickLookup, { orderId: "7" }),
        replyWith("Order 7 shipped."),
      );
      const events: ExecutionStreamEvent[] = [];

      const done = await execute(
        app,
        AskStart,
        { text: "where is order 7?" },
        { onStream: (event) => events.push(event) },
      );

      const step = (attempt: number) => ({
        agent: "desk-agent",
        visit: 1,
        branch: done.executionId,
        attempt,
      });
      expect(events).toEqual([
        { kind: "textDelta", delta: CANARY, step: step(1) },
        { kind: "discarded", step: step(1), reason: "tool-turn" },
        { kind: "toolCall", tool: "quick-lookup-tool" },
        { kind: "textDelta", delta: CANARY, step: step(2) },
        { kind: "textDelta", delta: "Order 7 shipped.", step: step(2) },
      ]);
    },
  );
});

/** A model that writes part of its answer and then breaks, as an SSE connection cut mid-answer. */
class BreakingModel extends FakeListChatModel {
  override async _generate(
    _messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    await runManager?.handleLLMNewToken("The answer is");
    throw new Error("connection reset");
  }
}

describe("#1006: a call that breaks after partial chunks", () => {
  it("AC1: discarded(stream-broken) comes before the failure; the partial text is not kept", async () => {
    const script = { "test/router": [routeTo("alpha-agent")] };
    const deps = await fakeDeps(script, {
      chatModel: (settings) =>
        settings.model === "test/alpha"
          ? new BreakingModel({ responses: [] })
          : fakeChatFactory(script)(settings),
    });
    const events: ExecutionStreamEvent[] = [];

    await expect(
      runText("Hi", deps, { onStream: (event) => events.push(event) }),
    ).rejects.toThrow();

    expect(events.map((event) => event.kind)).toEqual(["textDelta", "discarded"]);
    expect(events[1]).toMatchObject({ kind: "discarded", reason: "stream-broken" });
  });
});
