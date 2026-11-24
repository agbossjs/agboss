import type { ProviderModule } from "../components/container/registrations.js";
import type { Class } from "../components/injection.js";
import type { ComponentOptions } from "../components/component-options.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import { channelSelectorOf } from "./channel-selector.js";
import { targetsOfUses, type ChannelUse } from "./discovery.js";
import { listedClassesOf, type PauseTargetDeclaration } from "./pause-targets.js";

/** The pause targets the uses name (each once), with what they recorded. */
export const targetsOf = (
  uses: readonly ChannelUse[],
): readonly [Class, PauseTargetDeclaration][] =>
  targetsOfUses(uses).map(
    ({ target, declaration }) => [target, declaration] as [Class, PauseTargetDeclaration],
  );

const nameOf = (cls: Class): string => cls.name || "(anonymous class)";

/** The hooks of a target no runtime path calls yet (1307c/1307d wire them and remove each). */
const UNCALLED_HOOKS = ["assign", "resolveTimeout"] as const;

const ignored = (what: string, name: string, owner: string): RuleViolation =>
  violation(
    "pause.setting-not-enforced",
    `${owner} (${name}) sets ${what}, which nothing reads yet — it would be silently ignored; remove it until the runtime enforces it`,
    [name],
  );

/**
 * `[pause.setting-not-enforced]`: fail closed. A setting a target, a selector or a channel declares
 * that no runtime path reads yet would be silently ignored — an `assign` that restricts nobody, an
 * `escalationLimits` that limits nothing, a `@ChannelSelector` that picks nothing, a channel
 * `timeout` that bounds nothing. Refused until the ticket that wires it removes its line here:
 * #1307c (assign, resolveTimeout, the selector), #1307d (escalationLimits), the channel call
 * timeout with the channel runtime.
 */
export function ignoredSettingViolations(
  uses: readonly ChannelUse[],
  modules: readonly ProviderModule[],
  options: ComponentOptions,
): RuleViolation[] {
  const ofTargets = targetsOf(uses).flatMap(([target, { options }]) => [
    ...UNCALLED_HOOKS.filter(
      (hook) => typeof Reflect.get(target.prototype as object, hook) === "function",
    ).map((hook) => ignored(`the hook ${hook}`, options.name, nameOf(target))),
    ...(options.escalationLimits === undefined
      ? []
      : [ignored("escalationLimits", options.name, nameOf(target))]),
  ]);
  const listed = listedClassesOf(modules);
  const ofSelectors = listed.flatMap((cls) => {
    const meta = channelSelectorOf(cls);
    return meta === undefined ? [] : [ignored("a @ChannelSelector", meta.name, nameOf(cls))];
  });
  const ofChannels = listed.flatMap((cls) => {
    const meta = options.channelMetaOf(cls);
    return meta?.timeout !== undefined ? [ignored("timeout", meta.name, nameOf(cls))] : [];
  });
  return [...ofTargets, ...ofSelectors, ...ofChannels];
}
