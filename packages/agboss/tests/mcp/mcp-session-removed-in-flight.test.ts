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

/** What the listener does for a request that opens a session: the check, the count, then the slow initialize. */
async function initialize(sessions: McpSessions, id: string, callerKey: string) {
  const refusal = sessions.refusalFor(callerKey);
  if (refusal !== undefined) return refusal.status;
  sessions.opening(id, callerKey, new EventEmitter() as never);
  await new Promise((resolve) => setImmediate(resolve)); // the transport initializes asynchronously
  sessions.add(id, { ...sessionOf({ count: 0 }), callerKey });
  return 200;
}

describe("#1410 M3: a burst of initializes cannot pass the caps together (#opening)", () => {
  it("three at once from one caller over a cap of two: exactly one 429", async () => {
    const sessions = new McpSessions({ maxSessionsPerCaller: 2 }, new VirtualClock());

    const statuses = await Promise.all(
      ["a", "b", "c"].map((id) => initialize(sessions, id, "alice")),
    );

    expect(statuses.sort()).toEqual([200, 200, 429]);
    expect(sessions.size).toBe(2);
  });

  it("three at once from three callers over a total of two: exactly one 503", async () => {
    const sessions = new McpSessions({ maxSessions: 2 }, new VirtualClock());

    const statuses = await Promise.all(
      ["a", "b", "c"].map((id) => initialize(sessions, id, `caller-${id}`)),
    );

    expect(statuses.sort()).toEqual([200, 200, 503]);
    expect(sessions.size).toBe(2);
  });

  it("a request that closes before its session initialized frees its place", async () => {
    const sessions = new McpSessions({ maxSessions: 1 }, new VirtualClock());
    const response = new EventEmitter();
    sessions.opening("a", "alice", response as never);
    expect(sessions.refusalFor("bob")?.status).toBe(503);

    response.emit("close");

    expect(sessions.refusalFor("bob")).toBeUndefined();
  });
});

describe("#1403: a removed session is not brought back by a request that closes later", () => {
  it("does not re-arm the idle clock after remove (the one guard is `#arm`'s)", async () => {
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
