/**
 * #1356 (mutation shard `a2a-server`): the MCP sessions' own rules on their own — whose a session is
 * (the whole identity, compared as plain data), the caps and their refusals, the idle clock.
 */
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../../src/core/error-families/config-errors.js";
import {
  callerKeyOf,
  McpSessions,
  SESSION_LIMIT_REFUSALS,
  type TrackedSession,
} from "../../src/mcp/mcp-session-limits.js";
import { inSession, isSameCaller, stableOwnerOf } from "../../src/mcp/mcp-session-identity.js";
import type { McpCaller } from "../../src/mcp/mcp-service-helpers.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { minutes, ms, seconds } from "../../src/units/index.js";

describe("isSameCaller: the whole identity", () => {
  const base: McpCaller = {
    ownerId: "dana",
    peer: "peer-app",
    tenant: { tenantId: "acme", weight: 2 },
    execution: { region: "eu", roles: ["a", "b"] },
  };

  it("the same values in another key order are one caller", () => {
    const reordered: McpCaller = {
      execution: { roles: ["a", "b"], region: "eu" },
      tenant: { weight: 2, tenantId: "acme" },
      peer: "peer-app",
      ownerId: "dana",
    };

    expect(isSameCaller(reordered, base)).toBe(true);
  });

  it("a field that is undefined is no field", () => {
    expect(
      isSameCaller({ ...base, execution: { region: "eu", roles: ["a", "b"], x: undefined } }, base),
    ).toBe(true);
  });

  it.each([
    ["the peer", { peer: "other" }],
    ["no peer", { peer: undefined }],
    ["the owner", { ownerId: "eve" }],
    ["no owner", { ownerId: undefined }],
    ["a tenant's weight", { tenant: { tenantId: "acme", weight: 3 } }],
    ["the order of a list", { execution: { region: "eu", roles: ["b", "a"] } }],
    ["an extra value", { execution: { region: "eu", roles: ["a", "b"], x: 1 } }],
    ["no tenant", { tenant: undefined }],
    ["the execution's values", { execution: { region: "us" } }],
    ["no execution values", { execution: undefined }],
  ])("another %s is another caller", (_name, change) => {
    expect(isSameCaller({ ...base, ...change }, base)).toBe(false);
  });

  it("dates are compared by their time", () => {
    const at = (iso: string): McpCaller => ({ execution: { since: new Date(iso) } });

    expect(isSameCaller(at("2026-01-01T00:00:00Z"), at("2026-01-01T00:00:00Z"))).toBe(true);
    expect(isSameCaller(at("2026-01-01T00:00:00Z"), at("2026-01-01T00:00:01Z"))).toBe(false);
  });

  it("a value that is not plain data equals nothing, itself included: fail closed", () => {
    class Held {
      readonly n = 1;
    }
    const held: McpCaller = { execution: { held: new Held() } };
    const fn: McpCaller = { execution: { f: () => 1 } };
    const symbol: McpCaller = { execution: { s: Symbol("x") } };

    expect(isSameCaller(held, held)).toBe(false);
    expect(isSameCaller(fn, fn)).toBe(false);
    expect(isSameCaller(symbol, symbol)).toBe(false);
  });

  it("an object with no prototype is plain", () => {
    const bare = Object.assign(Object.create(null) as object, { region: "eu" });

    expect(isSameCaller({ execution: bare }, { execution: { region: "eu" } })).toBe(true);
  });

  it("null is a value like any other: two nulls are one", () => {
    expect(isSameCaller({ execution: { a: null } }, { execution: { a: null } })).toBe(true);
    expect(isSameCaller({ execution: { a: null } }, { execution: { a: 0 } })).toBe(false);
  });

  it("keys that sort apart are told apart whichever side holds the smaller", () => {
    expect(isSameCaller({ execution: { a: 1, b: 2 } }, { execution: { b: 2, a: 1 } })).toBe(true);
    expect(isSameCaller({ execution: { a: 1, b: 2 } }, { execution: { a: 2, b: 1 } })).toBe(false);
  });
});

