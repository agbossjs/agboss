/**
 * #1328 / #1311: `streamWith` and `failStreamAfter` script a model's stream — a streaming call
 * hears the chunks, a call that does not stream gets the joined text or the failure.
 */
import { describe, expect, it } from "vitest";
import {
  StreamDiscardReason,
  StreamEventKind,
  type ExecutionStreamEvent,
} from "../../src/run/types.js";
import {
  ModelFailure,
  failStreamAfter,
  failWith,
  replyWith,
  streamWith,
  testWith,
} from "../../src/testing/index.js";
import { usd } from "../../src/units/index.js";
import { ModelCallFailedError } from "../../src/testing/script.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import type { ScriptedTurn } from "../../src/testing/turns.js";
import { ScriptedChatModel } from "../../src/testing/scripted-chat-model.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { AskStart, Desk, RemoteDeskApplication } from "../a2a/fixtures/remote.workflow.js";
import { execute } from "../helpers/flow.js";

const desk = testWith(RemoteDeskApplication);

const deltas = (events: readonly ExecutionStreamEvent[]): string[] =>
  events.flatMap((event) => (event.kind === StreamEventKind.TextDelta ? [event.delta] : []));

describe("#1328: streamWith", () => {
  desk(
    "a streaming run hears each chunk, and the answer is the chunks joined",
    async ({ app, mockModel }) => {
      mockModel(Desk).thenReturn(streamWith(["Order", " 7", "", " shipped."]));
      const events: ExecutionStreamEvent[] = [];

      const done = await execute(
        app,
        AskStart,
        { text: "where is order 7?" },
        { onStream: (event) => events.push(event) },
      );

      expect(deltas(events)).toEqual(["Order", " 7", " shipped."]);
      expect(done.output).toMatchObject({ text: "Order 7 shipped." });
    },
  );

  desk(
    "a run that does not stream gets the same answer as replyWith",
    async ({ app, mockModel }) => {
      mockModel(Desk).thenReturn(streamWith(["Order ", "7 shipped."], { cost: usd(0.002) }));

      const done = await execute(app, AskStart, { text: "where is order 7?" });

      expect(done.output).toMatchObject({ text: "Order 7 shipped." });
      expect(done.spend.totalUsd).toBeGreaterThan(0);
    },
  );
});

describe("#1328: failStreamAfter", () => {
  desk(
    "the chunks are heard, then the stream's text is discarded as broken and the run fails",
    async ({ app, mockModel }) => {
      mockModel(Desk).thenReturn(failStreamAfter(["Order"], ModelFailure.Timeout));
      const events: ExecutionStreamEvent[] = [];

      await expect(
        execute(app, AskStart, { text: "q" }, { onStream: (event) => events.push(event) }),
      ).rejects.toThrow();

      expect(deltas(events)).toEqual(["Order"]);
      expect(events.at(-1)).toMatchObject({
        kind: StreamEventKind.Discarded,
        reason: StreamDiscardReason.StreamBroken,
      });
    },
  );
});

describe("#1328: a scripted chat model read without streaming", () => {
  const modelOf = (turns: readonly ScriptedTurn[]) => {
    const book = new ScriptBook();
    book.scriptOf("agent:x").thenReturn(...turns);
    const settings = { model: "local/x", temperature: 0, maxTokens: 100 };
    return new ScriptedChatModel({ book, clock: new VirtualClock(), key: "agent:x" }, settings);
  };

  it("streamWith answers the joined text", async () => {
    const answer = await modelOf([streamWith(["a", "b"])]).invoke("hi");
    expect(answer.content).toBe("ab");
  });

  it("failStreamAfter fails at once, the chunks unheard", async () => {
    await expect(
      modelOf([failStreamAfter(["a"], ModelFailure.Timeout)]).invoke("hi"),
    ).rejects.toBeInstanceOf(ModelCallFailedError);
  });

  it("a stream of the model gives the chunks one by one, the cost in the last", async () => {
    const model = modelOf([streamWith(["a", "b"], { cost: usd(0.5) })]);
    const parts: unknown[] = [];
    for await (const part of await model.stream("hi")) parts.push(part.content);
    expect(parts).toEqual(["a", "b", ""]);
  });
});
