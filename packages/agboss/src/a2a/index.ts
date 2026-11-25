import "../polyfills/symbol-metadata.js";

export * from "./a2a-decorator.js";
// #809: the A2A v1.0 client on the official SDK
export { A2AClient } from "./client/a2a-client.js";
export type {
  A2AClientCall,
  A2AClientContract,
  A2AClientOptions,
  A2ATaskResult,
} from "./client/a2a-client-options.js";
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
  A2ATaskCancelledError,
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
  A2AUnexpectedFinishError,
  type A2AUnexpectedFinishErrorOptions,
} from "./client/a2a-finish.js";
export {
  A2AMesh,
  A2AMeshUnsupportedError,
  A2AOriginError,
  A2AOriginSite,
  type A2AMeshUnsupportedErrorOptions,
  type A2AOriginErrorOptions,
} from "./client/a2a-guard-errors.js";
// the spec's types as AGBoss's own, discriminated by `kind`, with `Date` times (#1320): the official
// SDK's generated types are not part of this entry
export {
  A2APart,
  A2ARole,
  type A2AAgentCapabilities,
  type A2AAgentCard,
  type A2AAgentExtension,
  type A2AAgentInterface,
  type A2AAgentSkill,
  type A2AArtifact,
  type A2AArtifactUpdateEvent,
  type A2ADataPart,
  type A2AMessage,
  type A2AMessageInput,
  type A2AMetadata,
  type A2APartBase,
  type A2ARawPart,
  type A2AStatusUpdateEvent,
  type A2AStreamEvent,
  type A2ATask,
  type A2ATaskProgress,
  type A2ATextPart,
  type A2AUrlPart,
} from "./a2a-types.js";
export { A2AOperation, type A2AApp } from "./a2a-caller.js";
export { a2aHttpListener, type A2AHttpListenerOptions } from "./a2a-http.js";
export {
  A2AEndpoint,
  A2ACardFileFields,
  A2AReply,
  type A2AEndpointOptions,
  type A2AEndpointSkill,
  type A2AEndpointSkillOptions,
  type A2AEndpointTtl,
  type A2ASkillEntry,
} from "./a2a-endpoint.decorator.js";
export { A2A_MESH_EXTENSION, A2A_SKILLS_EXTENSION } from "./a2a-extension-uris.js";
// the task and direct-message stores (`A2ATaskRepository`, `A2ADirectMessageRepository` and their
// in-memory and SQLite classes) are in `@agboss/core/stores` (#1320)
export { A2ATaskState } from "../infrastructure/a2a-task.repository.js";
export { DEFAULT_A2A_FILE_MEDIA_TYPES } from "./files/a2a-file-options.js";
export type { A2ADownloadOptions } from "./client/a2a-download.js";
export { A2AError, A2AErrorKind } from "../core/error-families/remote-errors.js";
