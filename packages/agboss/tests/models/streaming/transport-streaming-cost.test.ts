import { beforeAll, describe, expect, it } from "vitest";
import { StreamEventKind, type ExecutionStreamEvent } from "../../../src/run/types.js";
import { FinishReason } from "../../../src/models/index.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { usd } from "../../../src/units/index.js";
import { ChatStart } from "../../channels/approval.workflow.js";
import { execute } from "../../helpers/flow.js";
import { transportApp } from "../transport/transport-app.js";
import { ScriptedBedrockClient } from "../transport/bedrock-provider.fixture.js";
import {
  ScriptedStreamClient,
  StreamSdkClient,
  streamOf,
  type StreamScript,
} from "./transport-streaming.fixture.js";
import { TransportStreamCostApplication } from "./transport-streaming-cost.fixture.js";

/**
 * #1249: a streamed transport call is accounted as the plain call is. A provider with
 * `ModelCost.fromResponse()` reports the call's cost with its usage at the end of the stream (the
 * plain call's `cost`), and the reason it stopped (`finishReason`); a stream without a cost is
 * a call that cannot be accounted, as `complete()` without one is.
 */

const deltas = (events: readonly ExecutionStreamEvent[]): string[] =>
  events.flatMap((event) => (event.kind === StreamEventKind.TextDelta ? [event.delta] : []));

const reporting =
  (chunks: readonly string[], end: { cost?: number; finishReason?: FinishReason }): StreamScript =>
  () => ({
    textStream: (async function* () {
      await Promise.resolve();
      yield* chunks;
    })(),
    result: Promise.resolve({
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
      ...(end.cost === undefined ? {} : { cost: usd(end.cost) }),
      ...(end.finishReason === undefined ? {} : { finishReason: end.finishReason }),
    }),
  });

async function appOn(scripts: readonly StreamScript[], clock = new VirtualClock()) {
  const client = new ScriptedStreamClient(scripts);
  const app = await transportApp(TransportStreamCostApplication, {
    client: new ScriptedBedrockClient([]),
    clock,
    overrides: new Map([[StreamSdkClient, client]]),
  });
  return { app, client, clock };
}

describe(
  "#1249: a streamed transport call reports its cost and why it stopped",
  { timeout: 30_000 },
  () => {
    beforeAll(async () => {
      const { app } = await appOn([streamOf(["warm"])]);
      await execute(app, ChatStart, { text: "warm" }, { onStream: () => undefined }).catch(
        () => undefined,
      );
      await app.close();
    }, 30_000);

    it("a stream's own cost is the call's cost (api), as complete()'s is", async () => {
      const { app } = await appOn([reporting(["a", "b"], { cost: 0.42 })]);
      const events: ExecutionStreamEvent[] = [];

      const done = await execute(
        app,
        ChatStart,
        { text: "hi" },
        { onStream: (e) => events.push(e) },
      );

      expect(deltas(events)).toEqual(["a", "b"]);
      expect(done.spend.trace).toEqual([
        expect.objectContaining({ costUsd: usd(0.42), costSource: "api", inputTokens: 100 }),
      ]);
      expect(done.spend.totalUsd).toBeCloseTo(0.42, 9);
      await app.close();
    });

    it("a stream that reports no cost under fromResponse() is a call that cannot be accounted: it fails, loudly", async () => {
      const { app } = await appOn([reporting(["a"], {})]);

      const run = execute(app, ChatStart, { text: "hi" }, { onStream: () => undefined });

      await expect(run).rejects.toThrow(/reported no cost/u);
      await app.close();
    });
  },
);
