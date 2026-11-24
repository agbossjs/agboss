/**
 * #1343 (#202): `onModelFallback` — told by the provider's fallback chain, at the real hop: once
 * for each provider the call is moved to, in the step it is made for, with who asked, the
 * providers and models, and the failure's class and code — never its text. A call made outside a
 * step tells nothing.
 */
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { describe, expect, it } from "vitest";
import { ExecutionObserverManager } from "../../../src/core/observer-manager.js";
import { runInFrame } from "../../../src/flow/context/frame.js";
import { FallbackChatModel } from "../../../src/models/fallback-chat-model.js";
import { withFallback } from "../../../src/llm/provider-fallback.js";
import { ModelFallbackReason, type ModelFallbackEvent } from "../../../src/index.js";
import { ModelProvider, OpenAiCompatibleDriver } from "../../../src/models/index.js";
import {
  modelProviderOf,
  type ModelProviderType,
} from "../../../src/models/model-provider.decorator.js";
import { seconds } from "../../../src/units/index.js";
import { testFrame } from "../../helpers/frame.js";

const driver = OpenAiCompatibleDriver({ baseUrl: "http://x.test/v1" });
const common = { timeout: seconds(5), driver };

@ModelProvider({ ...common, models: { default: "c/big" } })
class Tertiary {}

@ModelProvider({ ...common, models: { default: "b/big" }, fallback: Tertiary })
class Secondary {}

@ModelProvider({ ...common, models: { default: "a/big" }, fallback: Secondary })
class Primary {}

/** A chat model that answers its text, or fails with its error. */
class Scripted extends BaseChatModel {
  constructor(private readonly outcome: string | Error) {
    super({});
  }

  _llmType(): string {
    return "scripted";
  }

  _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    if (this.outcome instanceof Error) return Promise.reject(this.outcome);
    const message = new AIMessage({ content: this.outcome });
    return Promise.resolve({ generations: [{ text: this.outcome, message }] });
  }
}

const registered = (cls: ModelProviderType) => ({
  type: cls,
  options: modelProviderOf(cls),
  handler: undefined,
});

/** `Primary` down with a 503 text that holds a secret, `Secondary` down too, `Tertiary` answering. */
const SECRET = "sk-live-secret-key";
const down = (): Error =>
  Object.assign(new Error(`unavailable for ${SECRET}`), { status: 503, code: "upstream_down" });

function chainChat() {
  const by = new Map<string, Scripted>([
    ["primary", new Scripted(down())],
    ["secondary", new Scripted(down())],
    ["tertiary", new Scripted("from tertiary")],
  ]);
  return withFallback(by.get("primary") as BaseChatModel, {
    provider: registered(Primary),
    registeredFor: registered,
    settings: { model: "a/big" } as never,
    calls: undefined,
    chatOf: (provider) => by.get(provider.options.name) as BaseChatModel,
  });
}

const told: ModelFallbackEvent[] = [];
const observer = new ExecutionObserverManager([
  {
    onModelFallback: (event: ModelFallbackEvent) => {
      told.push(event);
    },
  },
]);

const inObservedStep = <T>(work: () => Promise<T>): Promise<T> => {
  const frame = testFrame();
  return runInFrame({ ...frame, execution: { ...frame.execution, observer } }, work);
};

describe("#1343: onModelFallback", () => {
  it("each hop the call moves to is told, in the step that asked, with the failure's class and code", async () => {
    told.length = 0;

    const answer = await inObservedStep(() => chainChat().invoke([new HumanMessage("hi")]));

    expect(answer.text).toBe("from tertiary");
    expect(told).toHaveLength(2);
    expect(told[0]).toMatchObject({
      primaryProvider: "primary",
      primaryModel: "a/big",
      fallbackProvider: "secondary",
      fallbackModel: "b/big",
      reason: ModelFallbackReason.Failed,
      error: { name: "Error", code: "upstream_down" },
    });
    expect(told[1]).toMatchObject({ fallbackProvider: "tertiary", fallbackModel: "c/big" });
    expect(told[0]?.step?.component.name).toBeDefined();
    expect(told[0]?.caller).toBe(told[0]?.step?.component.name);
  });

  it("an event never shows the failure's text", async () => {
    told.length = 0;

    await inObservedStep(() => chainChat().invoke([new HumanMessage("hi")]));

    expect(JSON.stringify(told)).not.toContain(SECRET);
  });

  it("a call made outside any step tells nothing, and is still answered", async () => {
    told.length = 0;

    const answer = await chainChat().invoke([new HumanMessage("hi")]);

    expect(answer.text).toBe("from tertiary");
    expect(told).toEqual([]);
  });
});

describe("#1343: onModelFallback when the breaker is open", () => {
  it("the first hop is told with no failure: the primary was not tried", async () => {
    const afters: unknown[] = [];
    const chat = new FallbackChatModel({
      primary: new Scripted(down()),
      breaker: { isOpen: () => Promise.resolve(true) } as never,
      hops: [
        {
          chatModel: () => new Scripted("from backup"),
          model: "b/big",
          cost: undefined,
          provider: "backup",
        },
      ],
      onHop: (_hop, after) => {
        afters.push(after);
        return Promise.resolve();
      },
    });

    const answer = await chat.invoke([new HumanMessage("hi")]);

    expect(answer.text).toBe("from backup");
    expect(afters).toEqual([undefined]);
  });
});
