import { recordOptionKeys } from "../components/option-keys.js";
import { CHANNEL_LISTENER_KEYS } from "../components/decorator-options.js";
import type { Class, ResolvedAll, Token } from "../components/injection.js";
import { recordComponent } from "../components/metadata.js";
import { resolvedName } from "../flow/names.js";
import type {
  ChannelListenerAnswerNotTakenEvent,
  ChannelListenerClosedEvent,
  ChannelListenerExpiringEvent,
  ChannelListenerJoinFailedEvent,
  ChannelListenerOpenedEvent,
  ChannelListenerReassignedEvent,
  ChannelListenerTimeoutChangedEvent,
} from "./notice-events.js";

/**
 * `@ChannelListener` (#1310c, #1307a): an application-wide listener of every pause — the new name
 * of `@PauseListener`, listed in `@Application({ channelListeners })`. Every hook is optional: a
 * class that cares only for `onPauseExpiring` writes that alone, no `implements`, no stubs.
 */

/** The hooks a `@ChannelListener` class may have, each optional (a typo is `[channel-listener.unknown-hook]`). */
export interface ChannelListenerHandler {
  onPauseOpened?(event: ChannelListenerOpenedEvent): void | Promise<void>;
  onPauseClosed?(event: ChannelListenerClosedEvent): void | Promise<void>;
  onPauseExpiring?(event: ChannelListenerExpiringEvent): void | Promise<void>;
  onPauseTimeoutChanged?(event: ChannelListenerTimeoutChangedEvent): void | Promise<void>;
  onPauseReassigned?(event: ChannelListenerReassignedEvent): void | Promise<void>;
  onPauseAnswerNotTaken?(event: ChannelListenerAnswerNotTakenEvent): void | Promise<void>;
  onPauseJoinFailed?(event: ChannelListenerJoinFailedEvent): void | Promise<void>;
}

/** The names of the hooks (what the typo check compares `onPause*` methods with). */
export const CHANNEL_LISTENER_HOOKS: readonly string[] = [
  "onPauseOpened",
  "onPauseClosed",
  "onPauseExpiring",
  "onPauseTimeoutChanged",
  "onPauseReassigned",
  "onPauseAnswerNotTaken",
  "onPauseJoinFailed",
];

/** `@ChannelListener({ … })` options; `@ChannelListener()` takes none. */
export interface ChannelListenerOptions<TDeps extends readonly Token[] = readonly Token[]> {
  /** Kebab-case, unique in the application; the class name in kebab-case when left out. */
  readonly name?: string;
  readonly description?: string;
  /** The constructor's dependencies, in order (compiler-checked), injected by the container. */
  readonly deps?: TDeps;
  /**
   * Trusted to answer: its events carry the raw `pauseId` of delegate pauses — by default a
   * listener gets `pauseKey`, a correlation key that answers nothing.
   */
  readonly includePauseIds?: boolean;
}

/** `@ChannelListener({ name?, deps?, includePauseIds? })` on a class with some of the hooks. */
export function ChannelListener<const TDeps extends readonly Token[] = []>(
  options: ChannelListenerOptions<TDeps> = {},
) {
  return <TClass extends new (...args: ResolvedAll<TDeps>) => object & ChannelListenerHandler>(
    value: TClass,
  ): TClass => {
    recordOptionKeys(value, "ChannelListener", options, CHANNEL_LISTENER_KEYS);
    const { description, includePauseIds = false } = options;
    const meta = {
      name: resolvedName(options.name, value),
      deps: options.deps ?? [],
      allowAnswering: includePauseIds,
      hooksOptional: true,
    } as const;
    recordComponent(value, {
      kind: "pause-listener",
      meta: description === undefined ? meta : { ...meta, description },
    });
    return value;
  };
}

/** The `onPause*` methods a class has beyond the listener hooks (typos, or a hook of another receiver). */
export function unknownListenerHooksOf(cls: Class): readonly string[] {
  const names = new Set<string>();
  for (
    let proto: object | null = cls.prototype as object;
    proto !== null && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto) as object | null
  ) {
    for (const key of Object.getOwnPropertyNames(proto)) names.add(key);
  }
  return [...names].filter(
    (key) => key.startsWith("onPause") && !CHANNEL_LISTENER_HOOKS.includes(key),
  );
}