describe("inSession: the caller as its session owns it", () => {
  it("one with an owner keeps it, and it is what its calls' idempotency is scoped by", () => {
    expect(inSession({ ownerId: "dana" }, "s-1")).toEqual({ ownerId: "dana", authOwnerId: "dana" });
  });

  it("a peer with no owner has no scoping owner either, and none is made for it", () => {
    const made = inSession({ peer: "peer-app" }, "s-1");

    expect(made).toEqual({ peer: "peer-app", authOwnerId: undefined });
    expect("authOwnerId" in made).toBe(true);
    expect("ownerId" in made).toBe(false);
  });

  it("a tenant's key with no owner is the session's own: `mcp-session:<id>`", () => {
    const made = inSession({ tenant: { tenantId: "acme" } }, "s-1");

    expect(made).toEqual({
      tenant: { tenantId: "acme" },
      ownerId: "mcp-session:s-1",
      authOwnerId: undefined,
    });
    expect("authOwnerId" in made).toBe(true);
  });

  it("an anonymous caller is `anonymous:<id>`, with no scoping owner", () => {
    const made = inSession({}, "s-1");

    expect(made).toEqual({ ownerId: "anonymous:s-1" });
    expect("authOwnerId" in made).toBe(false);
  });
});

describe("stableOwnerOf: the owner a call is identified by across sessions", () => {
  it("the one the caller came with, never the session's own", () => {
    expect(stableOwnerOf(inSession({ ownerId: "dana" }, "s-1"))).toBe("dana");
    expect(stableOwnerOf(inSession({ tenant: { tenantId: "acme" } }, "s-1"))).toBeUndefined();
  });

  it("a caller never in a session is its own owner; an anonymous one keeps its session's", () => {
    expect(stableOwnerOf({ ownerId: "dana" })).toBe("dana");
    expect(stableOwnerOf(inSession({}, "s-1"))).toBe("anonymous:s-1");
  });
});

describe("callerKeyOf: whose sessions are counted together", () => {
  it("the peer, owner and tenant, in that order, no one as null", () => {
    expect(callerKeyOf({})).toBe("[null,null,null]");
    expect(callerKeyOf({ peer: "p", ownerId: "o", tenant: { tenantId: "t" } })).toBe(
      '["p","o","t"]',
    );
    expect(callerKeyOf({ ownerId: "o" })).toBe('[null,"o",null]');
    expect(callerKeyOf({ tenant: { tenantId: "t" } })).toBe('[null,null,"t"]');
    expect(callerKeyOf({ peer: "p" })).toBe('["p",null,null]');
  });
});

/** A response that only closes. */
const responseOf = (): ServerResponse & EventEmitter =>
  new EventEmitter() as ServerResponse & EventEmitter;

/** A session whose transport counts its closes. */
function sessionOf(callerKey = "k"): { session: TrackedSession; closes: () => number } {
  let closes = 0;
  const session: TrackedSession = {
    transport: {
      close: () => {
        closes += 1;
        return Promise.resolve();
      },
    } as TrackedSession["transport"],
    identity: {},
    callerKey,
    inFlight: 0,
  };
  return { session, closes: () => closes };
}

