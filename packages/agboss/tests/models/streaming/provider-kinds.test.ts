import { afterEach, describe, expect, it } from "vitest";
import { replyWith, testWith } from "../../../src/testing/index.js";
import type { ExecutionStreamEvent } from "../../../src/run/types.js";
import { ChatStart } from "../../channels/approval.workflow.js";
import { execute } from "../../helpers/flow.js";
import { BEDROCK_DESK, BedrockApplication } from "../transport/bedrock-apps.fixture.js";
import { answer, ScriptedBedrockClient } from "../transport/bedrock-provider.fixture.js";
import { transportApp } from "../transport/transport-app.js";
import { StreamApplication } from "./http-streaming.fixture.js";
import { sseServer, streamOf, type SseServer } from "./sse-server.js";

/** #1005 AC6: what streams per provider kind — a text answer is never zero deltas. */

const deltas = (events: readonly ExecutionStreamEvent[]): string[] =>
  events.flatMap((event) => (event.kind === "textDelta" ? [event.delta] : []));

const servers: SseServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("AC6: zero deltas never happens for a text answer, on any provider kind", () => {
  it("an HTTP provider streams its tokens as they come", async () => {
    const server = await sseServer([streamOf(["a", "b", "c"])]);
    servers.push(server);
    const app = await transportApp(StreamApplication, {
      client: new ScriptedBedrockClient([]),
      send: server.send,
    });
    const events: ExecutionStreamEvent[] = [];

    await execute(app, ChatStart, { text: "hi" }, { onStream: (event) => events.push(event) });

    expect(deltas(events)).toEqual(["a", "b", "c"]);
    await app.close();
  });

  it("a transport provider streams the whole answer as one delta at the end", async () => {
    const client = new ScriptedBedrockClient([answer("The whole answer.")]);
    const app = await transportApp(BedrockApplication, { client });
    const events: ExecutionStreamEvent[] = [];

    await execute(app, ChatStart, { text: "hi" }, { onStream: (event) => events.push(event) });

    expect(deltas(events)).toEqual(["The whole answer."]);
    await app.close();
  });

  const scripted = testWith(BedrockApplication);

  scripted(
    "a scripted model (testWith) streams the whole answer as one delta",
    async ({ app, mockLlm }) => {
      mockLlm(BEDROCK_DESK.textAgent).thenReturn(replyWith("Scripted."));
      const events: ExecutionStreamEvent[] = [];

      await execute(app, ChatStart, { text: "hi" }, { onStream: (event) => events.push(event) });

      expect(deltas(events)).toEqual(["Scripted."]);
    },
  );
});
