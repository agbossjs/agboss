import type { Class } from "../../components/injection.js";
import { channelInterpreterOf } from "../../channels/channel-interpreter.js";
import { channelUsesOf, type ChannelUse } from "../../channels/discovery.js";
import { findPauseTarget, isExternalTask, pauseTargetOf } from "../../channels/pause-targets.js";
import type { DtoClass } from "../../dto/types.js";
import type { ImportTable } from "./imports.js";
import type { TypeTable, TypeTables } from "./tables.js";

/**
 * The `PauseTargets` table (#1307): per `@ToolApproval` and `@ExternalTask` a tool or a step names,
 * what it asks (`input`) and how it is answered (`output`), so `ChannelAsk<Target>`,
 * `ChannelOutcome<Target>` and the hooks' contexts are typed. A target's channel interpreter
 * (#267 PR 3) gets its `Inputs` entry — `{ ask, reply }` — and its `Outputs` entry — the target's
 * answer — so `InputOf<Self>` / `OutputOf<Self>` type its `interpret` and its scripts.
 */

/** The input of every tool that names each class — what a tool approval with no `input` approves. */
export function gatedInputsOf(uses: readonly ChannelUse[]): Map<Class, DtoClass[]> {
  const gated = new Map<Class, DtoClass[]>();
  for (const use of uses) gated.set(use.target, [...(gated.get(use.target) ?? []), use.toolInput]);
  return gated;
}

/** The union of the DTOs, as the generated file names it; `unknown` for one it cannot name. */
function unionOf(inputs: readonly DtoClass[], names: ImportTable): string {
  const typed = inputs.map((input) => names.dtoIfExported(input));
  return typed.some((identifier) => identifier === undefined)
    ? "unknown"
    : [...new Set(typed)].sort().join(" | ");
}

/** What a target asks and how it is answered, as types. */
interface TargetTypes {
  readonly input: string;
  readonly output: string;
}

/** The types of a target, by its form; a tool approval without `input` takes the union of its gated tools' inputs. */
function targetTypesOf(
  target: Class,
  inputs: readonly DtoClass[],
  names: ImportTable,
): { readonly name: string; readonly types: TargetTypes } | undefined {
  const found = findPauseTarget(target);
  if (found === undefined) return undefined;
  const { options } = found;
  names.ref(target);
  if (isExternalTask(options)) {
    return {
      name: options.name,
      types: { input: names.dto(options.input), output: names.dto(options.output) },
    };
  }
  const input = unionOf(options.input === undefined ? inputs : [options.input], names);
  const decision = `{ readonly approved: boolean; readonly reason?: string; readonly overrideInput?: ${input} }`;
  return { name: options.name, types: { input, output: decision } };
}

/** The tables of the pause targets: `PauseTargets`, and `Inputs` / `Outputs` with the interpreters'. */
export interface PauseTargetTables {
  /** `{ input, output }` per `@ToolApproval` / `@ExternalTask`. */
  readonly pauseTargets: TypeTable;
  readonly inputs: TypeTable;
  readonly outputs: TypeTable;
}

/**
 * The entries of every target the workflows' tools and steps name, and the handlers' `Inputs` /
 * `Outputs` (`tables`) with each target's channel interpreter added.
 */
export function channelTablesOf(
  workflows: readonly Class[],
  names: ImportTable,
  tables: Pick<TypeTables, "inputs" | "outputs">,
): PauseTargetTables {
  const uses = channelUsesOf(workflows);
  const gated = gatedInputsOf(uses);
  const pauseTargets = new Map<string, string>();
  const inputs = new Map(tables.inputs);
  const outputs = new Map(tables.outputs);
  for (const [target, gatedInputs] of gated) {
    const typed = targetTypesOf(target, gatedInputs, names);
    const options = pauseTargetOf(target)?.options;
    if (typed === undefined || options === undefined) continue;
    pauseTargets.set(
      typed.name,
      `{ readonly input: ${typed.types.input}; readonly output: ${typed.types.output} }`,
    );
    const interpreter = options.channelInterpreter;
    const name =
      interpreter === undefined ? undefined : channelInterpreterOf(interpreter)?.options.name;
    if (interpreter === undefined || name === undefined) continue;
    names.ref(interpreter);
    inputs.set(name, `{ readonly ask: ${typed.types.input}; readonly reply: string }`);
    outputs.set(name, typed.types.output);
  }
  return { pauseTargets, inputs, outputs };
}

/**
 * The `name` a pause target class is branded with, and a channel interpreter's: its `@ChannelInterpreter`
 * name — `undefined` for any other class.
 */
export function channelBrandOf(cls: Class): string | undefined {
  const interpreter = channelInterpreterOf(cls);
  if (interpreter !== undefined) return interpreter.options.name;
  return pauseTargetOf(cls)?.options.name;
}
