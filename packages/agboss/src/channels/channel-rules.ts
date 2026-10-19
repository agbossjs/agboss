import type { ProviderModule } from "../components/container/registrations.js";
import type { Class } from "../components/injection.js";
import { GraphRuleError, violation, type RuleViolation } from "../graph/rule-error.js";
import { channelRoleOf } from "./channel-role.decorator.js";
import { replyInterpreterViolations } from "./discovery.js";
import {
  channelNameOf,
  channelUsesOf,
  isChannelRole,
  rolesOf,
  type ChannelUse,
} from "./discovery.js";

/**
 * The assembly rules of channels (#267): a tool's input is the `approves` of its role
 * (`[channel.wrong-tool]`), a role has one implementation among the providers
 * (`[di.missing-implementation]`, `[di.ambiguous-implementation]`), a reply interpreter belongs
 * to one role (`[channel.shared-interpreter]`) and is a valid `@ReplyInterpreter` (#267 PR 3). All
 * violations at once.
 */

const nameOf = (cls: Class): string => cls.name || "(anonymous class)";

/** The listed classes that extend `role` (the role itself is not its implementation). */
export function implementationsOf(role: Class, modules: readonly ProviderModule[]): Class[] {
  const listed = modules.flatMap((module) =>
    module.providers.flatMap((provider) => (typeof provider === "function" ? [provider] : [])),
  );
  return [...new Set(listed)].filter(
    (cls) => cls !== role && Object.prototype.isPrototypeOf.call(role.prototype, cls.prototype),
  );
}

/** A tool approved through a role must take the role's `approves` DTO; a question role approves none. */
function wrongToolViolations(uses: readonly ChannelUse[]): RuleViolation[] {
  return uses.flatMap((use) => {
    const found = channelRoleOf(use.channel);
    if (found === undefined) return [];
    const { approves, name } = found.options;
    if (approves === use.toolInput) return [];
    const why =
      approves === undefined
        ? `${name} asks a question (ask / answer), it approves no tool`
        : `${name} approves ${nameOf(approves)}`;
    return [
      violation(
        "channel.wrong-tool",
        `tool ${use.tool} (input ${nameOf(use.toolInput)}) names channel ${nameOf(use.channel)}, but ${why} — name a role whose approves is ${nameOf(use.toolInput)}`,
        [use.tool, name],
      ),
    ];
  });
}

/** Every role a tool names has exactly one implementation among the providers. */
function implementationViolations(
  uses: readonly ChannelUse[],
  modules: readonly ProviderModule[],
): RuleViolation[] {
  const roles = [...new Set(uses.map((use) => use.channel))].filter(isChannelRole);
  return roles.flatMap((role) => {
    const found = implementationsOf(role, modules);
    const name = channelNameOf(role);
    if (found.length === 1) return [];
    if (found.length === 0) {
      return [
        violation(
          "di.missing-implementation",
          `channel role ${nameOf(role)} (${name}) has no implementation — list a @Channel class that extends ${nameOf(role)} in @Application({ providers })`,
          [name],
        ),
      ];
    }
    return [
      violation(
        "di.ambiguous-implementation",
        `channel role ${nameOf(role)} (${name}) has ${String(found.length)} implementations: ${found.map(nameOf).join(", ")} — list one (one question to several places is one implementation that sends to each)`,
        [name],
      ),
    ];
  });
}

/** One reply interpreter belongs to one role, so its input and output are exact. */
export function sharedInterpreterViolations(uses: readonly ChannelUse[]): RuleViolation[] {
  const byInterpreter = new Map<Class, string[]>();
  for (const { options } of rolesOf(uses)) {
    if (options.replyInterpreter === undefined) continue;
    const names = byInterpreter.get(options.replyInterpreter) ?? [];
    byInterpreter.set(options.replyInterpreter, [...names, options.name]);
  }
  return [...byInterpreter].flatMap(([interpreter, roles]) =>
    roles.length < 2
      ? []
      : [
          violation(
            "channel.shared-interpreter",
            `reply interpreter ${nameOf(interpreter)} is used by ${roles.join(" and ")} — an interpreter belongs to one role; give each role its own`,
            roles,
          ),
        ],
  );
}

/** The rules of one workflow's channels (its children included) over the providers it sees. */
export function channelRuleViolations(
  uses: readonly ChannelUse[],
  modules: readonly ProviderModule[],
): RuleViolation[] {
  return [
    ...wrongToolViolations(uses),
    ...implementationViolations(uses, modules),
    ...replyInterpreterViolations(uses),
  ];
}

/**
 * The channels of one workflow (#267), its children's included, checked at its assembly: each
 * tool's input is its role's `approves`, each role has one implementation among the providers; a
 * workflow on its own also one interpreter per role (an application checks that across workflows).
 */
export function checkChannels(
  workflow: Class,
  modules: readonly ProviderModule[],
  isStandalone: boolean,
): void {
  const uses = channelUsesOf([workflow]);
  const violations = [
    ...channelRuleViolations(uses, modules),
    ...(isStandalone ? sharedInterpreterViolations(uses) : []),
  ];
  if (violations.length > 0) throw new GraphRuleError(violations);
}
