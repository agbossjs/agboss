import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ExecutionStreamEvent } from "../../../src/run/types.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { ChatStart } from "../../channels/approval.workflow.js";
import { execute } from "../../helpers/flow.js";
import { ScriptedBedrockClient } from "../transport/bedrock-provider.fixture.js";
import { advanceUntilSettled, transportApp } from "../transport/transport-app.js";
import { StreamApplication } from "./http-streaming.fixture.js";
import {
  Gate,
  chunk,
  sseEvents,
  sseServer,
  streamOf,
  type SseScript,
  type SseServer,
} from "./sse-server.js";

const servers: SseServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const deltas = (events: readonly ExecutionStreamEvent[]): string =>
  events.flatMap((event) => (event.kind === "textDelta" ? [event.delta] : [])).join("");

const afterHello: SseScript["steps"] = [sseEvents(chunk({ content: "Hel" }))];
const providerError = (code: unknown): unknown => ({ error: { code, message: "provider failed" } });

/** The primary's and the backup's servers, `send` choosing by the provider's host. */
async function servers2(
  primary: readonly SseScript[],
  backup: readonly SseScript[] = [streamOf(["backup"])],
) {
  const first = await sseServer(primary);
  const second = await sseServer(backup);
  servers.push(first, second);
  const send: SseServer["send"] = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return (url.includes("backup-1005") ? second : first).send(input, init);
  };
  return { primary: first, backup: second, send };
}

describe(
  "#1005 AC2: a failed stream is retried before its text, counted after it, never a success",
  {
    timeout: 20_000,
  },
  () => {
    // the modules a first execution loads lazily, loaded before any clock moves (#604)
    beforeAll(async () => {
      const warm = await sseServer([streamOf(["warm"])]);
      const app = await transportApp(StreamApplication, {
        client: new ScriptedBedrockClient([]),
        send: warm.send,
      });
      await execute(app, ChatStart, { text: "warm" }, { onStream: () => undefined });
      await app.close();
      await warm.close();
    }, 20_000);

    it.each([
      [
        "a cut before any content",
        [sseEvents(chunk({ role: "assistant", content: "" })), { kind: "cut" }],
      ],
      ["an end before any content", [{ kind: "end" }]],
      ["an {error} 502 first", [sseEvents(providerError(502))]],
      ["an {error} 429 first (the provider's queue pauses)", [sseEvents(providerError(429))]],
      ["an {error} server_error first", [sseEvents(providerError("server_error"))]],
    ] as const)("%s: the attempt is retried, and the second one answers", async (_name, steps) => {
      const { primary, send } = await servers2([{ steps }, streamOf(["ok"])]);
      const clock = new VirtualClock();
      const app = await transportApp(StreamApplication, {
        client: new ScriptedBedrockClient([]),
        send,
        clock,
      });
      const events: ExecutionStreamEvent[] = [];

      const done = await advanceUntilSettled(
        clock,
        execute(app, ChatStart, { text: "hi" }, { onStream: (event) => events.push(event) }),
      );

      expect(primary.requests).toHaveLength(2);
      expect(deltas(events)).toBe("ok"); // nothing of the failed attempt went out
      expect(done.output).toEqual({ text: "ok" });
      expect(done.spend.trace).toHaveLength(1); // one call, paid once
      await app.close();
    });

    it("an {error} that is the client's (400) is not retried and not the provider's failure", async () => {
      const { primary, send } = await servers2([{ steps: [sseEvents(providerError(400))] }]);
      const app = await transportApp(StreamApplication, {
        client: new ScriptedBedrockClient([]),
        send,
      });

      await expect(
        execute(app, ChatStart, { text: "hi" }, { onStream: () => undefined }),
      ).rejects.toThrow();
      await expect(
        execute(app, ChatStart, { text: "hi" }, { onStream: () => undefined }),
      ).rejects.toThrow();
      await expect(
        execute(app, ChatStart, { text: "hi" }, { onStream: () => undefined }),
      ).rejects.toThrow();

      expect(primary.requests).toHaveLength(3); // no retry, and the breaker stays closed
      await app.close();
    });

    it.each([
      ["a cut", [{ kind: "cut" }]],
      ["a clean end without [DONE] or a finish", [{ kind: "end" }]],
      ["an {error} inside the 200", [sseEvents(providerError(502))]],
    ] as const)(
      "after text, %s fails the call, is not retried, and counts in the breaker",
      async (_name, tail) => {
        const { primary, backup, send } = await servers2([{ steps: [...afterHello, ...tail] }]);
        const app = await transportApp(StreamApplication, {
          client: new ScriptedBedrockClient([]),
          send,
        });
        const events: ExecutionStreamEvent[] = [];
        const run = () =>
          execute(app, ChatStart, { text: "hi" }, { onStream: (event) => events.push(event) });

        await expect(run()).rejects.toThrow();
        // the second failed stream is the threshold's (2): its breaker opens, the backup answers
        const second = await run();

        expect(primary.requests).toHaveLength(2); // never retried
        expect(backup.requests).toHaveLength(1);
        expect(second.output).toEqual({ text: "backup" });
        expect(deltas(events)).toBe("HelHelbackup");
        await app.close();
      },
    );

    it("a caller's abort mid-stream is neither a success nor a failure of the provider", async () => {
      const { primary, send } = await servers2([
        { steps: [...afterHello, { kind: "wait", gate: new Gate() }] },
      ]);
      const app = await transportApp(StreamApplication, {
        client: new ScriptedBedrockClient([]),
        send,
      });
      const abort = async (): Promise<void> => {
        const controller = new AbortController();
        const run = execute(
          app,
          ChatStart,
          { text: "hi" },
          {
            signal: controller.signal,
            onStream: () => {
              controller.abort();
            },
          },
        );
        await expect(run).rejects.toThrow();
      };

      await abort();
      await abort();
      await abort();

      expect(primary.requests).toHaveLength(3); // three aborts did not open the breaker (threshold 2)
      await app.close();
    });
  },
);