describe("McpSessions: the limits", () => {
  const clock = () => new VirtualClock();

  it.each([
    ["sessionIdleTimeout", { sessionIdleTimeout: ms(0) }],
    ["sessionIdleTimeout", { sessionIdleTimeout: ms(1.5) }],
    ["maxSessionsPerCaller", { maxSessionsPerCaller: 0 }],
    ["maxSessionsPerCaller", { maxSessionsPerCaller: 2.5 }],
    ["maxSessionsPerCaller", { maxSessionsPerCaller: Number.NaN }],
    ["maxSessions", { maxSessions: -1 }],
    ["maxSessions", { maxSessions: 0 }],
  ])("%s %j is refused at the start", (name, limits) => {
    expect(() => new McpSessions(limits, clock())).toThrow(
      `[mcp.session-limit-invalid] mcpHttpListener's ${name} is not a positive whole number`,
    );
    expect(() => new McpSessions(limits, clock())).toThrow(ConfigError.Environment);
  });

  it("one is a limit", () => {
    const sessions = new McpSessions(
      { sessionIdleTimeout: ms(1), maxSessionsPerCaller: 1, maxSessions: 1 },
      clock(),
    );

    expect(sessions.refusalFor("k")).toBeUndefined();
  });

  it("the refusals: 429 with its code and text, 503 with its code and text", () => {
    expect(SESSION_LIMIT_REFUSALS.perCaller).toEqual({
      status: 429,
      body: {
        code: "mcp.too-many-sessions",
        error:
          "this caller has too many open sessions: close one, or wait for an idle one to expire",
      },
    });
    expect(SESSION_LIMIT_REFUSALS.inAll).toEqual({
      status: 503,
      body: {
        code: "mcp.sessions-exhausted",
        error: "the MCP server has no room for another session: try again later",
      },
    });
  });

  it("a caller over its cap is refused 429, another caller is not; the cap counts open and opening ones", () => {
    const sessions = new McpSessions({ maxSessionsPerCaller: 2 }, clock());
    sessions.add("s-1", sessionOf("a").session);
    expect(sessions.refusalFor("a")).toBeUndefined();

    sessions.opening("s-2", "a", responseOf());

    expect(sessions.refusalFor("a")).toBe(SESSION_LIMIT_REFUSALS.perCaller);
    expect(sessions.refusalFor("b")).toBeUndefined();
  });

  it("the cap in all is 503, counted over open and opening sessions, before the caller's own", () => {
    const sessions = new McpSessions({ maxSessions: 2, maxSessionsPerCaller: 1 }, clock());
    sessions.add("s-1", sessionOf("a").session);
    expect(sessions.refusalFor("b")).toBeUndefined();

    sessions.opening("s-2", "b", responseOf());

    expect(sessions.refusalFor("c")).toBe(SESSION_LIMIT_REFUSALS.inAll);
    expect(sessions.refusalFor("a")).toBe(SESSION_LIMIT_REFUSALS.inAll);
  });

  it("another caller's opening session is not this caller's", () => {
    const sessions = new McpSessions({ maxSessionsPerCaller: 1 }, clock());
    sessions.opening("s-1", "b", responseOf());

    expect(sessions.refusalFor("a")).toBeUndefined();
    expect(sessions.refusalFor("b")).toBe(SESSION_LIMIT_REFUSALS.perCaller);
  });

  it("an opening session stops counting when its request closes", () => {
    const sessions = new McpSessions({ maxSessions: 1 }, clock());
    const res = responseOf();
    sessions.opening("s-1", "a", res);
    expect(sessions.refusalFor("a")).toBe(SESSION_LIMIT_REFUSALS.inAll);

    res.emit("close");

    expect(sessions.refusalFor("a")).toBeUndefined();
  });

  it("an opened session is counted once: open, no longer opening", () => {
    const sessions = new McpSessions({ maxSessions: 2 }, clock());
    sessions.opening("s-1", "a", responseOf());
    sessions.add("s-1", sessionOf("a").session);

    expect(sessions.size).toBe(1);
    expect(sessions.refusalFor("b")).toBeUndefined();
  });

  it("get, size and remove", () => {
    const sessions = new McpSessions({}, clock());
    const { session } = sessionOf();
    sessions.add("s-1", session);

    expect(sessions.get("s-1")).toBe(session);
    expect(sessions.get("s-2")).toBeUndefined();
    expect(sessions.size).toBe(1);

    sessions.remove("s-2");
    expect(sessions.size).toBe(1);
    sessions.remove("s-1");
    expect(sessions.size).toBe(0);
    expect(session.closed).toBe(true);
    expect(sessions.get("s-1")).toBeUndefined();
  });
});

