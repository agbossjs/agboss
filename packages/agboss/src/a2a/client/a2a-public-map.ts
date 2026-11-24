import {
  Role,
  TaskState,
  type Artifact,
  type Message,
  type Part,
  type StreamResponse,
  type Task,
  type TaskStatus,
} from "@a2a-js/sdk";
import { A2ATaskState } from "../../infrastructure/a2a-task.repository.js";
import {
  A2ARole,
  type A2AArtifact,
  type A2AMessage,
  type A2AMetadata,
  type A2APart,
  type A2AStreamEvent,
  type A2ATask,
  type A2ATaskProgress,
} from "../a2a-types.js";

/**
 * Where the official SDK's generated types end (#1320): what the client read from the wire as the
 * SDK shapes it — `$case` unions, empty strings for absent texts, `Role`/`TaskState` numbers — is
 * given out as AGBoss's own types, and the parts a caller gives are written as the SDK's.
 */

const STATES: ReadonlyMap<TaskState, A2ATaskState> = new Map([
  [TaskState.TASK_STATE_SUBMITTED, A2ATaskState.Submitted],
  [TaskState.TASK_STATE_WORKING, A2ATaskState.Working],
  [TaskState.TASK_STATE_INPUT_REQUIRED, A2ATaskState.InputRequired],
  [TaskState.TASK_STATE_COMPLETED, A2ATaskState.Completed],
  [TaskState.TASK_STATE_FAILED, A2ATaskState.Failed],
  [TaskState.TASK_STATE_CANCELED, A2ATaskState.Cancelled],
  [TaskState.TASK_STATE_REJECTED, A2ATaskState.Rejected],
  [TaskState.TASK_STATE_AUTH_REQUIRED, A2ATaskState.AuthRequired],
]);

/** A state as AGBoss names it; one the peer left out or this version does not know is `Unspecified`. */
export const a2aStateOf = (state: TaskState): A2ATaskState =>
  STATES.get(state) ?? A2ATaskState.Unspecified;

/** The SDK's state of an AGBoss one (the wire's); `Unspecified` for one with no wire name. */
export const sdkStateOf = (state: A2ATaskState): TaskState =>
  [...STATES].find(([, own]) => own === state)?.[0] ?? TaskState.TASK_STATE_UNSPECIFIED;

/** `{}`-less optional: a field the SDK left `undefined` or `""` is absent. */
export const present = <K extends string, T>(
  key: K,
  value: T | undefined,
): Readonly<Partial<Record<K, T>>> =>
  (value === undefined ? {} : { [key]: value }) as Readonly<Partial<Record<K, T>>>;

export const textPresent = <K extends string>(
  key: K,
  value: string,
): Readonly<Partial<Record<K, string>>> => present(key, value === "" ? undefined : value);

/** The peer's list; one it left out is empty. */
export const listOf = <T>(items: readonly T[] | undefined): readonly T[] => items ?? [];

/** The peer's metadata, when it sent some. */
export const metadataOf = (
  metadata: Record<string, unknown> | undefined,
): { metadata?: A2AMetadata } => present("metadata", metadata);

/** A part as AGBoss gives it. */
export function a2aPartOf(part: Part): A2APart {
  const common = {
    ...metadataOf(part.metadata),
    ...textPresent("filename", part.filename),
    ...textPresent("mediaType", part.mediaType),
  };
  const { content } = part;
  switch (content?.$case) {
    case "text":
      return { kind: "text", text: content.value, ...common };
    case "raw":
      return { kind: "raw", bytes: new Uint8Array(content.value), ...common };
    case "url":
      return { kind: "url", url: content.value, ...common };
    case "data":
      return { kind: "data", data: content.value as unknown, ...common };
    default:
      // a part that holds nothing: an empty data part, the peer's own shape kept
      return { kind: "data", data: undefined, ...common };
  }
}

