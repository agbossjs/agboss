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
