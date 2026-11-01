import type { Class } from "../../components/injection.js";
import { componentOf } from "../../components/metadata.js";
import { channelRoleOf } from "../../channels/channel-role.decorator.js";
import { replyInterpreterOf } from "../../channels/channel-role.decorator.js";
import { channelUsesOf, type ChannelUse } from "../../channels/discovery.js";
import type { DtoClass } from "../../dto/types.js";
import {
  ToolCallApprovalAskDto,
  ToolCallApprovalDecisionDto,
} from "../../dto/standard/framework.js";
import type { ImportTable } from "./imports.js";
import type { TypeTable, TypeTables } from "./tables.js";

/**
 * The `ChannelRoles` table (#267): per channel role a tool names — and per concrete project
 * `@Channel` a tool names as is — what it asks and how it is answered, so `ChannelAsk<Role>` and
 * `ChannelOutcome<Role>` are typed. The framework's own channels have their entries in the
 * tables module already. A role's reply interpreter (#267 PR 3) gets its `Inputs` entry —
 * `{ ask, reply }` — and its `Outputs` entry — the role's answer — so `InputOf<Self>` /
 * `OutputOf<Self>` type its `interpret` and its scripts.
 */

/** The framework's channels: typed in the tables module, never generated. */
const BUILT_IN_CHANNELS: ReadonlySet<string> = new Set([
  "terminal-user-channel",
  "auto-approve-channel",
  "auto-reject-channel",
]);

/** What a channel asks and how it is answered, as types. */
interface ChannelTypes {
  readonly ask: string;
  readonly answer: string;
}

const entryOf = ({ ask, answer }: ChannelTypes): string =>
  `{ readonly ask: ${ask}; readonly answer: ${answer} }`;

/** The ask and the answer of a tool approval whose arguments are one of `inputs`. */
function approvalTypes(inputs: readonly DtoClass[], names: ImportTable): ChannelTypes {
  const ask = names.dto(ToolCallApprovalAskDto);
  const answer = names.dto(ToolCallApprovalDecisionDto);
  const typed = inputs.map((input) => names.dtoIfExported(input));
  if (typed.some((identifier) => identifier === undefined)) return { ask, answer };
  const args = [...new Set(typed)].sort().join(" | ");
  return {
    ask: `Omit<${ask}, "arguments"> & { readonly arguments: ${args} }`,
    answer: `Omit<${answer}, "overrideArguments"> & { readonly overrideArguments?: ${args} }`,
  };
}

/** A role's name and types, by its form; its interpreter's class, when it has one. */
interface RoleTypes {
  readonly name: string;
  readonly types: ChannelTypes;
  readonly interpreter: Class | undefined;
}

function roleTypesOf(use: ChannelUse, names: ImportTable): RoleTypes | undefined {
  const found = channelRoleOf(use.channel);
  if (found === undefined) return undefined;
  const { options, role } = found;
  names.ref(role);
  const interpreter = options.replyInterpreter;
  const types = approvalTypes([options.approves], names);
  return { name: options.name, types, interpreter };
}

/** The tables of the channels: `ChannelRoles`, and `Inputs` / `Outputs` with the interpreters'. */
export interface ChannelTables {
  readonly channelRoles: TypeTable;
  readonly inputs: TypeTable;
  readonly outputs: TypeTable;
}

/** The `Inputs` and `Outputs` entries of the interpreters, filled as their roles are met. */
interface InterpreterTables {
  readonly inputs: Map<string, string>;
  readonly outputs: Map<string, string>;
}

/** A reply interpreter's entries, keyed by its `name` (its class branded with it). */
function interpreterEntries(role: RoleTypes, names: ImportTable, tables: InterpreterTables): void {
  const { interpreter } = role;
  const name =
    interpreter === undefined ? undefined : replyInterpreterOf(interpreter)?.options.name;
  if (interpreter === undefined || name === undefined) return;
  names.ref(interpreter);
  const { ask, answer } = role.types;
  tables.inputs.set(name, `{ readonly ask: ${ask}; readonly reply: string }`);
  tables.outputs.set(name, answer);
}

/** The name of a concrete project channel a tool names as is (no role, not a built-in). */
function concreteChannelName(cls: Class): string | undefined {
  if (channelRoleOf(cls) !== undefined) return undefined;
  const component = componentOf(cls);
  if (component?.kind !== "channel" || BUILT_IN_CHANNELS.has(component.meta.name)) return undefined;
  return component.meta.name;
}

/**
 * The entries of every role and concrete project channel the workflows' tools name, and the
 * handlers' `Inputs` / `Outputs` (`tables`) with each role's interpreter added.
 */
export function channelTablesOf(
  workflows: readonly Class[],
  names: ImportTable,
  tables: Pick<TypeTables, "inputs" | "outputs">,
): ChannelTables {
  const uses = channelUsesOf(workflows);
  const table = new Map<string, string>();
  const interpreters = { inputs: new Map(tables.inputs), outputs: new Map(tables.outputs) };
  for (const use of uses) {
    const role = roleTypesOf(use, names);
    if (role === undefined) continue;
    table.set(role.name, entryOf(role.types));
    interpreterEntries(role, names, interpreters);
  }
  const concrete = new Map<Class, DtoClass[]>();
  for (const use of uses) {
    if (concreteChannelName(use.channel) === undefined) continue;
    concrete.set(use.channel, [...(concrete.get(use.channel) ?? []), use.toolInput]);
  }
  for (const [cls, inputs] of concrete) {
    const name = concreteChannelName(cls);
    if (name === undefined || names.refIfExported(cls) === undefined) continue;
    table.set(name, entryOf(approvalTypes(inputs, names)));
  }
  return { channelRoles: table, inputs: interpreters.inputs, outputs: interpreters.outputs };
}

/**
 * The `name` a channel class is branded with: its role's, or its own `@Channel` name — and a reply
 * interpreter's, its `@ReplyInterpreter` name.
 */
export function channelBrandOf(cls: Class): string | undefined {
  const interpreter = replyInterpreterOf(cls);
  if (interpreter !== undefined) return interpreter.options.name;
  const found = channelRoleOf(cls);
  if (found?.role === cls) return found.options.name;
  return concreteChannelName(cls);
}
