import { AGBossError } from "../../core/errors.js";

/**
 * What the client refuses before anything is sent (#809, security): an origin it was not given,
 * an AGBoss target without the mesh.
 */

/** Where a refused origin was found. */
export enum A2AOriginSite {
  /** An interface the agent's card declares. */
  CardInterface = "card-interface",
  /** A request the client was about to send. */
  Request = "request",
  /** A redirect the agent answered. */
  Redirect = "redirect",
}

/** What a refused origin knows: the origin and the ones the client may talk to. */
export interface A2AOriginErrorOptions {
  readonly agent: string;
  readonly origin: string;
  readonly site: A2AOriginSite;
  readonly allowedOrigins: readonly string[];
}

/**
 * The client would have talked to an origin it was not given (#809, security): an interface of the
 * agent's card, a request or a redirect outside the client's `url` origin and its `allowedOrigins`.
 * Nothing was sent there — the client's headers (a token, a key) go to its own origins only.
 */
export class A2AOriginError extends AGBossError {
  static override readonly code = "a2a.origin-refused" as const;
  override name = "A2AOriginError";
  readonly agent: string;
  readonly origin: string;
  readonly site: A2AOriginSite;
  readonly allowedOrigins: readonly string[];

  constructor(options: A2AOriginErrorOptions) {
    super(
      `[a2a.origin-refused] A2A agent ${options.agent}: ${options.site} at ${options.origin}, outside its origins (${options.allowedOrigins.join(", ")}) — nothing was sent there; list it in allowedOrigins if it is the agent's`,
      { details: { agent: options.agent, origin: options.origin, site: options.site } },
    );
    this.agent = options.agent;
    this.origin = options.origin;
    this.site = options.site;
    this.allowedOrigins = options.allowedOrigins;
  }
}

/** Whether a call needs the AGBoss mesh extension of its agent. */
export enum A2AMesh {
  /**
   * The agent must declare the mesh extension: the call chain (loop and hop limits), the caller's
   * budget and deadline and the signed run report ride the call. The default with a
   * `target.application` — an AGBoss peer is expected.
   */
  Required = "required",
  /** Used when the agent declares it; else the call goes without it (a foreign agent). */
  IfSupported = "if-supported",
}

/** What a refused call to an agent without the mesh knows. */
export interface A2AMeshUnsupportedErrorOptions {
  readonly agent: string;
  readonly application: string | undefined;
}

/**
 * The agent's card does not declare the AGBoss mesh extension, and the call requires it (#809,
 * `A2AMesh.Required`, the default for an `@A2AAgent` with a `target.application`): without it no
 * loop or hop limit, budget or deadline would reach the agent. Nothing was sent.
 */
export class A2AMeshUnsupportedError extends AGBossError {
  static override readonly code = "a2a.mesh-unsupported" as const;
  override name = "A2AMeshUnsupportedError";
  readonly agent: string;
  readonly application: string | undefined;

  constructor(options: A2AMeshUnsupportedErrorOptions) {
    const target = options.application === undefined ? "" : ` (${options.application})`;
    super(
      `A2A agent ${options.agent}${target} does not declare the AGBoss mesh extension, which the call requires — nothing was sent; mesh: A2AMesh.IfSupported calls it without the mesh`,
      { details: { agent: options.agent } },
    );
    this.agent = options.agent;
    this.application = options.application;
  }
}
