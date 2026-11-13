/**
 * #1004 AC3, AC4: the user's stream is reached through one explicit mark — the answering call of an
 * agent — never through whatever inherits the run's callbacks; tracing still hears every call.
 */
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { describe, expect, it } from "vitest";
import type { ExecutionStreamEvent } from "../../src/run/types.js";
import type { ExecutionTracing } from "../../src/tracing/index.js";
import { fakeDeps, routeTo, runText } from "../helpers.js";
import { deltas } from "./writer.fixture.js";

/** Every call writes its first scripted answer as one token, and notes which handlers it had. */
class TokenModel extends FakeListChatModel {
  static readonly handlerNames: string[][] = [];

  override async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const result = await super._generate(messages, options, runManager);
    for (const generation of result.generations) {
      generation.message.response_metadata = { usage: { cost: 0 } }; // free: no price needed
    }
    const text = result.generations[0]?.text ?? "";
    TokenModel.handlerNames.push((runManager?.handlers ?? []).map((handler) => handler.name));
    await runManager?.handleLLMNewToken(text);
    return result;
  }
}

/** The tracing seam: a handler that records every token of every model call. */
class TokenRecorder extends BaseCallbackHandler {
  name = "token-recorder";
  readonly tokens: string[] = [];
  override handleLLMNewToken(token: string): void {
    this.tokens.push(token);
  }
}

const ROUTE = routeTo("alpha-agent");

async function depsWith(recorder?: TokenRecorder) {
  const deps = await fakeDeps(
    { "test/router": [ROUTE], "test/alpha": ["The answer."] },
    {
      chatModel: (settings) =>
        new TokenModel({
          responses: [...(settings.model === "test/router" ? [ROUTE] : ["The answer."])],
        }),
    },
  );
  if (recorder === undefined) return deps;
  const tracing: ExecutionTracing = {
    callbacks: () => [recorder],
    sessionUrl: () => undefined,
    shutdown: () => Promise.resolve(),
  };
  return { ...deps, tracing };
}

describe("#1004: the answer is the one marked call", () => {
  it("AC3: the router's call writes a token, the user's stream carries the answer's only", async () => {
    TokenModel.handlerNames.length = 0;
    const events: ExecutionStreamEvent[] = [];

    await runText("Hi", await depsWith(), { onStream: (event) => events.push(event) });

    expect(deltas(events)).toEqual(["The answer."]);
    // the router's call had no stream handler, the agent's own had exactly one
    const named = TokenModel.handlerNames.map(
      (names) => names.filter((n) => n === "AnswerTokenHandler").length,
    );
    expect(named).toEqual([0, 1]);
  });

  it("AC4: a tracing handler hears every model call, the stream only the answer", async () => {
    const recorder = new TokenRecorder();
    const events: ExecutionStreamEvent[] = [];

    await runText("Hi", await depsWith(recorder), { onStream: (event) => events.push(event) });

    expect(recorder.tokens).toEqual([ROUTE, "The answer."]);
    expect(deltas(events)).toEqual(["The answer."]);
  });

  it("a run without onStream attaches no stream handler to any call", async () => {
    TokenModel.handlerNames.length = 0;

    await runText("Hi", await depsWith());

    expect(TokenModel.handlerNames.flat()).not.toContain("AnswerTokenHandler");
  });
});