describe("McpSessions: the idle clock", () => {
  it("an idle session is closed after the timeout, not before; the default is thirty minutes", async () => {
    const clock = new VirtualClock();
    const sessions = new McpSessions({}, clock);
    const { session, closes } = sessionOf();
    sessions.add("s-1", session);

    await clock.advance(ms(minutes(30) - 1));
    expect(closes()).toBe(0);
    await clock.advance(ms(1));

    expect(closes()).toBe(1);
  });

  it("the timeout is the listener's own", async () => {
    const clock = new VirtualClock();
    const sessions = new McpSessions({ sessionIdleTimeout: seconds(5) }, clock);
    const { session, closes } = sessionOf();
    sessions.add("s-1", session);

    await clock.advance(ms(seconds(5) - 1));
    expect(closes()).toBe(0);
    await clock.advance(ms(1));

    expect(closes()).toBe(1);
  });

  it("a request in flight stops the clock, and its end starts it again from then", async () => {
    const clock = new VirtualClock();
    const sessions = new McpSessions({ sessionIdleTimeout: seconds(10) }, clock);
    const { session, closes } = sessionOf();
    sessions.add("s-1", session);
    await clock.advance(seconds(9));
    const res = responseOf();

    sessions.use(session, res);
    expect(session.inFlight).toBe(1);
    await clock.advance(seconds(60));
    expect(closes()).toBe(0);
    res.emit("close");
    expect(session.inFlight).toBe(0);
    await clock.advance(seconds(9));
    expect(closes()).toBe(0);
    await clock.advance(seconds(1));

    expect(closes()).toBe(1);
  });

  it("two requests: the clock runs only when both are over", async () => {
    const clock = new VirtualClock();
    const sessions = new McpSessions({ sessionIdleTimeout: seconds(10) }, clock);
    const { session, closes } = sessionOf();
    sessions.add("s-1", session);
    const [one, two] = [responseOf(), responseOf()];
    sessions.use(session, one);
    sessions.use(session, two);

    one.emit("close");
    await clock.advance(seconds(60));
    expect(closes()).toBe(0);
    expect(session.inFlight).toBe(1);
    two.emit("close");
    await clock.advance(seconds(10));

    expect(closes()).toBe(1);
  });

  it("a removed session never closes later, and a request of it that ends later does not re-arm it", async () => {
    const clock = new VirtualClock();
    const sessions = new McpSessions({ sessionIdleTimeout: seconds(10) }, clock);
    const { session, closes } = sessionOf();
    sessions.add("s-1", session);
    const res = responseOf();
    sessions.use(session, res);

    sessions.remove("s-1");
    res.emit("close");
    await clock.advance(seconds(60));

    expect(closes()).toBe(0);
  });

  it("a session never armed (a request in flight when it was added) is used, ended and removed all the same", async () => {
    const clock = new VirtualClock();
    const sessions = new McpSessions({ sessionIdleTimeout: seconds(10) }, clock);
    const { session, closes } = sessionOf();
    const busy: TrackedSession = { ...session, inFlight: 1 };
    sessions.add("s-1", busy);
    const res = responseOf();

    sessions.use(busy, res);
    expect(busy.inFlight).toBe(2);
    res.emit("close");
    expect(busy.inFlight).toBe(1);
    await clock.advance(seconds(60));
    expect(closes()).toBe(0);

    sessions.remove("s-1");
    expect(busy.closed).toBe(true);
    expect(sessions.size).toBe(0);
  });

  it("a removed idle session's clock is stopped", async () => {
    const clock = new VirtualClock();
    const sessions = new McpSessions({ sessionIdleTimeout: seconds(10) }, clock);
    const { session, closes } = sessionOf();
    sessions.add("s-1", session);

    sessions.remove("s-1");
    await clock.advance(seconds(60));

    expect(closes()).toBe(0);
  });
});
