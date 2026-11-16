/**
 * Files that reach an agent's model (#899): `@Agent({ files: ModelFiles.of({ … }) })`, the sources,
 * views and limits, what stops a file, and how one is transcribed.
 */
export {
  AnswerFiles,
  FileSource,
  FileView,
  ModelFileLimit,
  ModelFiles,
  RedactionValues,
  type FileDefaults,
  type ModelFilesOptions,
} from "../files/model-files.js";
export {
  ModelFileLimitError,
  ModelFileRefusal,
  ModelFileRefusedError,
  ModelFileUnavailableError,
  ModelFileUnavailableReason,
  type ModelFileLimitErrorOptions,
  type ModelFileRefusedErrorOptions,
  type ModelFileUnavailableErrorOptions,
} from "../files/file-errors.js";
export {
  FileTranscriber,
  ModelFileTranscriber,
  type TranscribeOptions,
  type TranscriptionResult,
} from "../files/file-transcriber.js";
export {
  FileRedactor,
  ModelImageRedactor,
  type RedactionResult,
  type RedactOptions,
} from "../files/file-redactor.js";
export {
  FileRedactionFailedError,
  type FileRedactionFailedErrorOptions,
} from "../files/file-errors.js";
export type { FileRuleCode } from "../files/file-rule-codes.js";
export type { FileContent } from "../files/file-bytes.js";
export type { ResolvedModelFiles } from "../files/file-settings.js";
