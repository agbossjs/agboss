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
  type A2AExposeOptions,
  type A2AExposedSkillOptions,
} from "./a2a-expose.decorator.js";
export { A2ASecurity, A2ASecuritySchemeKind, type A2ASecurityScheme } from "./a2a-security.js";
export { A2A_MESH_EXTENSION, A2A_SKILLS_EXTENSION } from "./a2a-extension-uris.js";
// #807: the A2A task store on the application's SQLite file (`@Application({ providers })`)
export { SqliteA2ATaskRepository } from "../infrastructure/sqlite/sqlite-a2a-task.repository.js";
