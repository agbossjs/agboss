import { recordOptionKeys } from "../components/option-keys.js";
import { CHANNEL_SELECTOR_KEYS } from "../components/decorator-options.js";
import type { Class, ResolvedAll, Token } from "../components/injection.js";
import { componentOf, recordComponent } from "../components/metadata.js";
import { resolvedName } from "../flow/names.js";
import type { ChannelSelectContext } from "./pause-contexts.js";

/**
 * `@ChannelSelector` (#1307): picks the `@Channel` of a pause when two or more channels serve one
 * target — `selectChannel(ctx)` returns the channel class. Listed in `@Application({ channelSelectors })`.
 * Choosing at run time is #1307c's: here it is declared, found and checked.
 */

/** `@ChannelSelector({ target, … })` options. */
export interface ChannelSelectorOptions<TDeps extends readonly Token[] = readonly Token[]> {
  /** Kebab-case; the class name in kebab-case when left out. */
  readonly name?: string;
  readonly description?: string;
  /** The `@ToolApproval` or `@ExternalTask` whose channel it picks. */
  readonly target: Class;
  /** Constructor dependencies, in order; checked against the constructor by the compiler. */
  readonly deps?: TDeps;
}

/** What `@ChannelSelector` records about a class. */
export interface ChannelSelectorMeta {
  readonly name: string;
  readonly description?: string;
  readonly target: Class;
  readonly deps: readonly Token[];
}

/** What a selector class declares: `selectChannel`, typed on its target's context. */
export interface ChannelSelectorHandler {
  readonly selectChannel: (ctx: never) => Class | Promise<Class>;
}

/** The selector's context, for a hook's parameter: `ChannelSelectContext<Self>` of its target. */
export type { ChannelSelectContext };

/** `@ChannelSelector({ target })` on a class with `selectChannel(ctx)`. */
export function ChannelSelector<const TDeps extends readonly Token[] = []>(
  options: ChannelSelectorOptions<TDeps>,
) {
  return <TClass extends new (...args: ResolvedAll<TDeps>) => ChannelSelectorHandler>(
    value: TClass,
  ): TClass => {
    recordOptionKeys(value, "ChannelSelector", options, CHANNEL_SELECTOR_KEYS);
    const { description, target } = options;
    const meta = { name: resolvedName(options.name, value), target, deps: options.deps ?? [] };
    recordComponent(value, {
      kind: "channel-selector",
      meta: description === undefined ? meta : { ...meta, description },
    });
    return value;
  };
}

/** What `@ChannelSelector` recorded on a class; `undefined` for any other. */
export function channelSelectorOf(cls: Class): ChannelSelectorMeta | undefined {
  const component = componentOf(cls);
  return component?.kind === "channel-selector" ? component.meta : undefined;
}
