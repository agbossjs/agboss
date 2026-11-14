import { describe, expect, it } from "vitest";
import {
  EventStreamError,
  guardedEventStream,
  type StreamEnd,
} from "../../../src/models/calls/event-stream-guard.js";
import { ModelFailure } from "../../../src/models/model-failure.js";

const encoder = new TextEncoder();
const frame = (event: unknown): string =>
  `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`;
const delta = (content: string, extra: Record<string, unknown> = {}): unknown => ({
  choices: [{ index: 0, delta: { content }, finish_reason: null }],
  ...extra,
});
const finish = { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };

/** A body that gives `parts` one by one, then ends — or fails with `failure`. */
function bodyOf(parts: readonly string[], failure?: Error): Response {
  const queue = [...parts];
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue.shift();
      if (next !== undefined) controller.enqueue(encoder.encode(next));
      else if (failure !== undefined) controller.error(failure);
      else controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** The guard over `parts`: the response, and every end it told. */
async function guarded(
  parts: readonly string[],
  options: { failure?: Error; aborted?: boolean } = {},
) {
  const ends: StreamEnd[] = [];
  const guard = await guardedEventStream(bodyOf(parts, options.failure), {
    settle: (end) => {
      ends.push(end);
      return Promise.resolve();
    },
    aborted: () => options.aborted === true,
  });
  return { guard, ends };
}

const textOf = (response: Response): Promise<string> => response.text();

describe("#1005: the guard", () => {
  it("passes a complete stream through untouched and tells its end once: completed", async () => {
    const parts = [frame(delta("a")), frame(delta("b")), frame(finish), frame("[DONE]")];
    const { guard, ends } = await guarded(parts);

    expect(guard.watched).toBe(true);
    expect(guard.failure).toBeUndefined();
    expect(await textOf(guard.response)).toBe(parts.join(""));
    expect(ends).toEqual(["completed"]);
  });

  it("a stream that ends without [DONE] or a finish fails: the body errors, failed is told once", async () => {
    const { guard, ends } = await guarded([frame(delta("a")), frame(delta("b"))]);

    await expect(textOf(guard.response)).rejects.toThrow(EventStreamError);
    expect(ends).toEqual(["failed"]);
  });

  it("a body that breaks after content fails; the caller's own abort is ignored", async () => {
    const broken = await guarded([frame(delta("a"))], { failure: new Error("reset") });
    const aborted = await guarded([frame(delta("a"))], {
      failure: new Error("abort"),
      aborted: true,
    });

    await expect(textOf(broken.guard.response)).rejects.toThrow("reset");
    await expect(textOf(aborted.guard.response)).rejects.toThrow("abort");
    expect(broken.ends).toEqual(["failed"]);
    expect(aborted.ends).toEqual(["ignored"]);
  });

  it("an {error} after content is told failed before the client reads it; a client error is ignored", async () => {
    const server = await guarded([
      frame(delta("a")),
      frame({ error: { code: 502, message: "bad" } }),
    ]);
    const client = await guarded([
      frame(delta("a")),
      frame({ error: { code: 400, message: "bad" } }),
    ]);

    await textOf(server.guard.response).catch(() => undefined);
    await textOf(client.guard.response).catch(() => undefined);

    expect(server.ends).toEqual(["failed"]);
    expect(client.ends).toEqual(["ignored"]);
  });

  it("an {error} before any content is a failed attempt: unwatched, replayed, its failure named", async () => {
    const event = frame({ error: { code: 429, message: "slow down" } });
    const { guard, ends } = await guarded([event]);

    expect(guard.failure).toBe(ModelFailure.RateLimited);
    expect(guard.watched).toBe(false);
    expect(await textOf(guard.response)).toBe(event);
    expect(ends).toEqual([]);
  });

  it("an end before any content throws: the attempt is a network failure", async () => {
    await expect(guarded([": only a comment\n\n"])).rejects.toThrow(EventStreamError);
    await expect(guarded([])).rejects.toThrow("before any content");
  });

  it("a body that breaks before any content throws what it broke with", async () => {
    await expect(guarded([], { failure: new Error("reset") })).rejects.toThrow("reset");
  });

  it("a response with no body is nothing to guard", async () => {
    const response = new Response(null, { headers: { "content-type": "text/event-stream" } });
    const guard = await guardedEventStream(response, {
      settle: () => Promise.resolve(),
      aborted: () => false,
    });

    expect(guard).toEqual({ response, watched: false });
  });

  it("a consumer that cancels a stream that had ended well is completed; before its end, ignored", async () => {
    const complete = await guarded([frame(delta("a")), frame(finish)]);
    const early = await guarded([frame(delta("a")), frame(delta("b"))]);

    const reader = complete.guard.response.body?.getReader();
    await reader?.read();
    await reader?.read();
    await reader?.cancel();
    await early.guard.response.body?.cancel();

    expect(complete.ends).toEqual(["completed"]);
    expect(early.ends).toEqual(["ignored"]);
  });

  it("a stream with no decision for a megabyte is passed on as it is", async () => {
    const comment = `: ${"x".repeat(1_048_576)}\n\n`;
    const { guard } = await guarded([comment, frame(delta("a")), frame(finish)]);

    expect(guard.watched).toBe(true);
    expect(await textOf(guard.response)).toBe(comment + frame(delta("a")) + frame(finish));
  });
});
