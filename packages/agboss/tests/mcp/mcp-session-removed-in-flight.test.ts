/**
 * A session removed while a request of it is in flight stays removed (#1403): when that request's
 * response closes, the idle clock is not re-armed and the session is not counted again.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { VirtualClock } from "../../src/testing/clock.js";
import { McpSessions, type TrackedSession } from "../../src/mcp/mcp-session-limits.js";
import { minutes } from "../../src/units/index.js";

const sessionOf = (closes: { count: number }): TrackedSession => ({
  transport: {
    close: () => {
      closes.count += 1;
      return Promise.resolve();
    },
  } as never,
  identity: {},
  callerKey: "alice",
  inFlight: 0,
});

describe("#1403: a removed session is not brought back by a request that closes later", () => {
  it("does not re-arm the idle clock or count the session after remove", async () => {
    const clock = new VirtualClock();
    const closes = { count: 0 };
    const sessions = new McpSessions({ sessionIdleTimeout: minutes(1), maxSessions: 1 }, clock);
    const session = sessionOf(closes);
    sessions.add("s1", session);
    const response = new EventEmitter();
    sessions.use(session, response as never);

    sessions.remove("s1");
    response.emit("close");
    await clock.advance(minutes(5));

    expect(sessions.size).toBe(0);
    expect(sessions.get("s1")).toBeUndefined();
    expect(sessions.refusalFor("alice")).toBeUndefined();
    expect(closes.count).toBe(0);
  });

  it("still closes a live session that goes idle after its request", async () => {
    const clock = new VirtualClock();
    const closes = { count: 0 };
    const sessions = new McpSessions({ sessionIdleTimeout: minutes(1) }, clock);
    const session = sessionOf(closes);
    sessions.add("s1", session);
    const response = new EventEmitter();
    sessions.use(session, response as never);

    response.emit("close");
    await clock.advance(minutes(2));

    expect(closes.count).toBe(1);
  });
});
