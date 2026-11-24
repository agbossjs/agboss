import type { Class } from "../components/injection.js";
import { fileLimitsOf, type FileFetchPool } from "./file-policy.js";
import type { Milliseconds } from "../units/index.js";
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
 * `defaults.files` field by field — and the limits, the types and the fetch of files by url from the
 * workflow's `@FilePolicy` (#1316). The result is plain data: it rides the config of the workflow.
 */

/** A cheap vision model: what the built-in transcriber and redactor call unless set. */
export const DEFAULT_FILE_MODEL = "google/gemini-2.5-flash-lite";

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
  /** The `https:` origins a file by url is fetched from (the policy's `allowedOrigins`). */
  allowedOrigins: string[];
  fetchTimeout: Milliseconds;
  /** The policy's own pool of fetches by url; none: the application's shared one. */
  fetchPool?: FileFetchPool;
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
  /** The workflow's `@FilePolicy`: the limits, the types and the fetch of the agent's files. */
  readonly filePolicy: Class | undefined;
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

/**
 * One agent's files, every level applied: the agent's own over its workflow's over its application's
 * `defaults.files`, over the workflow's `@FilePolicy` (#1316), over the built-ins. The agent's and the
 * defaults' own limits (`ModelFiles.of`, `defaults.files`) leave with `ModelFiles` (#1314a).
 */
export function resolvedFilesOf(levels: FileLevels): ResolvedModelFiles {
  const layered = mergedFileDefaults(levels.defaults, levels.agent) ?? {};
  const limits = fileLimitsOf(levels.filePolicy);
  const fallbackView = levels.hasPiiPolicy ? FileView.Transcription : FileView.Original;
  return {
    maxFileSize: layered.maxFileSize ?? limits.maxFileSize,
    maxTotalFileSize: layered.maxTotalFileSize ?? limits.maxTotalFileSize,
    maxFiles: layered.maxFiles ?? limits.maxFiles,
    allowedMediaTypes: [...(layered.allowedMediaTypes ?? limits.allowedMediaTypes)],
    // the policy's types are narrowed to the kinds the models take; an agent's own are checked strictly
    isTypesExplicit: layered.allowedMediaTypes !== undefined,
    allowedOrigins: [...limits.allowedOrigins],
    fetchTimeout: limits.fetchTimeout,
    ...(limits.fetchPool === undefined ? {} : { fetchPool: limits.fetchPool }),
    ...behaviourOf(layered),
    sources: [...(layered.sources ?? [FileSource.Input])],
    views: [...(layered.views ?? [fallbackView])],
  };
}
