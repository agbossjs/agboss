import type { ApplicationOptions } from "../application/application.js";
import {
  backendOf,
  implementationsOf,
  ImplementationReason,
  leaseStoreOf,
} from "../application/implementations.js";
import type { Class, Provider } from "../components/injection.js";
import { componentOf } from "../components/metadata.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import { FileRepository } from "../infrastructure/file.repository.js";
import { definedOf } from "../infrastructure/clock.js";
import { kilobytes } from "../units/index.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import { NodeKind } from "../flow/ast.js";
import { flowClassesOf, withChildWorkflows } from "../flow/analyse/child-workflow.js";
import { listItemClassesOf, plainOutputClassOf } from "../flow/finish-output.js";
import { fileFieldsOf, inputClassOf } from "../dto/standard/file.js";
import { cardFileFieldsViolations } from "./files/a2a-file-options.js";
import { fileTierSizeOf } from "./files/a2a-file-tier.js";
import { filePolicyExcesses, filePolicyViolations } from "../files/file-policy.js";
import { workflowFilePolicyOf, workflowOfStart } from "../files/workflow-file-policy.js";

/**
 * Where an application's A2A files may live (#859), read from the declarations, fail closed: with
 * no `FileRepository` listed a file rides inline in its task's records — silently up to 64 KB,
 * with the warning `[a2a.inline-files-without-store]` up to 256 KB (an error under `--strict`),
 * never above it (`[a2a.file-store-required]`); and on leases its instances share, files above
 * 256 KB in a store of one host (`in-memory`, `local-disk`) are `[a2a.file-store-not-shared]` — a
 * takeover on another instance would find no bytes. File options are checked too
 * (`[file-policy.invalid]`).
 */

/** Up to this, files ride inline in a task's records without a word. */
const SILENT_INLINE = kilobytes(64);
/** Up to this, inline with a warning; above it, a store is required. */
const MAX_INLINE = kilobytes(256);

/** The backends of one host's file stores. */
const SINGLE_HOST: ReadonlySet<string> = new Set(["in-memory", "local-disk"]);

/** The file store an application runs on and whether it was listed. */
function fileStoreOf(providers: readonly Provider[]): {
  readonly store: Class;
  readonly isListed: boolean;
} {
  const choice = definedOf(
    implementationsOf(providers).find(({ contract }) => contract === FileRepository),
    // Stryker disable next-line StringLiteral: the invariant's text, never read while it holds
    "FileRepository is a built-in contract",
  );
  return { store: choice.implementation, isListed: choice.reason === ImplementationReason.Listed };
}

/** What a tier rule reads of an application. */
export interface FileTierSources {
  readonly name: string;
  readonly providers: readonly Provider[];
  readonly exposes: readonly Class[];
  readonly workflows: readonly Class[];
}

const tierOf = (sources: FileTierSources): number =>
  fileTierSizeOf(sources.exposes, sources.workflows);

const kb = (bytes: number): string => `${String(Math.ceil(bytes / 1024))} KB`;

/** A skill's `filePolicy`, checked, and `[a2a.skill-file-policy-exceeds-workflow]`: it only tightens its workflow's. */
function skillPolicyViolations(
  expose: string,
  skill: string,
  policy: Class | undefined,
  start: Class | undefined,
  workflows: readonly Class[],
): RuleViolation[] {
  if (policy === undefined) return [];
  const own = filePolicyViolations(`${expose}'s skill ${skill} filePolicy`, policy, [expose]);
  if (own.length > 0 || start === undefined) return own;
  const excesses = filePolicyExcesses(
    workflowFilePolicyOf(workflowOfStart(start, workflows)),
    policy,
  );
  return excesses.map((excess) =>
    violation(
      "a2a.skill-file-policy-exceeds-workflow",
      `${expose}'s skill ${skill} filePolicy sets more than its workflow's: ${excess}`,
      [expose],
    ),
  );
}

/** Whether a node of a flow takes or gives files: a start's input or a finish's output with a `FileDto` field, an agent with `files`. */
function nodeUsesFiles(node: Class): boolean {
  const declaration = declarationOf(node);
  if (declaration?.kind === NodeKind.Agent) return declaration.options.files !== undefined;
  if (declaration?.kind === NodeKind.Start) {
    const input = inputClassOf(declaration.options.input);
    return input !== undefined && fileFieldsOf(input).length > 0;
  }
  if (declaration?.kind === NodeKind.Finish) {
    const output = plainOutputClassOf(declaration.options.output);
    const items = listItemClassesOf(declaration.options.output);
    return [...(output === undefined ? [] : [output]), ...items].some(
      (dto) => fileFieldsOf(dto).length > 0,
    );
  }
  return false;
}

