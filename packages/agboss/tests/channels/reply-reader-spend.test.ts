/**
 * #1366: the spend of a model interpreter's reading — what masking the request cost (a model detector) and what the
 * call cost are both on the reading, whether the model answered or declined.
 */
import { describe, expect, it, vi } from "vitest";
import { readByModel } from "../../src/channels/reply-reader.js";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../src/finops/usage.js";
import { ToolCallApprovalDecisionDto } from "../../src/dto/standard/framework.js";
import { Text } from "../../src/dto/index.js";
import { PiiPolicySet } from "../../src/pii/policy-set.js";
import { DetectionMode } from "../../src/pii/runtime-policy.js";
import { replyWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { Injectable } from "../../src/components/decorators.js";

class WireRequestDto {
  @Text()
  account!: string;
}

@Injectable()
class PlainReader {}

const masking: UsageRecord = {
  ...ZERO_USAGE,
  caller: "pii-detector",
  model: "m",
  costUsd: 0.125,
  costSource: CostSource.Api,
};

/** A policy whose model detector finds nothing and charges for every text it reads. */
const detector = {
  name: "a-pii-policy",
  meta: { name: "a-pii-policy", rules: [] },
  actions: new Map(),
  find: vi.fn((_text: string, _mode: DetectionMode) =>
    Promise.resolve({ findings: [], usage: [masking] }),
  ),
  findNow: () => [],
  refusalOf: vi.fn(() => Promise.resolve("refused")),
};

const interpreter = {
  channel: "wire-approval-channel",
  interpreter: PlainReader,
  name: "wire-reply-interpreter",
  answer: ToolCallApprovalDecisionDto,
  approves: WireRequestDto,
  model: "test/wire-reader",
  instructions: "Read the reply.",
};

async function reading(book: ScriptBook, role: typeof interpreter | object = interpreter) {
  return readByModel(
    role as never,
    { ask: { tool: "wire" }, reply: "yes" },
    {
      gateway: createScriptedGateway(book),
      settings: { model: "test/wire-reader", temperature: 0, maxTokens: 100 },
      callbacks: [],
      pii: { policies: new PiiPolicySet([detector] as never, "field-key"), known: {} },
    },
  );
}

describe("#1366: what a model interpreter's reading cost", () => {
  it("is what masking the request cost, then the call's: every searched text is paid, the call is last", async () => {
    const book = new ScriptBook();
    book
      .scriptOf("reply-interpreter:wire-reply-interpreter")
      .thenReturn(replyWith(ToolCallApprovalDecisionDto, { approved: true }));

    const out = await reading(book);

    expect(out.kind).toBe("answered");
    expect(out.usage.at(-1)).toMatchObject({ caller: "reply-interpreter:wire-reply-interpreter" });
    expect(out.usage.slice(0, -1).length).toBeGreaterThanOrEqual(1);
    expect(out.usage.slice(0, -1).every((record) => record === masking)).toBe(true);
  });

  it("a model that gave no answer is declined with the same usage: the masking, then the call", async () => {
    const book = new ScriptBook();
    book
      .scriptOf("reply-interpreter:wire-reply-interpreter")
      .thenReturn(replyWith("I do not know"));

    const out = await reading(book);

    expect(out).toMatchObject({ kind: "declined", reason: "the model gave no answer" });
    expect(out.usage.at(-1)).toMatchObject({ caller: "reply-interpreter:wire-reply-interpreter" });
    expect(out.usage.slice(0, -1).every((record) => record === masking)).toBe(true);
  });

  it("an answer with a token nobody gave is declined with the usage too", async () => {
    const book = new ScriptBook();
    book
      .scriptOf("reply-interpreter:wire-reply-interpreter")
      .thenReturn(replyWith("sure <email:0123456789ab>"));

    const out = await reading(book);

    expect(out.kind).toBe("declined");
    expect(out.usage.at(-1)).toMatchObject({ caller: "reply-interpreter:wire-reply-interpreter" });
  });

  it("a question role's answer carries the usage as well: the masking, then the call", async () => {
    const book = new ScriptBook();
    book
      .scriptOf("reply-interpreter:wire-reply-interpreter")
      .thenReturn(replyWith(ToolCallApprovalDecisionDto, { approved: true }));

    const out = await reading(book, { ...interpreter, approves: undefined });

    expect(out.kind).toBe("answered");
    expect(out.usage.at(-1)).toMatchObject({ caller: "reply-interpreter:wire-reply-interpreter" });
    expect(out.usage.slice(0, -1).every((record) => record === masking)).toBe(true);
  });
});
