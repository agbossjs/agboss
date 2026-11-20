/** #1353: the A2A task stores' keys, order and page tokens, each on its own. */
import { describe, expect, it } from "vitest";
import { InvalidA2APageTokenError } from "../../src/infrastructure/a2a-task.repository.js";
import {
  a2aMessageRowOf,
  a2aPagePositionOf,
  a2aPageTokenOf,
  a2aTaskRowOf,
  byNewestStatus,
  greaterTextFirst,
  isAfterPosition,
} from "../../src/infrastructure/a2a-task-pages.js";

const at = (ms: number): Date => new Date(ms);

describe("greaterTextFirst", () => {
  it("is positive when the right text is greater, negative when the left one is, 0 when equal", () => {
    expect(greaterTextFirst("a", "b")).toBe(1);
    expect(greaterTextFirst("b", "a")).toBe(-1);
    expect(greaterTextFirst("a", "a")).toBe(0);
    expect(greaterTextFirst("", "")).toBe(0);
    expect(greaterTextFirst("ab", "a")).toBe(-1);
  });
});

describe("byNewestStatus", () => {
  const task = (ms: number, taskId: string) => ({ statusAt: at(ms), taskId });

  it("puts the newest status first, then the greater id", () => {
    const sorted = [task(1, "a"), task(2, "a"), task(2, "b"), task(1, "c")].sort(byNewestStatus);

    expect(sorted).toEqual([task(2, "b"), task(2, "a"), task(1, "c"), task(1, "a")]);
  });

  it("finds two equal tasks equal", () => {
    expect(byNewestStatus(task(5, "a"), task(5, "a"))).toBe(0);
  });
});

describe("isAfterPosition", () => {
  const position = { statusAt: 10, taskId: "m" };

  it.each([
    ["an older status", 9, "z", true],
    ["a newer status", 11, "a", false],
    ["the same status, a lesser id", 10, "a", true],
    ["the same status, the same id", 10, "m", false],
    ["the same status, a greater id", 10, "z", false],
  ])("%s: %s", (_name, ms, taskId, expected) => {
    expect(isAfterPosition({ statusAt: at(ms), taskId }, position)).toBe(expected);
  });
});

describe("page tokens", () => {
  it("name the page after a task, and read back as its place", () => {
    const token = a2aPageTokenOf({ statusAt: at(1234), taskId: "t-1" });

    expect(a2aPagePositionOf(token)).toEqual({ statusAt: 1234, taskId: "t-1" });
  });

  it("are refused when they are no token a list gave", () => {
    const encoded = (value: unknown): string =>
      Buffer.from(JSON.stringify(value)).toString("base64url");

    for (const token of [
      "not a token",
      "!!!",
      Buffer.from("{").toString("base64url"),
      encoded({ statusAt: 1, taskId: "t" }),
      encoded([1]),
      encoded(["1", "t"]),
      encoded([1.5, "t"]),
      encoded([8.64e15 + 1, "t"]),
      encoded([-8.64e15 - 1, "t"]),
      encoded([1, 2]),
    ])
      expect(() => a2aPagePositionOf(token), token).toThrow(InvalidA2APageTokenError);
  });

  it("take the greatest and the least time a Date holds", () => {
    const encoded = (ms: number): string =>
      Buffer.from(JSON.stringify([ms, "t"])).toString("base64url");

    expect(a2aPagePositionOf(encoded(8.64e15)).statusAt).toBe(8.64e15);
    expect(a2aPagePositionOf(encoded(-8.64e15)).statusAt).toBe(-8.64e15);
  });
});

describe("row keys", () => {
  it("a task's is its tenant and id, parted by a NUL", () => {
    expect(a2aTaskRowOf({ tenantId: "t", taskId: "k" })).toBe("t\u0000k");
  });

  it("a message's is its tenant, owner and id, parted by NULs; no owner is the empty text", () => {
    expect(a2aMessageRowOf({ tenantId: "t", ownerId: "o", messageId: "m" })).toBe(
      "t\u0000o\u0000m",
    );
    expect(a2aMessageRowOf({ tenantId: "t", ownerId: undefined, messageId: "m" })).toBe(
      "t\u0000\u0000m",
    );
    expect(a2aMessageRowOf({ tenantId: "t", ownerId: "", messageId: "m" })).toBe("t\u0000\u0000m");
  });
});
