import type { Usd } from "../../units/index.js";
import type { NodeEvent } from "./execution-event.js";

/**
 * A `@ChannelInterpreter` starts reading a free-text reply (#1310, `onChannelInterpreterStart`): in
 * the first phase of `app.resume`, before the paused execution's pause is closed. `step` is the step
 * that waits. Never the reply, the ask or the pause's id.
 */
export interface ChannelInterpreterStartEvent extends NodeEvent {
  /** The `@ChannelInterpreter`'s name. */
  readonly interpreter: string;
  /** The channel role whose pause is answered. */
  readonly channel: string;
  /** Whether the interpreter is code, else a model reads the reply. */
  readonly isCode: boolean;
}

/** How a reading ended. */
export enum ChannelInterpreterOutcome {
  /** The reply gave a valid decision. */
  Read = "read",
  /** The reply was not understood, or its decision was invalid: the pause stays pending. */
  Unreadable = "unreadable",
}

/** An interpreter ended reading (`onChannelInterpreterEnd`): once per start, with what it spent. */
export interface ChannelInterpreterEndEvent extends ChannelInterpreterStartEvent {
  readonly outcome: ChannelInterpreterOutcome;
  /** What its model call cost (`0` for code); the spend is already counted. */
  readonly costUsd: Usd;
}
