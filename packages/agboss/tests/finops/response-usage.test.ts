/**
 * #1356 — the real usage of a call, read from the tail of its streamed answer (#266): `total_tokens`,
 * else prompt + completion, the last report of the body; released once when the body ends, and as 0
 * when it fails or the caller cancels it.
 */
import { describe, expect, it, vi } from "vitest";
import { releasedAtBodyEnd, tokensIn } from "../../src/models/calls/response-usage.js";

describe("#1356: the tokens a body reports", () => {
  it("is the total, the last one when the body names several", () => {
    expect(tokensIn('{"usage":{"total_tokens":42}}')).toBe(42);
    expect(tokensIn('{"total_tokens": 1}\n{"total_tokens":\t9}')).toBe(9);
  });

  it("is prompt + completion when there is no total, each the last one", () => {
    expect(tokensIn('{"usage":{"prompt_tokens":30,"completion_tokens":12}}')).toBe(42);
    expect(
      tokensIn('"prompt_tokens":1 "prompt_tokens":30 "completion_tokens":2 "completion_tokens":12'),
    ).toBe(42);
  });

  it("counts the one of prompt and completion that is there, and 0 for none", () => {
    expect(tokensIn('{"prompt_tokens":30}')).toBe(30);
    expect(tokensIn('{"completion_tokens":12}')).toBe(12);
    expect(tokensIn("no usage here")).toBe(0);
    expect(tokensIn("")).toBe(0);
  });

  it("a total of 0 is a total", () => {
    expect(tokensIn('{"total_tokens":0,"prompt_tokens":30,"completion_tokens":12}')).toBe(0);
  });

  it("reads a field by its whole name, with a number after its colon", () => {
    expect(tokensIn('{"x_total_tokens":5}')).toBe(0);
    expect(tokensIn('{"total_tokens":"7"}')).toBe(0);
    expect(tokensIn('{"total_tokens":-7}')).toBe(0);
    expect(tokensIn('{"total_tokens"  :   7}')).toBe(7);
  });
});

const bodyOf = (...chunks: string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  let next = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[next++];
      if (chunk === undefined) controller.close();
      else controller.enqueue(encoder.encode(chunk));
    },
  });
};

describe("#1356: the usage released at the end of the body", () => {
  it("passes the body through unchanged, and releases the tokens it reported once it ended", async () => {
    const release = vi.fn(async (_tokens: number) => undefined);
    const response = new Response(bodyOf('data: {"usage":{"tota', 'l_tokens":42}}\n\n'), {
      status: 201,
      statusText: "Made",
      headers: { "x-a": "1" },
    });

    const held = releasedAtBodyEnd(response, release);

    expect(held.status).toBe(201);
    expect(held.statusText).toBe("Made");
    expect(held.headers.get("x-a")).toBe("1");
    expect(release).not.toHaveBeenCalled();
    expect(await held.text()).toBe('data: {"usage":{"total_tokens":42}}\n\n');
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(42);
  });

  it("releases only after it has read the whole body, from its last 16 KiB", async () => {
    const release = vi.fn(async (_tokens: number) => undefined);
    const head = `{"total_tokens":999}${"x".repeat(20_000)}`;
    const held = releasedAtBodyEnd(new Response(bodyOf(head, '{"total_tokens":5}')), release);

    await held.text();

    expect(release).toHaveBeenCalledWith(5);
  });

  it("keeps the tail only: a report older than 16 KiB is not read", async () => {
    const release = vi.fn(async (_tokens: number) => undefined);
    const old = `{"total_tokens":999}${"x".repeat(16_384)}`;
    const held = releasedAtBodyEnd(new Response(bodyOf(old)), release);

    await held.text();

    expect(release).toHaveBeenCalledWith(0);
  });

  it("a multi-byte character split across chunks is read whole", async () => {
    const release = vi.fn(async (_tokens: number) => undefined);
    const bytes = new TextEncoder().encode('{"note":"€","total_tokens":8}');
    const cut = bytes.indexOf(0xe2) + 1;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, cut));
        controller.enqueue(bytes.slice(cut));
        controller.close();
      },
    });

    await releasedAtBodyEnd(new Response(body), release).text();

    expect(release).toHaveBeenCalledWith(8);
  });

  it("a multi-byte space between the colon and the number, split across chunks, is still a space", async () => {
    const release = vi.fn(async (_tokens: number) => undefined);
    // U+00A0 is two bytes; the chunks cut it in the middle
    const bytes = new TextEncoder().encode('{"total_tokens":\u00a07}');
    const cut = bytes.indexOf(0xc2) + 1;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, cut));
        controller.enqueue(bytes.slice(cut));
        controller.close();
      },
    });

    await releasedAtBodyEnd(new Response(body), release).text();

    expect(release).toHaveBeenCalledWith(7);
  });

  it("a response with no body releases 0 at once and is returned as it is", () => {
    const release = vi.fn(async (_tokens: number) => undefined);
    const response = new Response(null, { status: 204 });

    expect(releasedAtBodyEnd(response, release)).toBe(response);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(0);
  });

  it("a body that fails releases 0 and fails the reader", async () => {
    const release = vi.fn(async (_tokens: number) => undefined);
    const failing = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("connection reset");
      },
    });

    await expect(releasedAtBodyEnd(new Response(failing), release).text()).rejects.toThrow(
      "connection reset",
    );
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(0);
  });

  it("a caller that cancels releases 0 and cancels the source with its reason", async () => {
    const release = vi.fn(async (_tokens: number) => undefined);
    const cancelled = vi.fn<(reason: unknown) => void>();
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('{"total_tokens":9}'));
      },
      cancel(reason) {
        cancelled(reason);
      },
    });
    const held = releasedAtBodyEnd(new Response(source), release);
    const reader = held.body?.getReader();

    await reader?.read();
    await reader?.cancel("no longer needed");

    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(0);
    expect(cancelled).toHaveBeenCalledWith("no longer needed");
  });
});
