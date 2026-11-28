/**
 * #1356 (stream shard) — a transport call's text as a sequence: each text as it is pushed, then the answer last; a
 * consumer that stops before the call ended aborts it, one that read to the end or heard it fail does not.
 */
import { describe, expect, it, vi } from "vitest";
import { chunksOf } from "../../../src/models/transport/transport-chunks.js";

const answer = { text: "done" } as never;

describe("#1356: the chunks of a transport call", () => {
  it("are every text in the order it was pushed, then the answer, and a call that ended is not stopped", async () => {
    const stop = vi.fn();
    const read = async (onText: (text: string) => Promise<void>) => {
      await onText("one ");
      await onText("two");
      return answer;
    };

    const heard: unknown[] = [];
    for await (const chunk of chunksOf(read, stop)) heard.push(chunk);

    expect(heard).toEqual(["one ", "two", answer]);
    expect(stop).not.toHaveBeenCalled();
  });

  it("a text pushed after the consumer is waiting wakes it", async () => {
    const stop = vi.fn();
    const read = async (onText: (text: string) => Promise<void>) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await onText("late");
      await new Promise((resolve) => setTimeout(resolve, 5));
      return answer;
    };

    const heard: unknown[] = [];
    for await (const chunk of chunksOf(read, stop)) heard.push(chunk);

    expect(heard).toEqual(["late", answer]);
    expect(stop).not.toHaveBeenCalled();
  });

  it("the text that came before a failure is heard, then the failure is the sequence's, and a call that failed is not stopped", async () => {
    const stop = vi.fn();
    const failure = new Error("the provider died");
    const read = async (onText: (text: string) => Promise<void>) => {
      await onText("part");
      throw failure;
    };
    const heard: unknown[] = [];

    const outcome = await (async () => {
      try {
        for await (const chunk of chunksOf(read, stop)) heard.push(chunk);
        return undefined;
      } catch (error) {
        return error;
      }
    })();

    expect(heard).toEqual(["part"]);
    expect(outcome).toBe(failure);
    expect(stop).not.toHaveBeenCalled();
  });

  it("a consumer that stops while the call is still running aborts it, once", async () => {
    const stop = vi.fn();
    const read = async (onText: (text: string) => Promise<void>) => {
      await onText("first");
      return new Promise<never>(() => undefined); // the call never ends by itself
    };

    for await (const chunk of chunksOf(read, stop)) {
      expect(chunk).toBe("first");
      break;
    }

    expect(stop).toHaveBeenCalledOnce();
  });
});
