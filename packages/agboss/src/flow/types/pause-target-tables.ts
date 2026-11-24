import type { Class } from "../../components/injection.js";
import { channelRoleOf, isQuestionRole } from "../../channels/channel-role.decorator.js";
import type { ChannelUse } from "../../channels/discovery.js";
import { pauseTargetOf } from "../../channels/pause-targets.js";
import type { DtoClass } from "../../dto/types.js";
import type { ImportTable } from "./imports.js";
import type { TypeTable } from "./tables.js";

/** The input of every tool that names each class — what a tool approval with no `input` approves. */
export function gatedInputsOf(uses: readonly ChannelUse[]): Map<Class, DtoClass[]> {
  const gated = new Map<Class, DtoClass[]>();
  for (const use of uses)
    gated.set(use.channel, [...(gated.get(use.channel) ?? []), use.toolInput]);
  return gated;
}

/** The union of the DTOs, as the generated file names it; `unknown` for one it cannot name. */
function unionOf(inputs: readonly DtoClass[], names: ImportTable): string {
  const typed = inputs.map((input) => names.dtoIfExported(input));
  return typed.some((identifier) => identifier === undefined)
    ? "unknown"
    : [...new Set(typed)].sort().join(" | ");
}

/** `{ input, output }` of the `@ToolApproval`s and `@ExternalTask`s the uses name (#1307). */
export function pauseTargetEntriesOf(
  gated: ReadonlyMap<Class, readonly DtoClass[]>,
  names: ImportTable,
): TypeTable {
  const entries = new Map<string, string>();
  for (const [channel, inputs] of gated) {
    const found = channelRoleOf(channel);
    if (found === undefined || pauseTargetOf(found.role) === undefined) continue;
    const { options, role } = found;
    names.ref(role);
    if (isQuestionRole(options)) {
      const output = names.dto(options.answer);
      entries.set(
        options.name,
        `{ readonly input: ${names.dto(options.ask)}; readonly output: ${output} }`,
      );
      continue;
    }
    // a tool approval without `input` gates any tool: the union of its gated tools' inputs
    const input = unionOf(options.approves === undefined ? inputs : [options.approves], names);
    const decision = `{ readonly approved: boolean; readonly reason?: string; readonly overrideInput?: ${input} }`;
    entries.set(options.name, `{ readonly input: ${input}; readonly output: ${decision} }`);
  }
  return entries;
}
