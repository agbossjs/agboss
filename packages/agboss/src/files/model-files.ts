import type { Bytes } from "../units/index.js";

/**
 * Files reach an agent's model (#899): which files (`sources`), in which form (`views`), how many
 * and how large, and what the agent may hand back. The framework gives safe defaults, the developer
 * decides: an agent without `files` sends no byte to its model.
 */

/** Where the files an agent's model reads come from. */
export enum FileSource {
  /** The agent's input fields (the DTOs of its `input` that hold `A2AFileDto` fields). */
  Input = "input",
  /** The results of its tools: a tool whose output holds `A2AFileDto` fields. */
  ToolResults = "tool-results",
  /** The thread's earlier turns (a later release). */
  History = "history",
}

/** The form a file takes in a model message. */
export enum FileView {
  /** The file itself, as a part (an image, a PDF) or as text (a text format). */
  Original = "original",
  /** A copy with every PII kind the agent's policies name blacked out (a later release). */
  Redacted = "redacted",
  /** A text transcription, masked by the policies' rules like any text. */
  Transcription = "transcription",
}

/** Whether the exact PII values of the execution go to the redaction model with the kinds (#899 §6). */
export enum RedactionValues {
  /** Only when the redaction model is served by the same provider as the agent's model (the default). */
  SameProvider = "same-provider",
  /** Never: the kinds only. */
  Never = "never",
  /** Always, wherever the redaction model runs — an explicit decision. */
  Always = "always",
}

/** What an agent may return of the files it saw. */
export enum AnswerFiles {
  /** Only files it saw in the visit, picked by number (the default). */
  SeenInVisit = "seen-in-visit",
  /** Any descriptor the model writes, checked like any DTO — an explicit decision. */
  Any = "any",
}

/** Which limit a file over it hit (`ModelFileLimitError.limit`). */
export enum ModelFileLimit {
  /** More source files than `maxFiles`. */
  MaxFiles = "max-files",
  /** A file larger than `maxFileSize`. */
  MaxFileSize = "max-file-size",
  /** All views of all files of one model call larger than `maxTotalFileSize`. */
  MaxTotalFileSize = "max-total-file-size",
  /** A media type not in `allowedMediaTypes`, or one the agent's model does not take. */
  MediaType = "media-type",
}

/** The settings of `ModelFiles.of` and of `defaults.files` (every field optional). */
export interface ModelFilesOptions {
  /** Where the files come from (`[FileSource.Input]` by default). */
  readonly sources?: readonly FileSource[];
  /** The forms the model gets (`Original` without a PII policy, `Transcription` with one). */
  readonly views?: readonly FileView[];
  /** The largest file (the cascade: skills, `@Application({ a2aFiles })`, its defaults). */
  readonly maxFileSize?: Bytes;
  /** All views of all files of one model call (`megabytes(20)`). */
  readonly maxTotalFileSize?: Bytes;
  /** Source files per model call, not parts (5). */
  readonly maxFiles?: number;
  /** The media types taken: set here, checked strictly at start against every model that reads them. */
  readonly allowedMediaTypes?: readonly string[];
  /** What the agent may return (`AnswerFiles.SeenInVisit`). */
  readonly answerFiles?: AnswerFiles;
  /** Input guardrails also check files from tool results (true). */
  readonly guardToolResultFiles?: boolean;
}

/** `defaults.files` on `@Workflow` / `@Application`: the agent's settings and the models of the built-ins. */
export interface FileDefaults extends ModelFilesOptions {
  /** The vision model that transcribes (`DEFAULT_FILE_MODEL`). */
  readonly transcriptionModel?: string;
  /** The vision model that redacts (`DEFAULT_FILE_MODEL`). */
  readonly redactionModel?: string;
  /** Whether the execution's exact PII values go to the redaction model (`RedactionValues.SameProvider`). */
  readonly redactionValues?: RedactionValues;
  /** The most tokens one transcription writes (4096). */
  readonly transcriptionMaxTokens?: number;
}

/** `@Agent({ files: ModelFiles.of({ … }) })`: an agent opts in to files for its model. */
export class ModelFiles {
  private constructor(readonly options: ModelFilesOptions) {}

  /** The settings of one agent; what is left out comes from `defaults.files` and the built-ins. */
  static of(options: ModelFilesOptions = {}): ModelFiles {
    return new ModelFiles(Object.freeze({ ...options }));
  }
}
