/**
 * #1008 AC1: a reader that stops reading never makes the server buffer without bound and never
 * slows the run. Over a real socket on 127.0.0.1 a client pauses its response while the run streams
 * 20 MB of text: what the server holds stays small, the run finishes at once, the subscriber is
 * dropped at its bound and ended cleanly; `drain` is awaited; a reader that never drains is cut on
 * the application's clock; a hang-up mid-stream cancels nothing.
 */
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { StreamEnd, taskStream } from "../../../src/a2a/server/a2a-stream.js";
import { SSE_DRAIN_TIMEOUT, writeSse } from "../../../src/a2a/server/a2a-sse-write.js";
import { SUBSCRIBER_MAX_BYTES } from "../../../src/a2a/server/a2a-subscriber-queue.js";
import { LocalRuns } from "../../../src/a2a/server/a2a-local-runs.js";
import { InMemoryA2ATaskRepository } from "../../../src/infrastructure/in-memory-a2a-task.repository.js";
import { InMemoryDatabase } from "../../../src/infrastructure/in-memory-database.js";
import type { StreamStep } from "../../../src/run/types.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { savedTask, scriptOf, unitParts, WORKING } from "./support/unit-parts.js";
import { sseClient, sseServer } from "./support/sse-socket.js";

const STEP: StreamStep = { agent: "desk-agent", visit: 1, branch: "execution-1", attempt: 1 };
const CHUNK = "x".repeat(256 * 1024);
const CHUNKS = 400;

async function streamed() {
  const tasks = new InMemoryA2ATaskRepository(new InMemoryDatabase());
  const task = await savedTask(tasks, { skill: "unit-workflow-start" }, WORKING);
  const script = scriptOf();
  const runs = new LocalRuns();
  const parts = unitParts(script, tasks, { runs });
  const clock = new VirtualClock();
  const events = (signal: AbortSignal) =>
    taskStream(parts, task, { end: StreamEnd.Terminal, signal });
  const server = await sseServer(events, clock);
  return { task, script, runs, clock, server };
}

describe("#1008 AC1: a slow reader", () => {
  it("memory stays bounded, the run is never slowed, the subscriber ends cleanly at its bound", async () => {
    const { task, script, runs, server } = await streamed();
    let finish = (): void => undefined;
    let emit: Parameters<Parameters<LocalRuns["start"]>[1]>[0] = () => undefined;
    const settled = runs.start(task, (onStream) => {
      emit = onStream;
      return new Promise<void>((resolve) => (finish = resolve));
    });
    const client = await sseClient(server.port);
    client.pause();
    await nextTurn();
    let heldMost = 0;
    for (let index = 0; index < CHUNKS; index += 1) {
      emit({ kind: "textDelta", delta: CHUNK, step: STEP });
      await nextTurn();
      heldMost = Math.max(heldMost, server.response()?.writableLength ?? 0);
    }
    finish();
    await settled; // the run ended although nobody read: it never waited for the reader

    expect(heldMost).toBeLessThan(1024 * 1024);
    let received = 0;
    client.on("data", (chunk: Buffer) => {
      received += chunk.length;
    });
    const ended = new Promise<void>((resolve) => client.once("end", resolve));
    client.resume();
    await ended;
    await server.answered();

    // the pile-up of the paused reader was bounded in the subscriber's own queue, then dropped
    const dropped = script.warnings.filter((line) => line.startsWith("stream.subscriber-dropped"));
    expect(dropped).toHaveLength(1);
    expect(script.warnings.join("")).not.toContain("xxxx");
    expect(client.complete).toBe(true); // a clean close of the chunked body, not a reset
    expect(received).toBeLessThan(CHUNKS * CHUNK.length);
    expect(received).toBeGreaterThan(0);
    expect(SUBSCRIBER_MAX_BYTES).toBe(1024 * 1024);
    await server.close();
  });

  it("a hang-up mid-stream ends the writer and its listener, and the run goes on to its end", async () => {
    const { task, runs, server } = await streamed();
    let finish = (): void => undefined;
    let isRunning = true;
    const settled = runs.start(task, () => new Promise<void>((resolve) => (finish = resolve)));
    void settled.then(() => {
      isRunning = false;
    });
    const client = await sseClient(server.port);
    await nextTurn();

    client.destroy();
    await server.answered();
    await nextTurn();

    expect(isRunning).toBe(true); // the hang-up cancelled nothing
    finish();
    await settled;
    expect(isRunning).toBe(false);
    await server.close();
  });
});

describe("#1008: drain", () => {
  it("a write the socket did not take waits for drain, and is released when the reader reads", async () => {
    const { server } = await streamed();
    const client = await sseClient(server.port);
    client.pause();
    const res = server.response();
    if (res === undefined) throw new Error("no response");
    let isSettled = false;

    const written = writeSse(res, "x".repeat(32 * 1024 * 1024), new VirtualClock()).then((ok) => {
      isSettled = true;
      return ok;
    });
    await nextTurn();
    await nextTurn();
    expect(isSettled).toBe(false);

    client.resume();
    expect(await written).toBe(true);
    client.destroy();
    await server.close();
  });

  it("a reader that never drains is cut after the drain timeout on the app's clock", async () => {
    const { server, clock } = await streamed();
    const client = await sseClient(server.port);
    client.pause();
    const res = server.response();
    if (res === undefined) throw new Error("no response");

    const written = writeSse(res, "x".repeat(32 * 1024 * 1024), clock);
    await nextTurn();
    await clock.advance(SSE_DRAIN_TIMEOUT);

    expect(await written).toBe(false);
    expect(res.destroyed).toBe(true);
    client.destroy();
    await server.close();
  });
});