/** What a part holds as the SDK writes it, and the media type it has when it names none. */
function contentOf(part: A2APart): { content: Part["content"]; mediaType: string } {
  switch (part.kind) {
    case "text":
      return { content: { $case: "text", value: part.text }, mediaType: "text/plain" };
    case "data":
      return { content: { $case: "data", value: part.data }, mediaType: "application/json" };
    case "raw":
      return {
        content: { $case: "raw", value: Buffer.from(part.bytes) },
        mediaType: "application/octet-stream",
      };
    case "url":
      return { content: { $case: "url", value: part.url }, mediaType: "application/octet-stream" };
  }
}

/** A part as the SDK writes it. */
export function sdkPartOf(part: A2APart): Part {
  const { content, mediaType } = contentOf(part);
  return {
    content,
    metadata: part.metadata === undefined ? undefined : { ...part.metadata },
    filename: part.filename ?? "",
    mediaType: part.mediaType ?? mediaType,
  };
}

/** A message as AGBoss gives it. */
export function a2aMessageOf(message: Message): A2AMessage {
  return {
    messageId: message.messageId,
    ...textPresent("contextId", message.contextId),
    ...textPresent("taskId", message.taskId),
    ...(message.role === Role.ROLE_USER
      ? { role: A2ARole.User }
      : message.role === Role.ROLE_AGENT
        ? { role: A2ARole.Agent }
        : {}),
    parts: listOf(message.parts).map(a2aPartOf),
    ...metadataOf(message.metadata),
    extensions: [...listOf(message.extensions)],
    referenceTaskIds: [...listOf(message.referenceTaskIds)],
  };
}

/** An artifact as AGBoss gives it. */
export function a2aArtifactOf(artifact: Artifact): A2AArtifact {
  return {
    artifactId: artifact.artifactId,
    ...textPresent("name", artifact.name),
    ...textPresent("description", artifact.description),
    parts: listOf(artifact.parts).map(a2aPartOf),
    ...metadataOf(artifact.metadata),
    extensions: [...listOf(artifact.extensions)],
  };
}

/** A task's status as AGBoss gives it; a timestamp that is no date is left out. */
export function a2aProgressOf(status: TaskStatus): A2ATaskProgress {
  const at = status.timestamp === undefined ? undefined : new Date(status.timestamp);
  return {
    state: a2aStateOf(status.state),
    ...(status.message === undefined ? {} : { message: a2aMessageOf(status.message) }),
    ...(at === undefined || Number.isNaN(at.getTime()) ? {} : { timestamp: at }),
  };
}

/** A task as AGBoss gives it. */
export function a2aTaskOf(task: Task): A2ATask {
  return {
    id: task.id,
    contextId: task.contextId,
    ...(task.status === undefined ? {} : { status: a2aProgressOf(task.status) }),
    artifacts: listOf(task.artifacts).map(a2aArtifactOf),
    history: listOf(task.history).map(a2aMessageOf),
    ...metadataOf(task.metadata),
  };
}

/** One event of a remote task as AGBoss gives it; `undefined` for a payload the SDK left out. */
export function a2aEventOf(event: StreamResponse): A2AStreamEvent | undefined {
  const { payload } = event;
  switch (payload?.$case) {
    case "task":
      return { kind: "task", task: a2aTaskOf(payload.value) };
    case "message":
      return { kind: "message", message: a2aMessageOf(payload.value) };
    case "statusUpdate": {
      const { taskId, contextId, status, metadata } = payload.value;
      return {
        kind: "status-update",
        taskId,
        contextId,
        ...(status === undefined ? {} : { status: a2aProgressOf(status) }),
        ...metadataOf(metadata),
      };
    }
    case "artifactUpdate": {
      const { taskId, contextId, artifact, append, lastChunk, metadata } = payload.value;
      return {
        kind: "artifact-update",
        taskId,
        contextId,
        ...(artifact === undefined ? {} : { artifact: a2aArtifactOf(artifact) }),
        append,
        lastChunk,
        ...metadataOf(metadata),
      };
    }
    default:
      return undefined;
  }
}
