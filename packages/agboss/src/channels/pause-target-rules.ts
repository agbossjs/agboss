import type { ProviderModule } from "../components/container/registrations.js";
import type { Class } from "../components/injection.js";
import type { ComponentOptions } from "../components/component-options.js";
import { EXECUTION_LEASE } from "../app/lease-fence.js";
import { kindSuffixProblem, NameKind } from "../flow/names.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import { channelSelectorOf } from "./channel-selector.js";
import type { ChannelUse } from "./discovery.js";
import { ignoredSettingViolations, targetsOf } from "./pause-setting-rules.js";
import {
  channelTargetOf,
  listedClassesOf,
  pauseTargetOf,
  PauseRespondent,
  type PauseTargetDeclaration,
} from "./pause-targets.js";

/**
 * The assembly rules of the pause targets (#1307): a target used by a tool or a step has a channel
 * (`[channel.missing-for-target]`) — one, or several with a `@ChannelSelector`
 * (`[channel.ambiguous-for-target]`); a `@Channel({ target })` names a target and a `ttl` longer than
 * the execution lease; an `escalatesTo` target is of the same kind and DTOs
 * (`[pause.incompatible-escalation-target]`); a `@ChannelSelector` names a target and has
 * `selectChannel`. A target answered by `PauseRespondent.Delegate` needs a channel; an owner's needs none (#1307c).
 */

const nameOf = (cls: Class): string => cls.name || "(anonymous class)";

/** `[channel.missing-for-target]` / `[channel.ambiguous-for-target]` for each target in use. */
function bindingViolations(
  uses: readonly ChannelUse[],
  modules: readonly ProviderModule[],
): RuleViolation[] {
  const listed = listedClassesOf(modules);
  return targetsOf(uses).flatMap(([target, { options }]) => {
    const channels = listed.filter(
      (cls) =>
        channelTargetOf(cls) === target ||
        Object.prototype.isPrototypeOf.call(target.prototype, cls.prototype),
    );
    const selectors = listed.filter((cls) => channelSelectorOf(cls)?.target === target);
    // an owner's pause needs no channel (#1307c): it asks nobody and waits for the owner's resume
    if (channels.length === 0 && options.respondent === PauseRespondent.Owner) return [];
    if (channels.length === 0) {
      return [
        violation(
          "channel.missing-for-target",
          `${nameOf(target)} (${options.name}) has no channel — list a @Channel({ target: ${nameOf(target)} }) class in @Application({ channels })`,
          [options.name],
        ),
      ];
    }
    if (channels.length > 1 && selectors.length === 0) {
      return [
        violation(
          "channel.ambiguous-for-target",
          `${nameOf(target)} (${options.name}) has ${String(channels.length)} channels: ${channels.map(nameOf).join(", ")} — add a @ChannelSelector({ target: ${nameOf(target)} }) that picks one, or list one`,
          [options.name],
        ),
      ];
    }
    return [];
  });
}

/** `[channel.target-invalid]` / `[channel.ttl-invalid]` over every listed `@Channel({ target })`. */
function channelViolations(
  modules: readonly ProviderModule[],
  options: ComponentOptions,
): RuleViolation[] {
  return listedClassesOf(modules).flatMap((cls) => {
    const meta = options.channelMetaOf(cls);
    if (meta === undefined) return [];
    const { name, target, ttl } = meta;
    if (target === undefined) return [];
    const found: RuleViolation[] = [];
    if (pauseTargetOf(target) === undefined) {
      found.push(
        violation(
          "channel.target-invalid",
          `channel ${name} (${nameOf(cls)}) names ${nameOf(target)} as its target, which is no @ToolApproval or @ExternalTask`,
          [name],
        ),
      );
    }
    if (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl <= EXECUTION_LEASE) {
      found.push(
        violation(
          "channel.ttl-invalid",
          `channel ${name} (${nameOf(cls)}): ttl must be a finite duration longer than the execution lease (30 s) — days(14) keeps a closed pause two weeks`,
          [name],
        ),
      );
    }
    return found;
  });
}

