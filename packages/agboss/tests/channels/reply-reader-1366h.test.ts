/**
 * #1366: a model interpreter's reading of a reply — one tool call per move is asked for; its system text carries no
 * stray whitespace; a model that cannot call tools is refused as such; a block rule in the request refuses it
 * (`PiiRefusedError`); a reply that is not an AI message is read by its content; a "not understood" call declines with
 * its reason, or with a fallback for a blank, absent or non-text reason; only a call to the answer tool is an answer; an
 * approval whose correction changes the call's shape is declined with the reason; tokens nobody gave are declined.
 */
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import { readByModel, replyInterpreterCaller } from "../../src/channels/reply-reader.js";
import {
  withCorrectedCall,
  replyToolsOf,
  NOT_UNDERSTOOD_TOOL,
} from "../../src/channels/reply-tools.js";
import { Text } from "../../src/dto/index.js";
import { ToolCallApprovalDecisionDto } from "../../src/dto/standard/framework.js";
import { PiiRefusedError } from "../../src/pii/errors.js";
import { PiiPolicySet } from "../../src/pii/policy-set.js";
import { QUESTION_REPLY_INTERPRETER_SYSTEM } from "../../src/prompts/reply-interpreter.js";
import { Injectable } from "../../src/components/decorators.js";
import { componentOf } from "../../src/components/metadata.js";
import { runtimePolicyOf } from "../../src/pii/runtime-policy.js";
import type { PiiPolicyMeta } from "../../src/pii/pii-policy.decorator.js";
import { CardPiiPolicy } from "../pii/pii.fixture.js";

class WireRequestDto {
  @Text()
  account!: string;
}

@Injectable()
class PlainReader {}

const interpreter = {
  channel: "wire-approval-channel",
  interpreter: PlainReader,
  name: "wire-reply-interpreter",
  answer: ToolCallApprovalDecisionDto,
  approves: WireRequestDto,
  model: "test/wire-reader",
  instructions: "Read the reply.",
};
const question = { ...interpreter, approves: undefined };
const answerName = replyToolsOf(ToolCallApprovalDecisionDto, undefined).answer;
const ASK = { account: "A-1" };

/** A gateway whose model gives `reply` and records what it was bound with and asked. */
function gatewayGiving(reply: BaseMessage) {
  const bound: unknown[][] = [];
  const asked: BaseMessage[][] = [];
  const chat = {
    bindTools: (...args: unknown[]) => {
      bound.push(args);
      return {
        invoke: (messages: BaseMessage[]) => {
          asked.push(messages);
          return Promise.resolve(reply);
        },
      };
    },
  };
  return { gateway: { chatModel: () => chat }, bound, asked };
}

const settings = {
  model: "test/wire-reader",
  temperature: 0,
  maxTokens: 100,
  price: { inputPerMTok: 1, outputPerMTok: 1 },
};
const noPolicies = { policies: new PiiPolicySet([], "field-key"), known: {} };

function read(gateway: unknown, options: { role?: object; pii?: typeof noPolicies } = {}) {
  return readByModel(
    (options.role ?? interpreter) as never,
    { ask: ASK, reply: "yes" },
    { gateway: gateway as never, settings, callbacks: [], pii: options.pii ?? noPolicies },
  );
}

const call = (name: string, args: Record<string, unknown>) =>
  new AIMessage({ content: "", tool_calls: [{ id: "c1", name, args }] });

describe("#1366: how the model is asked", () => {
  it("one tool call per move: the tools are bound with parallel calls off", async () => {
    const { gateway, bound } = gatewayGiving(new AIMessage({ content: "hm" }));

    await read(gateway);

    expect(bound).toHaveLength(1);
    expect(bound[0]?.[1]).toEqual({ parallel_tool_calls: false });
  });

  it("the cost caller of an interpreter is its own name under reply-interpreter", async () => {
    expect(replyInterpreterCaller("wire")).toBe("reply-interpreter:wire");
    const { gateway } = gatewayGiving(new AIMessage({ content: "hm" }));

    const out = await read(gateway);

    expect(out.usage.at(-1)?.caller).toBe("reply-interpreter:wire-reply-interpreter");
  });

  it("the system text has no stray whitespace around it when the role has no instructions", async () => {
    const { gateway, asked } = gatewayGiving(new AIMessage({ content: "hm" }));

    await read(gateway, { role: { ...question, instructions: "" } });

    expect(asked[0]?.[0]?.content).toBe(QUESTION_REPLY_INTERPRETER_SYSTEM.trim());
  });

  it("a model that cannot call tools is refused as that", async () => {
    const gateway = { chatModel: () => ({}) };

    await expect(read(gateway)).rejects.toThrow(TypeError);
    await expect(read(gateway)).rejects.toThrow(/cannot call tools/);
  });

  it("a block rule in the request refuses it before the model is asked", async () => {
    const component = componentOf(CardPiiPolicy);
    if (component?.kind !== "pii-policy") throw new Error("not a policy");
    const meta: PiiPolicyMeta = component.meta;
    const policy = runtimePolicyOf({ meta, instance: new CardPiiPolicy(), key: "k" });
    const pii = { policies: new PiiPolicySet([policy], "field-key"), known: {} };
    const { gateway, asked } = gatewayGiving(new AIMessage({ content: "hm" }));

    await expect(
      readByModel(
        interpreter as never,
        { ask: ASK, reply: "my card is 4242 4242 4242 4242" },
        { gateway: gateway as never, settings, callbacks: [], pii },
      ),
    ).rejects.toThrow(PiiRefusedError);
    expect(asked).toEqual([]);
  });
});

