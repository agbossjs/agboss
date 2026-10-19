/**
 * #267 PR 3: reply interpreters are checked at assembly, all problems at once —
 * `[reply-interpreter.not-an-interpreter]` (a `replyInterpreter` without `@ReplyInterpreter`),
 * `[name.kind-suffix]` (`-reply-interpreter`), `[reply-interpreter.decision-model]` (a decision
 * model cannot give a typed answer), `[reply-interpreter.no-interpret-method]` (a code one without
 * `interpret`). A model interpreter's call is traced under the pause's execution: the trace's
 * callbacks see it.
 */
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { resolvedModelUsesOf } from "../../src/models/resolution.js";
import { TreasuryApplication } from "../flow/fixtures/replies.fixture.js";
import { ChannelOf } from "../../src/channels/channel-handler.js";
import { ChannelRole, PauseAnswerer } from "../../src/channels/channel-role.decorator.js";
import { ReplyInterpreter } from "../../src/channels/reply-interpreter.js";
import { Injectable } from "../../src/components/decorators.js";
import { replyInterpreterViolations } from "../../src/channels/reply-interpreters.js";
import { readByModel } from "../../src/channels/reply-reader.js";
import { Text } from "../../src/dto/index.js";
import { ToolCallApprovalDecisionDto } from "../../src/dto/standard/framework.js";
import { DecidedBy } from "../../src/flow/decorators/router.js";
import { replyWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";

class WireRequestDto {
  @Text()
  account!: string;
}

/** Decorated, but not as an interpreter. */
@Injectable()
class PlainReader {}

@ReplyInterpreter({
  name: "wire-reader",
  description: "Reads wire replies",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-1.13",
})
class DecisionModelReader {}

@ReplyInterpreter({
  name: "wire-code-reply-interpreter",
  description: "Reads wire replies by code",
  decidedBy: DecidedBy.Code,
})
class MethodlessReader {}

/** A role naming `replyInterpreter`, its use by one tool. */
function useOf(name: string, replyInterpreter: new () => object) {
  @ChannelRole({
    name,
    description: "Approves wires",
    approves: WireRequestDto,
    answeredBy: PauseAnswerer.Channel,
    replyInterpreter,
  })
  abstract class WireApprovalChannel extends ChannelOf<WireApprovalChannel> {}
  return { tool: "wire", toolInput: WireRequestDto, channel: WireApprovalChannel, workflow: "w" };
}

describe("#267 PR 3: reply interpreters at assembly", () => {
  it("every problem at once, each with its code", () => {
    const uses = [
      useOf("plain-approval-channel", PlainReader),
      useOf("decision-approval-channel", DecisionModelReader),
      useOf("methodless-approval-channel", MethodlessReader),
    ];

    const found = replyInterpreterViolations(uses).map(({ code, nodes }) => ({ code, nodes }));

    expect(found).toEqual([
      { code: "reply-interpreter.not-an-interpreter", nodes: ["plain-approval-channel"] },
      { code: "name.kind-suffix", nodes: ["wire-reader"] },
      { code: "reply-interpreter.decision-model", nodes: ["wire-reader"] },
      { code: "reply-interpreter.no-interpret-method", nodes: ["wire-code-reply-interpreter"] },
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

describe("#267 AC8: a model interpreter is a model use of its workflow", () => {
  it("its model resolves to a provider (agboss describe, check --models); a code one has none", async () => {
    const assembled = await applicationOf(TreasuryApplication);
    const [treasury] = assembled.workflows;

    const uses = treasury === undefined ? [] : resolvedModelUsesOf(treasury);

    expect(uses.filter((use) => use.key.startsWith("replyInterpreters."))).toEqual([
      {
        key: "replyInterpreters.payout-reply-interpreter",
        model: "test/payout-reader",
        provider: "openrouter-model-provider",
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
      channel: "wire-approval-channel",
      interpreter: PlainReader,
      name: "wire-reply-interpreter",
      answer: ToolCallApprovalDecisionDto,
      model: "test/wire-reader",
      instructions: "Read the reply.",
    };
    const settings = { model: "test/wire-reader", temperature: 0, maxTokens: 100 };

    const reading = await readByModel(
      interpreter,
      { ask: { tool: "wire" }, reply: "yes" },
      { gateway: createScriptedGateway(book), settings, callbacks: [trace] },
    );

    expect(reading).toMatchObject({
      kind: "answered",
      answer: { approved: true },
      usage: [{ caller: "reply-interpreter:wire-reply-interpreter", model: "test/wire-reader" }],
    });
    expect(trace.starts).toEqual(["chat"]);
  });
});