/** `[workflow.file-policy-required]`: a workflow that takes, gives or reads files names its `filePolicy`. */
function policyRequiredViolations(options: ApplicationOptions): RuleViolation[] {
  return withChildWorkflows(options.workflows).flatMap((workflow) => {
    const declaration = declarationOf(workflow);
    if (declaration?.kind !== NodeKind.Workflow || declaration.options.filePolicy !== undefined)
      return [];
    if (!flowClassesOf(declaration.options.flow).some(nodeUsesFiles)) return [];
    return [
      violation(
        "workflow.file-policy-required",
        `${declaration.options.name} takes, gives or reads files (a FileDto field, an agent's files) but names no filePolicy — add @FilePolicy({ … }) and filePolicy: X to @Workflow`,
        [options.name],
      ),
    ];
  });
}

/** The file policies of the workflows and of each expose's skills, checked. */
function optionsViolations(options: ApplicationOptions): RuleViolation[] {
  const own = options.workflows.flatMap((workflow) => {
    const policy = workflowFilePolicyOf(workflow);
    const name = declarationOf(workflow)?.options.name ?? workflow.name;
    return filePolicyViolations(`${name}'s filePolicy`, policy, [options.name]);
  });
  const skills = (options.exposes ?? []).flatMap((expose) => {
    const meta = componentOf(expose);
    if (meta?.kind !== "a2a-expose") return [];
    const files = Object.entries(meta.meta.skills ?? {}).flatMap(([skill, settings]) =>
      skillPolicyViolations(
        meta.meta.name,
        skill,
        settings.filePolicy,
        meta.meta.exports.find((start) => declarationOf(start)?.options.name === skill),
        options.workflows,
      ),
    );
    // #904: how its card describes file fields
    const exported = new Set(meta.meta.exports.map((start) => declarationOf(start)?.options.name));
    return [
      ...files,
      ...cardFileFieldsViolations(meta.meta.name, meta.meta, exported, options.name),
    ];
  });
  return [...own, ...skills, ...policyRequiredViolations(options)];
}

/**
 * `[a2a.file-store-required]`, `[a2a.file-store-not-shared]`, `[a2a.file-options-invalid]` and (#904)
 * a card file fields setting for a skill not exported, `[a2a.unknown-skill-option]`.
 */
export function a2aFileStoreViolations(options: ApplicationOptions): RuleViolation[] {
  const sources: FileTierSources = {
    name: options.name,
    providers: options.providers ?? [],
    exposes: options.exposes ?? [],
    workflows: options.workflows,
  };
  const found = optionsViolations(options);
  const size = tierOf(sources);
  if (size <= MAX_INLINE) return found;
  const { store, isListed } = fileStoreOf(sources.providers);
  if (!isListed)
    return [
      ...found,
      violation(
        "a2a.file-store-required",
        `${options.name}'s A2A skills keep up to ${kb(size)} of files, above the ${kb(MAX_INLINE)} that ride inline in a task's records — list a FileRepository (S3FileRepository, LocalDiskFileRepository) in @Application({ providers }), or lower maxTotalFileSize`,
        [options.name],
      ),
    ];
  const leases = leaseStoreOf(sources.providers);
  const leaseBackend = leases === undefined ? undefined : backendOf(leases);
  const backend = backendOf(store) ?? "";
  if (leaseBackend === "in-memory" || !SINGLE_HOST.has(backend)) return found;
  return [
    ...found,
    violation(
      "a2a.file-store-not-shared",
      `${options.name} shares its leases between instances, but keeps its A2A files (up to ${kb(size)}) in ${store.name} (backend "${backend}"), one host's — a task taken over by another instance would find no bytes: list S3FileRepository or another store every instance reaches`,
      [options.name],
    ),
  ];
}

/** `[a2a.inline-files-without-store]`: files between 64 and 256 KB inline, no store listed. */
export function inlineFilesWarningOf(sources: FileTierSources): string | undefined {
  const size = tierOf(sources);
  if (size <= SILENT_INLINE || size > MAX_INLINE || fileStoreOf(sources.providers).isListed)
    return undefined;
  return `${sources.name}'s A2A skills keep up to ${kb(size)} of files inline in each task's records (checkpoints, task rows) — list a FileRepository to keep them apart`;
}