describe("#1366: what the model's move is read as", () => {
  it("a reply that is not an AI message is read by its content: its tokens nobody gave are declined", async () => {
    const { gateway } = gatewayGiving(new HumanMessage("sure <email:0123456789ab>"));

    const out = await read(gateway);

    expect(out.kind).toBe("declined");
    expect(out.kind === "declined" ? out.reason : "").toContain("<email:0123456789ab>");
  });

  it("every unknown token is named in the declined reading", async () => {
    const { gateway } = gatewayGiving(
      new AIMessage({ content: "<email:0123456789ab> and <phone:abcdef012345>" }),
    );

    const out = await read(gateway);

    expect(out.kind === "declined" ? out.reason : "").toContain("<email:0123456789ab>");
    expect(out.kind === "declined" ? out.reason : "").toContain("<phone:abcdef012345>");
  });

  it("a call to a tool that is not the answer tool is no answer", async () => {
    const { gateway } = gatewayGiving(call("lookup", { approved: true }));

    const out = await read(gateway, { role: question });

    expect(out.kind).toBe("declined");
  });

  it("a call to the answer tool is the answer, as the call gave it", async () => {
    const { gateway } = gatewayGiving(call(answerName, { approved: true }));

    const out = await read(gateway, { role: question });

    expect(out).toMatchObject({ kind: "answered", answer: { approved: true } });
  });
});

describe("#1366: a call that says the reply is not understood", () => {
  const declinedReason = async (args: Record<string, unknown>): Promise<string> => {
    const { gateway } = gatewayGiving(call(NOT_UNDERSTOOD_TOOL, args));
    const out = await read(gateway);
    if (out.kind !== "declined") throw new Error("expected a decline");
    return out.reason;
  };

  it("declines with the model's reason when it gave one", async () => {
    expect(await declinedReason({ reason: "it is a shrug" })).toContain("it is a shrug");
  });

  it("a blank, an absent or a non-text reason all fall back to the same non-empty reason", async () => {
    const absent = await declinedReason({});
    const blank = await declinedReason({ reason: "   " });
    const empty = await declinedReason({ reason: "" });
    const number = await declinedReason({ reason: 5 });

    expect(blank).toBe(absent);
    expect(empty).toBe(absent);
    expect(number).toBe(absent);
    expect(absent).not.toContain("undefined");
    expect(absent).not.toContain("5");
    expect(absent.split(": ").at(-1)?.length).toBeGreaterThan(0);
    expect(absent).toBe(absent.trim());
  });

  it("wins over an answer beside it", async () => {
    const { gateway } = gatewayGiving(
      new AIMessage({
        content: "",
        tool_calls: [
          { id: "1", name: answerName, args: { approved: true } },
          { id: "2", name: NOT_UNDERSTOOD_TOOL, args: { reason: "unclear" } },
        ],
      }),
    );

    const out = await read(gateway, { role: question });

    expect(out.kind).toBe("declined");
  });
});

describe("#1366: an approval whose correction changes the call's shape", () => {
  it("is declined with the reason it is none, never taken", async () => {
    const answer = { decision: "approve-with-changes", overrideArguments: {} };
    const why = withCorrectedCall(answer, ASK);
    if (why.kind !== "invalid") throw new Error("the answer should be invalid");
    const { gateway } = gatewayGiving(
      call(replyToolsOf(ToolCallApprovalDecisionDto, WireRequestDto).answer, answer),
    );

    const out = await read(gateway);

    expect(out.kind).toBe("declined");
    expect(out.kind === "declined" ? out.reason : "").toContain(why.reason);
  });

  it("a valid approval is answered with the call's own arguments", async () => {
    const { gateway } = gatewayGiving(
      call(replyToolsOf(ToolCallApprovalDecisionDto, WireRequestDto).answer, {
        decision: "approve",
      }),
    );

    const out = await read(gateway);

    expect(out).toMatchObject({ kind: "answered", answer: { approved: true } });
  });
});