/** `[channel-selector.*]` over every listed `@ChannelSelector`. */
function selectorViolations(modules: readonly ProviderModule[]): RuleViolation[] {
  return listedClassesOf(modules).flatMap((cls) => {
    const meta = channelSelectorOf(cls);
    if (meta === undefined) return [];
    const found: RuleViolation[] = [];
    if (typeof Reflect.get(cls.prototype as object, "selectChannel") !== "function") {
      found.push(
        violation(
          "channel-selector.no-select-method",
          `${nameOf(cls)} (@ChannelSelector "${meta.name}") has no selectChannel(ctx) method`,
          [meta.name],
        ),
      );
    }
    if (pauseTargetOf(meta.target) === undefined) {
      found.push(
        violation(
          "channel-selector.target-invalid",
          `${nameOf(cls)} (@ChannelSelector "${meta.name}") names ${nameOf(meta.target)}, which is no @ToolApproval or @ExternalTask`,
          [meta.name],
        ),
      );
    }
    return found;
  });
}

/** Whether `to` can take the pauses `from` opened: the same kind, and the same DTOs. */
function isCompatible(from: PauseTargetDeclaration, to: PauseTargetDeclaration): boolean {
  if (from.kind === "tool-approval" && to.kind === "tool-approval") {
    const { input } = to.options;
    return input === undefined || from.options.input === undefined || input === from.options.input;
  }
  if (from.kind === "external-task" && to.kind === "external-task") {
    return from.options.input === to.options.input && from.options.output === to.options.output;
  }
  return false;
}

/** `[pause.incompatible-escalation-target]` over each target's `escalatesTo`. */
function escalationViolations(uses: readonly ChannelUse[]): RuleViolation[] {
  return targetsOf(uses).flatMap(([target, declaration]) =>
    (declaration.options.escalatesTo ?? []).flatMap((to) => {
      const found = pauseTargetOf(to);
      if (found !== undefined && isCompatible(declaration, found)) return [];
      const why =
        found === undefined
          ? "is no @ToolApproval or @ExternalTask"
          : "is of another kind or takes other DTOs";
      return [
        violation(
          "pause.incompatible-escalation-target",
          `${declaration.options.name} escalates to ${nameOf(to)}, which ${why} — a pause can move only to a target of its kind with the same input${declaration.kind === "external-task" ? " and output" : ""} (${nameOf(target)})`,
          [declaration.options.name],
        ),
      ];
    }),
  );
}

/** `[name.kind-suffix]` of a `@ToolApproval` (an `@ExternalTask`'s is the flow's node rule). */
function nameViolations(uses: readonly ChannelUse[]): RuleViolation[] {
  return targetsOf(uses).flatMap(([, declaration]) => {
    if (declaration.kind !== "tool-approval") return [];
    const problem = kindSuffixProblem(declaration.options.name, NameKind.ToolApproval);
    return problem === undefined
      ? []
      : [violation(problem.code, problem.message, [declaration.options.name])];
  });
}

/** The permission hooks no runtime path calls yet, and who wires each (see `permitHookViolations`). */
const UNENFORCED_PERMIT_HOOKS = ["permitTimeoutChange", "permitReassign"] as const;

/**
 * `[pause.permit-hook-not-enforced]`: fail closed. `permitTimeoutChange` and `permitReassign` are
 * declared on a target, but no timeout change or reassignment calls them yet — one that returns
 * `false` would refuse nothing. Until each is wired, a target that defines one fails assembly.
 * #1307d removes both (setPauseTimeout, reassignPause) when it wires the call with deny-on-false and
 * deny-on-throw. `permitAnswer` is wired (#1307c): `app.resume` calls it before an answer is recorded.
 */
function permitHookViolations(uses: readonly ChannelUse[]): RuleViolation[] {
  return targetsOf(uses).flatMap(([target, { options }]) =>
    UNENFORCED_PERMIT_HOOKS.filter(
      (hook) => typeof Reflect.get(target.prototype as object, hook) === "function",
    ).map((hook) =>
      violation(
        "pause.permit-hook-not-enforced",
        `${nameOf(target)} (${options.name}) defines ${hook}, which nothing calls yet — it would refuse nothing; remove it until the runtime enforces it`,
        [options.name],
      ),
    ),
  );
}

/** Every rule of the pause targets a workflow's uses name, over the providers it sees. */
export function pauseTargetViolations(
  uses: readonly ChannelUse[],
  modules: readonly ProviderModule[],
  options: ComponentOptions,
): RuleViolation[] {
  return [
    ...nameViolations(uses),
    ...permitHookViolations(uses),
    ...ignoredSettingViolations(uses, modules, options),
    ...bindingViolations(uses, modules),
    ...channelViolations(modules, options),
    ...selectorViolations(modules),
    ...escalationViolations(uses),
  ];
}
