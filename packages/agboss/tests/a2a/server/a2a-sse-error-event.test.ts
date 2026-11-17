/**
 * #1232 follow-up: the SSE error event is written as bytes too. Node 24 stops emitting `drain` once a
 * few non-ASCII *string* writes met a reader that pushes back (pure Node: the 152nd of 200 events of
 * 2000 "é"), and the error event of `sendEvents` was the one write that was a string again, with no
 * test to notice. Over a real socket on 127.0.0.1 a reader that pushes back (its socket paused) is
 * sent a long non-ASCII error event, then reads: all of it arrives and the stream ends. A single
 * string write does not stall Node 24 (measured: 1 to 10 writes of up to 30 000 letters arrive), so
 * what turns red when the event is a string is the type of what reaches `res.write`.
 */
import type { ServerResponse } from "node:http";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { invalidParams } from "../../../src/a2a/server/a2a-wire-errors.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { sseClient, sseServer, type SseServer } from "./support/sse-socket.js";

const FRAMES = 200;
const LETTERS = 32 * 1024;

/** What `res.write` was handed, by type, from the moment the handler fails. */
const handed: string[] = [];

/** `frames` events of 2000 "é", then the failure a handler threw: its answer is an error event of `LETTERS` "é". */
async function* failingAfter(
  frames: number,
  response: () => ServerResponse | undefined,
): AsyncGenerator {
  for (let index = 0; index < frames; index += 1) {
    yield await Promise.resolve({ kind: "status-update", note: "é".repeat(2000) });
  }
  const res = response();
  if (res !== undefined) {
    const write = res.write.bind(res) as (chunk: unknown, ...rest: unknown[]) => boolean;
    vi.spyOn(res, "write").mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      handed.push(
        typeof chunk === "string" ? "string" : Object.getPrototypeOf(chunk).constructor.name,
      );
      return write(chunk, ...rest);
    }) as typeof res.write);
  }
  throw invalidParams("a2a.test-long", "é".repeat(LETTERS));
}

async function served(frames: number) {
  handed.length = 0;
  const current: { server?: SseServer } = {};
  const server = await sseServer(
    () => failingAfter(frames, () => current.server?.response()),
    new VirtualClock(),
  );
  current.server = server;
  const client = await sseClient(server.port);
  const arrived: Buffer[] = [];
  client.on("data", (chunk: Buffer) => {
    arrived.push(chunk);
  });
  return { server, client, arrived };
}

describe("#1232: the SSE error event is written as bytes", () => {
  it("a long non-ASCII error event reaches a reader that pushed back and then reads, and the stream ends", async () => {
    const { server, client, arrived } = await served(FRAMES);
    client.pause(); // the reader pushes back while the server writes
    await nextTurn();
    await nextTurn();
    const ended = new Promise<void>((resolve) => client.once("end", resolve));

    client.resume(); // now it reads at full speed
    await server.answered();
    await ended;

    const text = Buffer.concat(arrived).toString("utf8");
    expect(text.split("é").length - 1).toBe(FRAMES * 2000 + LETTERS); // every letter of every frame and of the error
    expect(text).toContain('"code":-32602');
    expect(client.complete).toBe(true); // a clean close of the chunked body, not a reset
    await server.close();
  }, 30_000);

  it("the error event is handed to `res.write` as bytes, never a string", async () => {
    const { server, client, arrived } = await served(1); // the first event decides: an error before it is one JSON answer
    const ended = new Promise<void>((resolve) => client.once("end", resolve));

    await server.answered();
    await ended;

    expect(Buffer.concat(arrived).toString("utf8").split("é").length - 1).toBe(2000 + LETTERS);
    expect(handed).toEqual(["Buffer"]); // one write: the error event
    await server.close();
  });
});
