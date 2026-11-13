/**
 * #1006: an agent without a blocking check streams at once — its first delta reaches the listener
 * while its model call is still running, not after it.
 */
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { expect, it } from "vitest";
import type { ExecutionStreamEvent } from "../../src/run/types.js";
import { fakeChatFactory, fakeDeps, routeTo, runText } from "../helpers.js";

/** Writes its answer in two tokens and notes what the listener had heard between them. */
class Observed extends FakeListChatModel {
  constructor(
    private readonly heard: () => number,
    private readonly seen: number[],
  ) {
    super({ responses: ["Hello world."] });
  }

  override async _generate(
    _messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    await runManager?.handleLLMNewToken("Hello");
    this.seen.push(this.heard());
    await runManager?.handleLLMNewToken(" world.");
    const result = await super._generate(_messages, _options, runManager);
    for (const generation of result.generations) {
      generation.message.response_metadata = { usage: { cost: 0 } };
    }
    return result;
  }
}

it("the first delta is heard before the model call ends", async () => {
  const events: ExecutionStreamEvent[] = [];
  const seen: number[] = [];
  const script = { "test/router": [routeTo("alpha-agent")] };
  const deps = await fakeDeps(script, {
    chatModel: (settings) =>
      settings.model === "test/alpha"
        ? new Observed(() => events.length, seen)
        : fakeChatFactory(script)(settings),
  });

  await runText("Hi", deps, { onStream: (event) => events.push(event) });

  expect(seen).toEqual([1]);
  expect(events.map((event) => (event.kind === "textDelta" ? event.delta : event.kind))).toEqual([
    "Hello",
    " world.",
  ]);
});
