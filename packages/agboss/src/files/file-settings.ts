import { DEFAULT_A2A_FILE_LIMITS, type A2AFileOptions } from "../a2a/files/a2a-file-options.js";
import { megabytes } from "../units/index.js";
import {
  AnswerFiles,
  FileSource,
  FileView,
  RedactionValues,
  type FileDefaults,
  type ModelFilesOptions,
} from "./model-files.js";

/**
 * What an agent's `files` come to (#899 §1): its own, over its workflow's and its application's
 * `defaults.files` field by field, then — for the limits and the types — the `@A2AExpose` skills that
 * reach it (the union of their types, the max of their limits), `@Application({ a2aFiles })` and the
 * built-in defaults. The result is plain data: it rides the config of the workflow.
 */

/** A cheap vision model: what the built-in transcriber and redactor call unless set. */
export const DEFAULT_FILE_MODEL = "google/gemini-2.5-flash-lite";

export const DEFAULT_MAX_FILES = 5;
export const DEFAULT_MAX_TOTAL_FILE_SIZE = megabytes(20);
export const DEFAULT_TRANSCRIPTION_MAX_TOKENS = 4096;

/**
 * An agent's files settings with every field set: what the loop and the start checks read. Whether a
 * level set `allowedMediaTypes` (`isTypesExplicit`) decides if the types are checked strictly at start
 * or narrowed to the kinds the models take.
 */
export interface ResolvedModelFiles {
  sources: FileSource[];
  views: FileView[];
  maxFileSize: number;
  maxTotalFileSize: number;
  maxFiles: number;
  allowedMediaTypes: string[];
  isTypesExplicit: boolean;
  answerFiles: AnswerFiles;
  guardToolResultFiles: boolean;
  transcriptionModel: string;
  redactionModel: string;
  redactionValues: RedactionValues;
  /** Whether the exact values go to the redaction model: decided where the providers are known; absent = no. */
  redactionSendsValues?: boolean;
  transcriptionMaxTokens: number;
}

/** The levels one agent's files are resolved from. */
export interface FileLevels {
  readonly agent: ModelFilesOptions;
  /** The workflow's `defaults.files` over its application's, field by field. */
  readonly defaults: FileDefaults | undefined;
  /** The `files` options of the skills whose starts reach the agent. */
  readonly skills: readonly A2AFileOptions[];
  readonly a2aFiles: A2AFileOptions | undefined;
  /** Whether PII policies apply to the agent: its default view is then the transcription. */
  readonly hasPiiPolicy: boolean;
}

/** Two `defaults.files` merged field by field, the workflow's over the application's. */
export function mergedFileDefaults(
  application: FileDefaults | undefined,
  workflow: FileDefaults | undefined,
): FileDefaults | undefined {
  if (application === undefined) return workflow;
  if (workflow === undefined) return application;
  return { ...application, ...workflow };
}

const unionOf = (lists: readonly (readonly string[])[]): string[] => [...new Set(lists.flat())];

/** The limit and types the skills and the application give, before the built-ins. */
function a2aLimitsOf(levels: FileLevels): {
  readonly size: number;
  readonly types: readonly string[];
} {
  const skillSizes = levels.skills.flatMap((skill) => skill.maxFileSize ?? []);
  const skillTypes = levels.skills.map((skill) => skill.allowedMediaTypes ?? []);
  const typeUnion = unionOf(skillTypes);
  const own = levels.a2aFiles;
  return {
    size:
      skillSizes.length > 0
        ? Math.max(...skillSizes)
        : (own?.maxFileSize ?? DEFAULT_A2A_FILE_LIMITS.maxFileSize),
    types:
      typeUnion.length > 0
        ? typeUnion
        : (own?.allowedMediaTypes ?? DEFAULT_A2A_FILE_LIMITS.allowedMediaTypes),
  };
}

/** The size and count limits: the level that sets one, else the built-in. */
function limitsOf(layered: FileDefaults, a2aSize: number) {
  return {
    maxFileSize: layered.maxFileSize ?? a2aSize,
    maxTotalFileSize: layered.maxTotalFileSize ?? DEFAULT_MAX_TOTAL_FILE_SIZE,
    maxFiles: layered.maxFiles ?? DEFAULT_MAX_FILES,
  };
}

/** The settings that are no limit: what is allowed back, and the built-ins' models. */
function behaviourOf(layered: FileDefaults) {
  return {
    answerFiles: layered.answerFiles ?? AnswerFiles.SeenInVisit,
    guardToolResultFiles: layered.guardToolResultFiles ?? true,
    transcriptionModel: layered.transcriptionModel ?? DEFAULT_FILE_MODEL,
    redactionModel: layered.redactionModel ?? DEFAULT_FILE_MODEL,
    redactionValues: layered.redactionValues ?? RedactionValues.SameProvider,
    transcriptionMaxTokens: layered.transcriptionMaxTokens ?? DEFAULT_TRANSCRIPTION_MAX_TOKENS,
  };
}

/** One agent's files, every level applied: the agent's own over its workflow's over its application's. */
export function resolvedFilesOf(levels: FileLevels): ResolvedModelFiles {
  const layered = mergedFileDefaults(levels.defaults, levels.agent) ?? {};
  const a2a = a2aLimitsOf(levels);
  const fallbackView = levels.hasPiiPolicy ? FileView.Transcription : FileView.Original;
  return {
    ...limitsOf(layered, a2a.size),
    ...behaviourOf(layered),
    sources: [...(layered.sources ?? [FileSource.Input])],
    views: [...(layered.views ?? [fallbackView])],
    allowedMediaTypes: [...(layered.allowedMediaTypes ?? a2a.types)],
    isTypesExplicit: layered.allowedMediaTypes !== undefined,
  };
}
