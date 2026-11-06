import type { Class } from "../../components/injection.js";
import { ComponentError } from "../../components/metadata.js";
import type { A2AExportContract, ContractsSnapshot } from "../../describe/contracts-types.js";
import type { JsonSchema } from "../../dto/schema.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../dto/standard/framework.js";
import { NodeKind } from "../../flow/ast.js";
import { declarationOf } from "../../flow/decorators/declaration.js";
import type { WorkflowStartInput } from "../../flow/decorators/workflow-start.js";
import { dtoSchemaHashOf } from "../../flow/runtime/join-keys.js";

/**
 * The skills a listener serves (#808, design §3): one per exported start — its id the start's
 * name —, with what its messages carry (a text start reads text parts, any other one `data` part)
 * and what its finishes give back, each with the JSON Schema `describe --json` lists.
 */

/** A media type of a skill's parts. */
export enum A2AMediaType {
  Text = "text/plain",
  Json = "application/json",
}

/** One finish of a skill: what its artifact carries. */
export interface ServedOutput {
  readonly finish: string;
  readonly mediaType: A2AMediaType;
  readonly schema: JsonSchema | null;
}

/** One exported start, as its skill. */
export interface ServedSkill {
  /** The start's name: the skill's id. */
  readonly id: string;
  readonly start: Class;
  readonly description: string;
  /** The start's declared input, what a message's input is checked against. */
  readonly input: WorkflowStartInput;
  /** What its message carries: text parts (a `WorkflowStartTextDto` start) or one `data` part. */
  readonly inputMediaType: A2AMediaType;
  /** The input's JSON Schema; `null` for a map of fields. */
  readonly inputSchema: JsonSchema | null;
  readonly inputSchemaHash: string | null;
  readonly outputs: readonly ServedOutput[];
}

const schemaOf = (contracts: ContractsSnapshot, dto: string | undefined): JsonSchema | null =>
  dto === undefined ? null : (contracts.schemas[dto]?.jsonSchema ?? null);

const TEXT_FINISH_HASH = (): string => dtoSchemaHashOf(WorkflowFinishTextDto);

function outputsOf(contracts: ContractsSnapshot, found: A2AExportContract): ServedOutput[] {
  const textHash = TEXT_FINISH_HASH();
  return found.outputs.map((output) => ({
    finish: output.finish,
    mediaType: output.schemaHash === textHash ? A2AMediaType.Text : A2AMediaType.Json,
    schema: schemaOf(contracts, output.dto),
  }));
}

/** The skill of one exported start, from its declaration and the application's contracts. */
function skillOf(start: Class, contracts: ContractsSnapshot): ServedSkill {
  const declaration = declarationOf(start);
  if (declaration?.kind !== NodeKind.Start)
    throw new ComponentError(`[a2a.not-a-start] ${start.name} is not a @WorkflowStart`);
  const { name, description, input } = declaration.options;
  const found = contracts.exports.find((entry) => entry.kind === "a2a" && entry.start === name);
  if (found?.kind !== "a2a")
    throw new ComponentError(
      `[application.expose-unknown-start] ${name} is not a start of the application's workflows`,
    );
  return {
    id: name,
    start,
    description,
    input,
    inputMediaType: input === WorkflowStartTextDto ? A2AMediaType.Text : A2AMediaType.Json,
    inputSchema: schemaOf(contracts, found.input?.dto),
    inputSchemaHash: found.input?.schemaHash ?? null,
    outputs: outputsOf(contracts, found),
  };
}

/** The skills of a listener's exports. */
export const servedSkillsOf = (
  exports: readonly Class[],
  contracts: ContractsSnapshot,
): readonly ServedSkill[] => exports.map((start) => skillOf(start, contracts));
