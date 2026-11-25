/**
 * #267 PR 3: reply interpreters are checked at assembly, all problems at once —
 * `[reply-interpreter.not-an-interpreter]` (a `replyInterpreter` without `@ChannelInterpreter`),
 * `[name.not-kebab-case]`, `[reply-interpreter.no-interpret-method]` (a code
 * one without `interpret`); a decision model reads any role's reply (every role is an approval,
 * #647). A model interpreter's call is traced under the pause's execution: the trace's
 * callbacks see it.
 */
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { resolvedModelUsesOf } from "../../src/models/resolution.js";
import { TreasuryApplication } from "../flow/fixtures/replies.fixture.js";
import { ChannelInterpreter } from "../../src/channels/channel-interpreter.js";
import { Injectable } from "../../src/components/decorators.js";
import { replyInterpreterViolations } from "../../src/channels/discovery.js";
import { readByModel } from "../../src/channels/reply-reader.js";
import { PiiPolicySet } from "../../src/pii/policy-set.js";
import { Text } from "../../src/dto/index.js";
import { ToolCallApprovalDecisionDto } from "../../src/dto/standard/framework.js";
import { replyWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { PauseRespondent } from "../../src/pause/respondent.js";
import { ToolApproval } from "../../src/channels/pause-targets.js";
import { days } from "../../src/units/index.js";

class WireRequestDto {
  @Text()
  account!: string;
}

/** Decorated, but not as an interpreter. */
@Injectable()
class PlainReader {}

@ChannelInterpreter({
  name: "Wire_Reader",
  description: "Reads wire replies",
  model: "typesafe/jev-1.13",
})
class DecisionModelReader {}

@ChannelInterpreter({
  name: "wire-jev-reply-interpreter",
  description: "Reads whether a wire reply approves it",
  model: "typesafe/jev-1.13",
})
class JevReader {}

@ChannelInterpreter({
  name: "wire-code-reply-interpreter",
  description: "Reads wire replies by code",
})
class MethodlessReader {}

/** A role naming `replyInterpreter`, its use by one tool. */
function useOf(name: string, replyInterpreter: new () => object) {
  @ToolApproval({
    name,
    description: "Approves wires",
    input: WireRequestDto,
    respondent: PauseRespondent.Delegate,
    timeout: days(365),
    channelInterpreter: replyInterpreter,
  })
  class WireToolApproval {}
  return { tool: "wire", toolInput: WireRequestDto, target: WireToolApproval, workflow: "w" };
}

describe("#267 PR 3: reply interpreters at assembly", () => {
  it("every problem at once, each with its code", () => {
    const uses = [
      useOf("plain-approval-channel", PlainReader),
      useOf("decision-account-channel", DecisionModelReader),
      useOf("methodless-approval-channel", MethodlessReader),
    ];

    const found = replyInterpreterViolations(uses).map(({ code, nodes }) => ({ code, nodes }));

    expect(found).toEqual([
      { code: "channel-interpreter.not-an-interpreter", nodes: ["plain-approval-channel"] },
      { code: "name.not-kebab-case", nodes: ["Wire_Reader"] },
      { code: "channel-interpreter.no-interpret-method", nodes: ["wire-code-reply-interpreter"] },
    ]);
  });
});

/** Counts the chat model runs the trace saw. */
class SeenTrace extends BaseCallbackHandler {
  name = "seen-trace";
  readonly starts: string[] = [];

  override handleChatModelStart(): void {
    this.starts.push("chat");
  }
}

describe("#267 S124 a: a decision model reads an approval's yes / no only", () => {
  it("an approval role may name a decision-model interpreter", () => {
    const found = replyInterpreterViolations([useOf("decision-approval-channel", JevReader)]);

    expect(found).toEqual([]);
  });
});

describe("#267 AC8: a model interpreter is a model use of its workflow", () => {
  it("its model resolves to a provider (agboss describe, check --models); a code one has none", async () => {
    const assembled = await applicationOf(TreasuryApplication);
    const [treasury] = assembled.workflows;

    const uses = treasury === undefined ? [] : resolvedModelUsesOf(treasury);

    expect(uses.filter((use) => use.key.startsWith("channelInterpreters."))).toEqual([
      {
        key: "channelInterpreters.payout-reply-interpreter",
        model: "test/payout-reader",
        provider: "test-model-provider",
      },
      {
        key: "channelInterpreters.deposit-reply-interpreter",
        model: "typesafe/jev-1.13",
        provider: "test-decisions-model-provider",
      },
    ]);
  });
});

describe("#267 AC8: a model interpreter's call is traced", () => {
  it("the trace's callbacks see the call; its spend is under its own caller", async () => {
    const book = new ScriptBook();
    book
      .scriptOf("reply-interpreter:wire-reply-interpreter")
      .thenReturn(replyWith(ToolCallApprovalDecisionDto, { approved: true }));
    const trace = new SeenTrace();
    const interpreter = {
      target: "wire-approval-channel",
      interpreter: PlainReader,
      name: "wire-reply-interpreter",
      answer: ToolCallApprovalDecisionDto,
      input: WireRequestDto,
      model: "test/wire-reader",
      instructions: "Read the reply.",
    };
    const settings = { model: "test/wire-reader", temperature: 0, maxTokens: 100 };

    const reading = await readByModel(
      interpreter,
      { ask: { tool: "wire" }, reply: "yes" },
      {
        gateway: createScriptedGateway(book),
        settings,
        callbacks: [trace],
        pii: { policies: new PiiPolicySet([], ""), known: {} },
      },
    );

    expect(reading).toMatchObject({
      kind: "answered",
      answer: { approved: true },
      usage: [{ caller: "reply-interpreter:wire-reply-interpreter", model: "test/wire-reader" }],
    });
    expect(trace.starts).toEqual(["chat"]);
  });
});
