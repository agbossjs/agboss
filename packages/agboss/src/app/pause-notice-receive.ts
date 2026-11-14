import type { ChannelSender } from "../channels/channel-sender.js";
import type { PauseListenerHandler } from "../pause/pause-listener.js";
import { isApprovalPause, type PauseRecord } from "../infrastructure/pause-record.js";
import { PauseNoticeKind, type PauseNotice } from "../infrastructure/pause-notices.js";
import type { Clock } from "../infrastructure/clock.js";
import { DEFAULT_TOOL_TIMEOUT } from "../tools/index.js";
import type { Milliseconds } from "../units/index.js";
import type { AppDeps } from "./app-deps.js";
import { callInFrame } from "./pause-notice-call.js";
import { ownDepsOf } from "./own-deps.js";
import { pauseFrameOf, pauseTreeOf, treeStateOf } from "./pause-frame.js";
import {
  channelClosedOf,
  channelNotTakenOf,
  deliveryIdOf,
  hookOverridden,
  listenerClosedOf,
  listenerNotTakenOf,
  listenerOpenedOf,
  type EventSources,
} from "./pause-notices.js";

/**
 * One notice told to one receiver (#940): the event built from the notice and the pause's record
 * (ask and answer masked by the pause's own workflow's observability policies, I15), the hook
 * called in the pause's frame under its timeout. A receiver that does not implement the notice's
 * kind — a channel without the hook, a listener without `onPauseAnswerNotTaken`, a kind #941 and
 * later add — is told nothing and the notice counts as delivered. Loaded with the first notice.
 */

/** A listener as the delivery calls it. */
export interface ListenerReceiver {
  readonly handler: PauseListenerHandler;
  readonly allowAnswering: boolean;
}

/** What telling a receiver needs of the application. */
export interface ReceiveParts {
  readonly clock: Clock;
  /** The instance's interruption (its stop): a hook still running is cut off. */
  readonly interruption: () => AbortSignal | undefined;
  readonly listenerOf: (name: string) => ListenerReceiver | undefined;
}

/** A receiver the application has not: a channel or a listener removed by a deploy. */
export class UnknownReceiverError extends Error {
  override name = "UnknownReceiverError";
}

/** The hook of a notice, ready to run, or `undefined` when the receiver is not told this kind. */
type Hook = (sources: EventSources) => Promise<() => Promise<void>>;

function channelHook(sender: ChannelSender, kind: PauseNoticeKind): Hook | undefined {
  if (kind === PauseNoticeKind.Closed && hookOverridden(sender, "onPauseClosed"))
    return async (sources) => {
      const event = await channelClosedOf(sources);
      return () => sender.onPauseClosed?.(event) ?? Promise.resolve();
    };
  if (kind === PauseNoticeKind.AnswerNotTaken && hookOverridden(sender, "onPauseAnswerNotTaken"))
    return async (sources) => {
      const event = await channelNotTakenOf(sources);
      return () => sender.onPauseAnswerNotTaken?.(event) ?? Promise.resolve();
    };
  return undefined;
}

function listenerHook(listener: ListenerReceiver, kind: PauseNoticeKind): Hook | undefined {
  const { handler, allowAnswering } = listener;
  if (kind === PauseNoticeKind.Opened)
    return async (sources) => {
      const event = await listenerOpenedOf(sources, allowAnswering);
      return () => handler.onPauseOpened(event);
    };
  if (kind === PauseNoticeKind.Closed)
    return async (sources) => {
      const event = await listenerClosedOf(sources, allowAnswering);
      return () => handler.onPauseClosed(event);
    };
  if (kind === PauseNoticeKind.AnswerNotTaken && handler.onPauseAnswerNotTaken !== undefined)
    return async (sources) => {
      const event = await listenerNotTakenOf(sources, allowAnswering);
      return () => handler.onPauseAnswerNotTaken?.(event) ?? Promise.resolve();
    };
  return undefined;
}

/** The hook of `recipient` (`channel:<name>` / `listener:<name>`) for the notice, and its timeout. */
function hookOf(
  parts: ReceiveParts,
  own: ReturnType<typeof ownDepsOf>,
  pause: PauseRecord,
  recipient: string,
  kind: PauseNoticeKind,
): { readonly hook: Hook | undefined; readonly timeout: Milliseconds } {
  const [type, ...rest] = recipient.split(":");
  const name = rest.join(":");
  if (type === "listener") {
    const listener = parts.listenerOf(name);
    if (listener === undefined) throw new UnknownReceiverError(`no listener ${name}`);
    return { hook: listenerHook(listener, kind), timeout: DEFAULT_TOOL_TIMEOUT };
  }
  const sender = own.channelOf?.(name);
  if (sender === undefined) throw new UnknownReceiverError(`no channel ${name}`);
  const timeout = isApprovalPause(pause) ? own.tools(pause.ask.tool).timeout : DEFAULT_TOOL_TIMEOUT;
  return { hook: channelHook(sender.sender, kind), timeout };
}

/** Tells `recipient` the notice of `pause`; resolves when it was told or need not be, else rejects. */
export async function receive(
  parts: ReceiveParts,
  deps: AppDeps,
  input: { readonly recipient: string; readonly pause: PauseRecord; readonly notice: PauseNotice },
): Promise<void> {
  const { recipient, pause, notice } = input;
  const own = ownDepsOf(deps, pause.workflow);
  const { hook, timeout } = hookOf(parts, own, pause, recipient, notice.kind);
  if (hook === undefined) return;
  const mask = own.pii?.observability;
  const masked = async (value: unknown): Promise<unknown> =>
    mask === undefined ? value : mask.value(value);
  const deliveryId = deliveryIdOf(pause, recipient, notice);
  const run = await hook({ pause, notice, deliveryId, masked });
  const tree = await pauseTreeOf(deps, pause, await treeStateOf(deps, pause.rootExecutionId));
  const frame = pauseFrameOf(deps, pause, tree);
  await callInFrame(
    { frame, timeout, clock: parts.clock, interruption: parts.interruption() },
    run,
  );
}
