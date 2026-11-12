import type { Class } from "../../components/injection.js";
import { ComponentError } from "../../components/metadata.js";
import { fieldsOf } from "../../dto/metadata.js";
import type { A2AExportContract, ContractsSnapshot } from "../../describe/contracts-types.js";
import type { JsonSchema } from "../../dto/schema.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../dto/standard/framework.js";
import { NodeKind } from "../../flow/ast.js";
import { declarationOf } from "../../flow/decorators/declaration.js";
import type { WorkflowStartInput } from "../../flow/decorators/workflow-start.js";
import { dtoSchemaHashOf } from "../../flow/runtime/join-keys.js";
import type { DtoClass } from "../../dto/types.js";
import { finishDtosOf } from "../files/a2a-file-tier.js";
import { workflowPartsOf } from "../../describe/contracts-parts.js";
import { DecidedBy } from "../../flow/decorators/router.js";
import type { A2AReply } from "../a2a-expose.decorator.js";
import type { A2ACardFileFields } from "../files/a2a-file-options.js";
import type { A2AExposeOptions } from "../a2a-expose.decorator.js";
import { fileFieldsOf, type A2AFileField } from "../files/a2a-file.dto.js";
import {
  fileLimitsOf,
  type A2AFileLimits,
  type A2AFileOptions,
} from "../files/a2a-file-options.js";

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
  /** Its DTO's fields that hold files (#859): each one's parts are file parts. */
  readonly fileFields: readonly A2AFileField[];
  /** Whether its DTO has a field that holds no file: what its `data` part carries. */
  readonly hasData: boolean;
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
  /** The input DTO's fields that hold files (#859): none — no file part is taken (`-32005`). */
  readonly inputFiles: readonly A2AFileField[];
  /** What its files are bounded by: the skill's own, else the application's, else the defaults. */
  readonly fileLimits: A2AFileLimits;
  /**
   * The media types its finishes' files may be (#904): what `A2AFiles.save` takes — the
   * application's `a2aFiles`, else the defaults; a skill's own `files` bound what it takes only.
   */
  readonly outputFileMediaTypes: readonly string[];
  /** How it answers (#860): a task, or a direct message. */
  readonly reply: A2AReply;
  /** How its card describes its file fields (#904). */
  readonly cardFileFields: A2ACardFileFields;
  /** Whether its workflow can call a model (an agent, a model router): a lost reply's cost is unknown. */
  readonly callsModel: boolean;
}

/** Whether a node calls a model: an agent, or a router its model decides. */
function callsModel(node: Class): boolean {
  const declared = declarationOf(node);
  if (declared?.kind === NodeKind.Agent) return true;
  return declared?.kind === NodeKind.Router && declared.options.decidedBy !== DecidedBy.Code;
}

const schemaOf = (contracts: ContractsSnapshot, dto: string | undefined): JsonSchema | null =>
  dto === undefined ? null : (contracts.schemas[dto]?.jsonSchema ?? null);

const TEXT_FINISH_HASH = (): string => dtoSchemaHashOf(WorkflowFinishTextDto);

/** A DTO's own fields that hold no file. */
const dataFieldCountOf = (dto: DtoClass | undefined): number =>
  dto === undefined ? 1 : fieldsOf(dto).length - fileFieldsOf(dto).length;

function outputsOf(
  contracts: ContractsSnapshot,
  found: A2AExportContract,
  finishes: ReadonlyMap<string, DtoClass>,
): ServedOutput[] {
  const textHash = TEXT_FINISH_HASH();
  return found.outputs.map((output) => {
    const dto = finishes.get(output.finish);
    return {
      finish: output.finish,
      mediaType: output.schemaHash === textHash ? A2AMediaType.Text : A2AMediaType.Json,
      schema: schemaOf(contracts, output.dto),
      fileFields: dto === undefined ? [] : fileFieldsOf(dto),
      hasData: dataFieldCountOf(dto) > 0,
    };
  });
}

/** Whether the workflow of `start` can call a model. */
const startCallsModel = (start: Class, workflows: readonly Class[]): boolean =>
  (workflowPartsOf(workflows).find((part) => part.nodes.includes(start))?.nodes ?? []).some(
    callsModel,
  );

/** What a listener's skills are built from besides the exports. */
export interface SkillSources {
  readonly contracts: ContractsSnapshot;
  /** The application's workflows: where each start's finishes are. */
  readonly workflows: readonly Class[];
  readonly expose: A2AExposeOptions;
  /** `@Application({ a2aFiles })`. */
  readonly files: A2AFileOptions | undefined;
}

/** The skill of one exported start, from its declaration and the application's contracts. */
function skillOf(start: Class, sources: SkillSources): ServedSkill {
  const { contracts } = sources;
  const declaration = declarationOf(start);
  if (declaration?.kind !== NodeKind.Start)
    throw new ComponentError({
      message: `[a2a.not-a-start] ${start.name} is not a @WorkflowStart`,
    });
  const { name, description, input } = declaration.options;
  const found = contracts.exports.find(
    (entry) => entry.kind === "a2a" && entry.start === name && entry.expose === sources.expose.name,
  );
  if (found?.kind !== "a2a")
    throw new ComponentError({
      message: `[application.expose-unknown-start] ${name} is not a start of the application's workflows`,
    });
  return {
    id: name,
    start,
    description,
    input,
    inputMediaType: input === WorkflowStartTextDto ? A2AMediaType.Text : A2AMediaType.Json,
    inputSchema: schemaOf(contracts, found.input?.dto),
    inputSchemaHash: found.input?.schemaHash ?? null,
    outputs: outputsOf(contracts, found, finishDtosOf(start, sources.workflows)),
    ...skillFilesOf(input, name, sources),
    reply: found.reply,
    cardFileFields: found.cardFileFields,
    callsModel: startCallsModel(start, sources.workflows),
  };
}

/** What a skill takes as files (#859): its input's file fields and the limits they are bound by. */
function skillFilesOf(
  input: WorkflowStartInput,
  name: string,
  sources: SkillSources,
): Pick<ServedSkill, "inputFiles" | "fileLimits" | "outputFileMediaTypes"> {
  return {
    inputFiles: typeof input === "function" ? fileFieldsOf(input) : [],
    fileLimits: fileLimitsOf(sources.files, sources.expose.skills?.[name]?.files),
    outputFileMediaTypes: fileLimitsOf(sources.files, undefined).allowedMediaTypes,
  };
}

/** The skills of a listener's exports. */
export const servedSkillsOf = (
  exports: readonly Class[],
  sources: SkillSources,
): readonly ServedSkill[] => exports.map((start) => skillOf(start, sources));
