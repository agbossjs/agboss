import "../polyfills/symbol-metadata.js";

export {
  A2AStatus,
  type A2AEvent,
  type A2AExecutionRequest,
  type A2AExecutionResponse,
} from "./types.js";
export * from "./a2a-decorator.js";
// #809: the A2A v1.0 client on the official SDK
export { A2AClient } from "./client/a2a-client.js";
export type {
  A2AClientCall,
  A2AClientContract,
  A2AClientOptions,
  A2AStreamEvent,
  A2ATaskResult,
} from "./client/a2a-client-options.js";
export type { A2AMessageInput } from "./client/a2a-parts.js";
export { A2APeerKind, type A2ARemotePeer } from "./client/a2a-card.js";
export {
  A2AClientOperation,
  A2AContractError,
  A2AContractRule,
  A2AProtocolError,
  A2ARemoteCallError,
  A2ARemoteCallReason,
  type A2AContractErrorOptions,
  type A2AProtocolErrorOptions,
  type A2ARemoteCallErrorOptions,
} from "./client/a2a-client-errors.js";
export {
  A2ACallDeadlineError,
  A2ACancelOutcome,
  A2ATaskCanceledError,
  A2ATaskEnd,
  A2ATaskFailedError,
  A2ATaskInterruptedError,
  A2ATaskInterruption,
  type A2ACallDeadlineErrorOptions,
  type A2ATaskErrorOptions,
  type A2ATaskFailedErrorOptions,
  type A2ATaskInterruptedErrorOptions,
} from "./client/a2a-task-errors.js";
export {
  A2AMesh,
  A2AMeshUnsupportedError,
  A2AOriginError,
  A2AOriginSite,
  type A2AMeshUnsupportedErrorOptions,
  type A2AOriginErrorOptions,
} from "./client/a2a-guard-errors.js";
// the spec's types, as the official SDK defines them (A2A v1.0)
export {
  TaskState,
  type AgentCard,
  type AgentSkill,
  type Artifact,
  type Message,
  type Part,
  type Task,
} from "@a2a-js/sdk";
export {
  A2ACallerRejectedError,
  A2ACallerResolution,
  A2ACallerResolutionKind,
  A2AOperation,
  type A2AApp,
  type A2ACaller,
  type A2ACallerForbiddenOptions,
  type A2ACallerRequest,
  type A2ACallerResolver,
  type A2ACallerUnauthenticatedOptions,
  type A2APeer,
  type RejectedA2ACallerResolution,
  type ResolvedA2ACallerResolution,
} from "./a2a-caller.js";
export { a2aHttpListener, type A2AHttpListenerOptions } from "./a2a-http.js";
export {
  A2AExpose,
  A2ACardFileFields,
  A2AReply,
  type A2AExposeOptions,
  type A2AExposedSkillOptions,
} from "./a2a-expose.decorator.js";
export { A2ASecurity, A2ASecuritySchemeKind, type A2ASecurityScheme } from "./a2a-security.js";
export { A2A_MESH_EXTENSION, A2A_SKILLS_EXTENSION } from "./a2a-extension-uris.js";
// #807: the A2A task store on the application's SQLite file (`@Application({ providers })`)
export { SqliteA2ATaskRepository } from "../infrastructure/sqlite/sqlite-a2a-task.repository.js";
// #860: the direct messages' replies (`A2AReply.Message` skills), in memory and on the SQLite file
export * from "../infrastructure/a2a-direct-message.repository.js";
export { InMemoryA2ADirectMessageRepository } from "../infrastructure/in-memory-a2a-direct-message.repository.js";
export { SqliteA2ADirectMessageRepository } from "../infrastructure/sqlite/sqlite-a2a-direct-message.repository.js";
// #859: file parts in messages and artifacts
export {
  A2AFileDto,
  A2AFileSource,
  WorkflowFinishFileDto,
  WorkflowFinishFilesDto,
  type A2AFileField,
} from "./files/a2a-file.dto.js";
export { A2AFiles, type A2AFileContent, type A2AFileReference } from "./files/a2a-files.service.js";
export {
  A2AFileRefusal,
  A2AFileRefusedError,
  A2AFileUnavailableError,
  A2AFileUnavailableReason,
  type A2AFileRefusedErrorOptions,
} from "./files/a2a-file-errors.js";
export { DEFAULT_A2A_FILE_MEDIA_TYPES, type A2AFileOptions } from "./files/a2a-file-options.js";
export {
  A2AClientFile,
  type A2AClientFileOptions,
  type A2AReceivedFile,
} from "./client/a2a-client-files.js";
export type { A2ADownloadOptions } from "./client/a2a-download.js";
export {
  A2AFileConflictError,
  A2AFileRepository,
  type A2AFileKey,
  type A2AFileMetadata,
  type A2AFileOwner,
  type NewA2AFile,
} from "../infrastructure/a2a-file.repository.js";
export { InMemoryA2AFileRepository } from "../infrastructure/in-memory-a2a-file.repository.js";
export { LocalDiskA2AFileRepository } from "../infrastructure/local-disk-a2a-file.repository.js";
export { S3A2AFileRepository } from "../infrastructure/s3/s3-a2a-file.repository.js";
