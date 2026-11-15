/**
 * #1122: a held agent (output guardrail, PII block rule — agent-level or application-wide) on an
 * HTTP provider streams its answer to the holding buffer and releases it once its checks passed:
 * the answer reaches `onStream` (never zero deltas), a refused one never does. A real 127.0.0.1
 * server answers; the scripted test models cannot prove it (they emit tokens for plain calls).
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionStreamEvent } from "../../src/run/types.js";
import { ChatStart } from "../channels/approval.workflow.js";
import { execute } from "../helpers/flow.js";
import { answer, ScriptedBedrockClient } from "../models/transport/bedrock-provider.fixture.js";
import { transportApp } from "../models/transport/transport-app.js";
import {
  chunk,
  plainOf,
  sseEvents,
  sseServer,
  streamOf,
  type SseServer,
} from "../models/streaming/sse-server.js";
import { HELD_KINDS, heldApplication } from "./held-http.fixture.js";

const servers: SseServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const guardrailAlone = HELD_KINDS.find((kind) => kind.agent.guardrails !== undefined);
if (guardrailAlone === undefined) throw new Error("no guardrail-alone variant");

const deltas = (events: readonly ExecutionStreamEvent[]): string =>
  events.flatMap((event) => (event.kind === "textDelta" ? [event.delta] : [])).join("");

describe.each(HELD_KINDS.map((kind, index) => [kind.name, kind, index] as const))(
  "#1122: a held agent with %s on an HTTP provider",
  (_name, kind, index) => {
    it("AC1+AC3: a passing answer streams after the checks, its deltas joined are the output", async () => {
      const server = await sseServer([streamOf(["The ", "answer", "."])], plainOf("The answer."));
      servers.push(server);
      const app = await transportApp(heldApplication(kind, index), {
        client: new ScriptedBedrockClient([]),
        send: server.send,
      });
      const events: ExecutionStreamEvent[] = [];

      const done = await execute(
        app,
        ChatStart,
        { text: "q" },
        { onStream: (event) => events.push(event) },
      );

      expect(done.output).toEqual({ text: "The answer." });
      expect(deltas(events)).toBe("The answer.");
      expect(server.requests.map((request) => request.body.stream)).toEqual([true]); // the wire is SSE (#1122: decided)
      expect(events.filter((event) => event.kind === "textDelta").length).toBeGreaterThan(0);
      expect(events.some((event) => event.kind === "discarded")).toBe(false);
      await app.close();
    });

    it("AC3: a refused answer streams nothing and the run fails", async () => {
      const bad =
        kind.agent.guardrails === undefined
          ? ["Card ", "4111 1111 ", "1111 1111", "."]
          : ["The FORB", "IDDEN", " word"];
      const server = await sseServer([streamOf(bad)]);
      servers.push(server);
      const app = await transportApp(heldApplication(kind, index), {
        client: new ScriptedBedrockClient([]),
        send: server.send,
      });
      const events: ExecutionStreamEvent[] = [];

      await expect(
        execute(app, ChatStart, { text: "q" }, { onStream: (event) => events.push(event) }),
      ).rejects.toThrow();

      expect(deltas(events)).toBe("");
      await app.close();
    });
  },
);

describe("#1122 AC2: a held agent through a fallback", () => {
  it("a primary cut mid-answer: nothing of its text went out, the backup's answer streams after the check", async () => {
    const primary = await sseServer([
      { steps: [sseEvents(chunk({ content: "Hel" })), { kind: "cut" }] },
    ]);
    const backup = await sseServer([streamOf(["from", " backup"])]);
    servers.push(primary, backup);
    const send: SseServer["send"] = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return (url.includes("backup-1005") ? backup : primary).send(input, init);
    };
    const app = await transportApp(heldApplication(guardrailAlone, 0), {
      client: new ScriptedBedrockClient([]),
      send,
    });
    await expect(
      execute(app, ChatStart, { text: "one" }, { onStream: () => undefined }),
    ).rejects.toThrow();
    const events: ExecutionStreamEvent[] = [];

    const done = await execute(
      app,
      ChatStart,
      { text: "two" },
      { onStream: (event) => events.push(event) },
    );

    expect(done.output).toEqual({ text: "from backup" });
    expect(deltas(events)).toBe("from backup");
    expect(events.some((event) => event.kind === "discarded")).toBe(false);
    await app.close();
  });
});

describe("#1122 AC2: a held agent on a transport provider", () => {
  it.each(HELD_KINDS.map((kind, index) => [kind.name, kind, index] as const))(
    "with %s: the answer streams after the checks",
    async (_name, kind, index) => {
      const app = await transportApp(heldApplication(kind, index, "transport"), {
        client: new ScriptedBedrockClient([answer("The answer.")]),
      });
      const events: ExecutionStreamEvent[] = [];

      const done = await execute(
        app,
        ChatStart,
        { text: "q" },
        { onStream: (event) => events.push(event) },
      );

      expect(done.output).toEqual({ text: "The answer." });
      expect(deltas(events)).toBe("The answer.");
      await app.close();
    },
  );
});
