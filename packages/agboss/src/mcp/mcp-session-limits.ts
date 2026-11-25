import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { ServerResponse } from "node:http";
import { ConfigError } from "../core/error-families/config-errors.js";
import { timeoutOn, type Clock } from "../infrastructure/clock.js";
import { minutes, type Milliseconds } from "../units/index.js";
import type { McpCaller } from "./mcp-service-helpers.js";

/**
 * How many MCP sessions a listener keeps open, and for how long (#1319): a session is kept in memory
 * (a server and a transport) until its client closes it, so an idle lifetime, a cap per caller and a
 * cap in all bound what a crashed or hostile client leaves behind.
 */

/** The limits of a listener's sessions; every field has a default (`mcpHttpListener`'s options). */
export interface McpSessionLimits {
  /**
   * How long a session may sit with no request in flight before the listener closes it; each request
   * (and each open stream) renews it. By default `minutes(30)`.
   */
  readonly sessionIdleTimeout?: Milliseconds;
  /** The sessions one caller (its peer, owner and tenant; every anonymous caller counts as one) may keep open: over it `429`. By default 100. */
  readonly maxSessionsPerCaller?: number;
  /** The sessions open in all: over it `503`. By default 10 000. */
  readonly maxSessions?: number;
}

const DEFAULT_IDLE_TIMEOUT = minutes(30);
const DEFAULT_PER_CALLER = 100;
const DEFAULT_IN_ALL = 10_000;

/** The refusals, each typed by its `code`. */
export const SESSION_LIMIT_REFUSALS = {
  perCaller: {
    status: 429,
    body: {
      code: "mcp.too-many-sessions",
      error: "this caller has too many open sessions: close one, or wait for an idle one to expire",
    },
  },
  inAll: {
    status: 503,
    body: {
      code: "mcp.sessions-exhausted",
      error: "the MCP server has no room for another session: try again later",
    },
  },
} as const;

/** One open session as the listener tracks it. */
export interface TrackedSession {
  readonly transport: StreamableHTTPServerTransport;
  readonly identity: McpCaller;
  readonly callerKey: string;
  /** The requests being served (an open event stream is one): the idle clock runs at none. */
  inFlight: number;
  /** Stops the idle clock. */
  release?: () => void;
}

/** Whose sessions are counted together: the peer, owner and tenant of the opener (no one is one caller: `anonymous`). */
export const callerKeyOf = (caller: McpCaller): string =>
  JSON.stringify([caller.peer ?? null, caller.ownerId ?? null, caller.tenant?.tenantId ?? null]);

const positive = (value: number | undefined, fallback: number, name: string): number => {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1)
    throw new ConfigError.Environment({
      message: `[mcp.session-limit-invalid] mcpHttpListener's ${name} is not a positive whole number`,
    });
  return value;
};

/** The sessions of one listener: its limits, the open ones and those being opened. */
export class McpSessions {
  readonly #open = new Map<string, TrackedSession>();
  /** The sessions opened by a request still being served: counted, so a burst cannot pass the caps together. */
  readonly #opening = new Map<string, string>();
  readonly #idleTimeout: number;
  readonly #perCaller: number;
  readonly #inAll: number;

  constructor(
    limits: McpSessionLimits,
    private readonly clock: Clock,
  ) {
    this.#idleTimeout = positive(
      limits.sessionIdleTimeout,
      DEFAULT_IDLE_TIMEOUT,
      "sessionIdleTimeout",
    );
    this.#perCaller = positive(
      limits.maxSessionsPerCaller,
      DEFAULT_PER_CALLER,
      "maxSessionsPerCaller",
    );
    this.#inAll = positive(limits.maxSessions, DEFAULT_IN_ALL, "maxSessions");
  }

  get(id: string): TrackedSession | undefined {
    return this.#open.get(id);
  }

  get size(): number {
    return this.#open.size;
  }

  /** The refusal for a caller who asks to open one more session, or `undefined` when there is room. */
  refusalFor(
    callerKey: string,
  ): (typeof SESSION_LIMIT_REFUSALS)[keyof typeof SESSION_LIMIT_REFUSALS] | undefined {
    if (this.#open.size + this.#opening.size >= this.#inAll) return SESSION_LIMIT_REFUSALS.inAll;
    let mine = 0;
    for (const session of this.#open.values()) if (session.callerKey === callerKey) mine += 1;
    for (const key of this.#opening.values()) if (key === callerKey) mine += 1;
    return mine >= this.#perCaller ? SESSION_LIMIT_REFUSALS.perCaller : undefined;
  }

  /** Counts a session being opened until its request is over (it is then open, or never was). */
  opening(id: string, callerKey: string, res: ServerResponse): void {
    this.#opening.set(id, callerKey);
    res.once("close", () => this.#opening.delete(id));
  }

  /** The session is initialized: kept, and its idle clock started. */
  add(id: string, session: TrackedSession): void {
    this.#opening.delete(id);
    this.#open.set(id, session);
    this.#arm(session);
  }

  remove(id: string): void {
    this.#open.get(id)?.release?.();
    this.#open.delete(id);
  }

  /** A request of the session starts; it is over when `res` closes (an event stream lives until then). */
  use(session: TrackedSession, res: ServerResponse): void {
    session.inFlight += 1;
    session.release?.();
    res.once("close", () => {
      session.inFlight -= 1;
      this.#arm(session);
    });
  }

  #arm(session: TrackedSession): void {
    session.release?.();
    if (session.inFlight > 0) return;
    const idle = timeoutOn(this.clock, this.#idleTimeout as Milliseconds, () => new Error("idle"));
    idle.signal.addEventListener(
      "abort",
      () => {
        void session.transport.close();
      },
      { once: true },
    );
    session.release = idle.release;
  }
}
