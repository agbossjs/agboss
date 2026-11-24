import { recordOptionKeys } from "../components/option-keys.js";
import { CHANNEL_LISTENER_KEYS } from "../components/decorator-options.js";
import type { Class, ResolvedAll, Token } from "../components/injection.js";
import type { Provider } from "../components/injection.js";
import { isClassProvider } from "../components/injection.js";
import { componentOf, recordComponent } from "../components/metadata.js";
import { kebabNameProblem, resolvedName } from "../flow/names.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
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
 * `@ChannelListener` (#1310c, #1307a): an application-wide listener of every pause, listed in
 * `@Application({ channelListeners })`, created by the application's container at start (its
 * `onInit` / `onStart` run with the application's), one instance. Notices are written with the
 * pause's change and delivered at least once, in order per pause, by any instance (Wiki → Pauses).
 * Every hook is optional: a class that cares only for `onPauseExpiring` writes that alone, no
 * `implements`, no stubs.
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

/** What `@ChannelListener` records about a class. */
export interface ChannelListenerMeta {
  readonly name: string;
  readonly description?: string;
  readonly deps: readonly Token[];
  readonly includePauseIds: boolean;
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
      includePauseIds,
    } as const;
    recordComponent(value, {
      kind: "channel-listener",
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

/** What `@ChannelListener` recorded on a class; `undefined` when it is not a listener. */
export function channelListenerOf(cls: Class): ChannelListenerMeta | undefined {
  const component = componentOf(cls);
  return component?.kind === "channel-listener" ? component.meta : undefined;
}

const classNameOf = (cls: Class): string => cls.name || "(anonymous class)";

/** The listener classes among an application's providers, in the order listed. */
export const listenersOf = (providers: readonly Provider[] | undefined): readonly Class[] =>
  (providers ?? []).flatMap((provider) => {
    const cls = isClassProvider(provider) ? provider.useClass : provider;
    return typeof cls === "function" && channelListenerOf(cls) !== undefined ? [cls] : [];
  });

/** `[channel-listener.missing-handler]` / `[channel-listener.unknown-hook]` of one `@ChannelListener`. */
function handlerViolations(cls: Class, name: string, application: string): RuleViolation[] {
  const unknown = unknownListenerHooksOf(cls);
  const found = unknown.map((hook) =>
    violation(
      "channel-listener.unknown-hook",
      `${classNameOf(cls)} (@ChannelListener "${name}") has ${hook}, which is no listener hook — the hooks are ${CHANNEL_LISTENER_HOOKS.join(", ")}`,
      [application],
    ),
  );
  const hasHook = CHANNEL_LISTENER_HOOKS.some(
    (hook) => typeof Reflect.get(cls.prototype as object, hook) === "function",
  );
  if (hasHook) return found;
  const message = `${classNameOf(cls)} (@ChannelListener "${name}") has none of the hooks ${CHANNEL_LISTENER_HOOKS.join(", ")} — it would be told nothing`;
  return [violation("channel-listener.missing-handler", message, [application]), ...found];
}

/**
 * The rules of the listeners an application lists: a kebab-case name (`[name.not-kebab-case]`),
 * one class per name (`[channel-listener.duplicate-name]`) and at least one hook.
 */
export function channelListenerRuleViolations(
  application: string,
  providers: readonly Provider[] | undefined,
): RuleViolation[] {
  const byName = new Map<string, Class[]>();
  const found: RuleViolation[] = [];
  for (const cls of listenersOf(providers)) {
    const name = channelListenerOf(cls)?.name ?? "";
    byName.set(name, [...(byName.get(name) ?? []), cls]);
    const problem = kebabNameProblem(name, "@ChannelListener");
    if (problem !== undefined) found.push(violation(problem.code, problem.message, [application]));
    found.push(...handlerViolations(cls, name, application));
  }
  for (const [name, classes] of byName) {
    if (classes.length < 2) continue;
    const message = `"${name}" names ${classes.map(classNameOf).join(" and ")} in ${application}'s providers — give each its own name`;
    found.push(violation("channel-listener.duplicate-name", message, [application]));
  }
  return found;
}
