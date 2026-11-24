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
  FileRefusal,
  FileUnavailableReason,
  ModelFileLimitError,
  type ModelFileLimitErrorOptions,
} from "../files/file-errors.js";
// the service a step keeps and reads its files with (`deps: [Files]`, #1316)
export { Files, type FileReference, type FileToSave } from "../a2a/files/files.service.js";
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
// what a workflow's files may be (#1316): `@FilePolicy`, named by `filePolicy` on `@Workflow`
export {
  FilePolicy,
  type FileFetchPool,
  type FilePolicyMeta,
  type FilePolicyOptions,
} from "../files/file-policy.js";
