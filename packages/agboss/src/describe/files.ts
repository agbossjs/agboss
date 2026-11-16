import type { ResolvedModelFiles } from "../files/file-settings.js";
import { FileView } from "../files/model-files.js";
import type { AssembledWorkflow } from "../workflow.js";

/**
 * An agent's files as data and as a line (#899): where its model's files come from, in which views, the
 * limits it is held to and what it may hand back — `agboss describe --json` and the text of `describe`.
 */

/** An agent's resolved `files`, as `describe --json` shows them. */
export interface AgentFilesSnapshot {
  readonly sources: readonly string[];
  readonly views: readonly string[];
  readonly maxFileSize: number;
  readonly maxTotalFileSize: number;
  readonly maxFiles: number;
  readonly allowedMediaTypes: readonly string[];
  readonly answerFiles: string;
  readonly guardToolResultFiles: boolean;
  /** The vision model of the built-in transcriber, for an agent that reads a transcription. */
  readonly transcriptionModel?: string;
  /** The vision model of the built-in redactor, for an agent that reads a redacted view. */
  readonly redactionModel?: string;
}

export const filesSnapshotOf = (files: ResolvedModelFiles): AgentFilesSnapshot => ({
  sources: [...files.sources],
  views: [...files.views],
  maxFileSize: files.maxFileSize,
  maxTotalFileSize: files.maxTotalFileSize,
  maxFiles: files.maxFiles,
  allowedMediaTypes: [...files.allowedMediaTypes],
  answerFiles: files.answerFiles,
  guardToolResultFiles: files.guardToolResultFiles,
  ...(files.views.includes(FileView.Transcription)
    ? { transcriptionModel: files.transcriptionModel }
    : {}),
  ...(files.views.includes(FileView.Redacted) ? { redactionModel: files.redactionModel } : {}),
});

/** `files: input, tool-results → original, redacted (5 files, 64 KB each, 20 MB in all) · answer: seen-in-visit`. */
const lineOf = (name: string, files: ResolvedModelFiles): string => {
  const kb = (bytes: number): string =>
    bytes >= 1024 * 1024
      ? `${String(bytes / (1024 * 1024))} MB`
      : `${String(Math.round(bytes / 1024))} KB`;
  return (
    `  ${name}: ${files.sources.join(", ")} → ${files.views.join(", ")}` +
    ` (${String(files.maxFiles)} files, ${kb(files.maxFileSize)} each, ${kb(files.maxTotalFileSize)} in all)` +
    ` · answer files: ${files.answerFiles}`
  );
};

/** The agents' files, one line each; nothing when no agent reads files. */
export function filesLines(bundle: AssembledWorkflow): string[] {
  const lines = Object.entries(bundle.config.agents).flatMap(([name, agent]) =>
    agent.files === undefined ? [] : [lineOf(name, agent.files)],
  );
  return lines.length === 0 ? [] : ["files", ...lines];
}
