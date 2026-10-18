import type { ChannelQuestionOf } from "../flow/generated-types.js";
import type { ChannelOutcome } from "./channel-outcome.js";

/**
 * The channel contract (#267): one method, `send`. Both types take the role class, like
 * `InputOf<X>` / `Route<R>` take the component; the execution comes through `deps`
 * (`ExecutionContext` or the project's subclass), like in any component.
 */

/** What a channel is asked: the pause's id and the role's typed question. */
export interface ChannelAsk<TRole> {
  /**
   * The pause's id, a random 128-bit token made once per pause: the channel sends it, the reply
   * resumes it — and it is the idempotency key of the channel's own call.
   */
  readonly pauseId: string;
  /** The question, typed by the role (`approves` → the tool call; `ask` → that DTO). */
  readonly value: ChannelQuestionOf<TRole>;
}

/** Every channel: a role's implementation, or a concrete `@Channel` a tool names as is. */
export interface ChannelHandler<TRole> {
  send(ask: ChannelAsk<TRole>): Promise<ChannelOutcome<TRole>>;
}

/**
 * The base of a channel role: `export abstract class RefundApprovalChannel extends
 * ChannelOf<RefundApprovalChannel> {}` with `@ChannelRole`; its implementation `extends` the role.
 */
export abstract class ChannelOf<TRole> implements ChannelHandler<TRole> {
  abstract send(ask: ChannelAsk<TRole>): Promise<ChannelOutcome<TRole>>;
}
