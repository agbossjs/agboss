import type { Class } from "../../components/injection.js";
import { componentOf } from "../../components/metadata.js";
import { channelRoleOf } from "../../channels/channel-role.decorator.js";
import { channelUsesOf, type ChannelUse } from "../../channels/discovery.js";
import type { DtoClass } from "../../dto/types.js";
import {
  ToolCallApprovalAskDto,
  ToolCallApprovalDecisionDto,
} from "../../dto/standard/framework.js";
import type { ImportTable } from "./imports.js";
import type { TypeTable } from "./tables.js";

/**
 * The `ChannelRoles` table (#267): per channel role a tool names — and per concrete project
 * `@Channel` a tool names as is — what it asks and how it is answered, so `ChannelAsk<Role>` and
 * `ChannelOutcome<Role>` are typed. The framework's own channels have their entries in the
 * tables module already.
 */

/** The framework's channels: typed in the tables module, never generated. */
const BUILT_IN_CHANNELS: ReadonlySet<string> = new Set([
  "terminal-user-channel",
  "auto-approve-channel",
  "auto-reject-channel",
]);

/** The ask and the answer of a tool approval whose arguments are one of `inputs`. */
function approvalEntry(inputs: readonly DtoClass[], names: ImportTable): string {
  const ask = names.dto(ToolCallApprovalAskDto);
  const answer = names.dto(ToolCallApprovalDecisionDto);
  const typed = inputs.map((input) => names.dtoIfExported(input));
  if (typed.some((identifier) => identifier === undefined))
    return `{ readonly ask: ${ask}; readonly answer: ${answer} }`;
  const args = [...new Set(typed)].sort().join(" | ");
  return [
    `{ readonly ask: Omit<${ask}, "arguments"> & { readonly arguments: ${args} };`,
    `readonly answer: Omit<${answer}, "overrideArguments"> & { readonly overrideArguments?: ${args} } }`,
  ].join(" ");
}

/** A role's entry, by its form. */
function roleEntry(use: ChannelUse, names: ImportTable): [string, string] | undefined {
  const found = channelRoleOf(use.channel);
  if (found === undefined) return undefined;
  const { options, role } = found;
  names.ref(role);
  if (options.approves !== undefined)
    return [options.name, approvalEntry([options.approves], names)];
  const ask = names.dto(options.ask);
  return [options.name, `{ readonly ask: ${ask}; readonly answer: ${names.dto(options.answer)} }`];
}

/** The name of a concrete project channel a tool names as is (no role, not a built-in). */
function concreteChannelName(cls: Class): string | undefined {
  if (channelRoleOf(cls) !== undefined) return undefined;
  const component = componentOf(cls);
  if (component?.kind !== "channel" || BUILT_IN_CHANNELS.has(component.meta.name)) return undefined;
  return component.meta.name;
}

/** The entries of every role and concrete project channel the workflows' tools name. */
export function channelRoleTable(workflows: readonly Class[], names: ImportTable): TypeTable {
  const uses = channelUsesOf(workflows);
  const table = new Map<string, string>();
  for (const use of uses) {
    const entry = roleEntry(use, names);
    if (entry !== undefined) table.set(...entry);
  }
  const concrete = new Map<Class, DtoClass[]>();
  for (const use of uses) {
    if (concreteChannelName(use.channel) === undefined) continue;
    concrete.set(use.channel, [...(concrete.get(use.channel) ?? []), use.toolInput]);
  }
  for (const [cls, inputs] of concrete) {
    const name = concreteChannelName(cls);
    if (name === undefined || names.refIfExported(cls) === undefined) continue;
    table.set(name, approvalEntry(inputs, names));
  }
  return table;
}

/** The `name` a channel class is branded with: its role's, or its own `@Channel` name. */
export function channelBrandOf(cls: Class): string | undefined {
  const found = channelRoleOf(cls);
  if (found?.role === cls) return found.options.name;
  return concreteChannelName(cls);
}
