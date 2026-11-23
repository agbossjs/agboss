/**
 * #1366: how long a provider asked to wait (`Retry-After`) — seconds or an HTTP date, in milliseconds, never
 * negative, none when it is absent, blank or unreadable.
 */
import { describe, expect, it } from "vitest";
import { retryAfterOf } from "../../src/models/model-failure.js";

const NOW = Date.parse("2026-01-01T00:00:00.000Z");

const after = (header: string | undefined): number | undefined =>
  retryAfterOf(
    new Response(null, header === undefined ? {} : { headers: { "retry-after": header } }),
    NOW,
  );

describe("#1366: Retry-After in milliseconds", () => {
  it("seconds are read as they are, a negative number of them is no wait", () => {
    expect(after("7")).toBe(7000);
    expect(after("0.5")).toBe(500);
    expect(after("-5")).toBe(0);
  });

  it("an HTTP date is the time until it, none when it is already past", () => {
    expect(after("Thu, 01 Jan 2026 00:00:10 GMT")).toBe(10_000);
    expect(after("Wed, 31 Dec 2025 23:59:00 GMT")).toBe(0);
  });

  it("is none when absent, blank or neither a number nor a date", () => {
    expect(after(undefined)).toBeUndefined();
    expect(after("   ")).toBeUndefined();
    expect(after("soon")).toBeUndefined();
  });
});
