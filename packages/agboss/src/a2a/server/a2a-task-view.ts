import {
  Role,
  TaskState,
  type Artifact,
  type Message,
  type Part,
  type Task,
  type TaskStatus,
} from "@a2a-js/sdk";
import type { A2ATaskRecord, A2ATaskStatus } from "../../infrastructure/a2a-task.repository.js";
import { A2ATaskState } from "../../infrastructure/a2a-task.repository.js";
import { A2A_MESH_EXTENSION, A2A_SKILLS_EXTENSION } from "../a2a-extension-uris.js";
import { A2AMediaType, type ServedSkill } from "./a2a-skills.js";

/**
 * A kept task as A2A v1.0 shows it (#808, design §3): its state, its status message — the pauses a
 * caller may answer (`INPUT_REQUIRED`), a channel-only pause's "awaiting …", a failure's fixed text
 * with its stable code — and, once `COMPLETED`, the finish's output as one artifact. No history
 * beyond the status message. Nothing but the kept status reaches the wire: an error's own text never
 * is kept (#807).
 */

export const textPart = (text: string): Part => ({
  content: { $case: "text", value: text },
  metadata: undefined,
  filename: "",
  mediaType: A2AMediaType.Text,
});

export const dataPart = (value: unknown): Part => ({
  content: { $case: "data", value },
  metadata: undefined,
  filename: "",
  mediaType: A2AMediaType.Json,
});

/** The wire state of a kept one (the names are the same, ProtoJSON). */
export const wireStateOf = (state: A2ATaskState): TaskState => TaskState[state];

/** The agent's message of a status; `undefined` when it says nothing. */
function statusMessageOf(task: A2ATaskRecord): Message | undefined {
  const { status } = task;
  const pauses = status.pendingPauses.flatMap(({ pauseId, kind, ask }) =>
    pauseId === undefined ? [] : [{ pauseId, kind, ask }],
  );
  const parts = [
    ...(status.message === undefined ? [] : [textPart(status.message)]),
    ...(status.state === A2ATaskState.InputRequired ? [dataPart({ pauses })] : []),
  ];
  if (parts.length === 0) return undefined;
  const code =
    status.errorCode === undefined
      ? undefined
      : { [A2A_MESH_EXTENSION]: { code: status.errorCode } };
  return {
    messageId: `${task.taskId}:status:${String(task.version)}`,
    contextId: task.contextId,
    taskId: task.taskId,
    role: Role.ROLE_AGENT,
    parts,
    metadata: code,
    extensions: [],
    referenceTaskIds: [],
  };
}

/** The wire status of a kept task. */
export const wireStatusOf = (task: A2ATaskRecord): TaskStatus => ({
  state: wireStateOf(task.status.state),
  message: statusMessageOf(task),
  timestamp: task.statusAt.toISOString(),
});

/** The output's parts: its text for a text finish, else one `data` part. */
function outputPartsOf(status: A2ATaskStatus, skill: ServedSkill | undefined): Part[] {
  const output = skill?.outputs.find((entry) => entry.finish === status.finish);
  const text: unknown =
    typeof status.output === "object" && status.output !== null
      ? Reflect.get(status.output, "text")
      : undefined;
  return output?.mediaType === A2AMediaType.Text && typeof text === "string"
    ? [textPart(text)]
    : [dataPart(status.output)];
}

/** A completed task's artifact: the finish's output, named by the finish; none before. */
export function outputArtifactOf(
  task: A2ATaskRecord,
  skill: ServedSkill | undefined,
): Artifact | undefined {
  const { status } = task;
  if (status.state !== A2ATaskState.Completed || status.finish === undefined) return undefined;
  return {
    artifactId: `${task.taskId}:output`,
    name: status.finish,
    description: "",
    parts: outputPartsOf(status, skill),
    metadata: { [A2A_SKILLS_EXTENSION]: { finish: status.finish } },
    extensions: [],
  };
}

/** A kept task as the wire shows it (`skills`: what its output's parts are). */
export function wireTaskOf(task: A2ATaskRecord, skills: readonly ServedSkill[]): Task {
  const artifact = outputArtifactOf(
    task,
    skills.find((skill) => skill.id === task.skill),
  );
  return {
    id: task.taskId,
    contextId: task.contextId,
    status: wireStatusOf(task),
    artifacts: artifact === undefined ? [] : [artifact],
    history: [],
    metadata: undefined,
  };
}
