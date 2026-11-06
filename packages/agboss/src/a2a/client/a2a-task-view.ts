import type {
  Artifact,
  StreamResponse,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
import { A2ARemoteCallError, A2ARemoteCallReason } from "./a2a-client-errors.js";

/**
 * The task a wait follows (#809), as its events and reads change it — each one checked to be of
 * that task: an agent cannot settle a call with another task's state or artifacts.
 */

/** What the view knows of the call: whose task it is. */
export interface TaskViewOf {
  readonly agent: string;
  readonly taskId: string;
}

const malformed = (of: TaskViewOf): A2ARemoteCallError =>
  new A2ARemoteCallError({
    agent: of.agent,
    reason: A2ARemoteCallReason.MalformedAnswer,
    taskId: of.taskId,
  });

/** `task` when it is the one waited for; else the answer is malformed. */
export function checkedTask(of: TaskViewOf, task: Task): Task {
  if (task.id !== of.taskId) throw malformed(of);
  return task;
}

/** An artifact merged into a task's: appended to the one of its id, or in its place. */
function withArtifact(task: Task, artifact: Artifact, isAppend: boolean): Task {
  const earlier = task.artifacts.find((each) => each.artifactId === artifact.artifactId);
  const others = task.artifacts.filter((each) => each.artifactId !== artifact.artifactId);
  const merged =
    isAppend && earlier !== undefined
      ? { ...earlier, parts: [...earlier.parts, ...artifact.parts] }
      : artifact;
  return { ...task, artifacts: [...others, merged] };
}

/**
 * A task with a status update of this task applied (before the first task: nothing to change) — its
 * status, and the update's metadata over the task's (#810: an AGBoss agent's run report).
 */
function withStatus(
  of: TaskViewOf,
  task: Task | undefined,
  update: TaskStatusUpdateEvent,
): Task | undefined {
  if (update.taskId !== of.taskId) throw malformed(of);
  if (task === undefined) return undefined;
  // an update's metadata is the task's from then on (#810: the run report rides the last one)
  const metadata =
    update.metadata === undefined ? task.metadata : { ...task.metadata, ...update.metadata };
  return { ...task, status: update.status, metadata };
}

/** A task with an artifact update of this task applied. */
function withArtifactUpdate(
  of: TaskViewOf,
  task: Task | undefined,
  update: TaskArtifactUpdateEvent,
): Task | undefined {
  if (update.taskId !== of.taskId) throw malformed(of);
  const { artifact } = update;
  return task === undefined || artifact === undefined
    ? task
    : withArtifact(task, artifact, update.append);
}

/**
 * A task updated by one stream event: a whole task replaces it, a status or an artifact update
 * changes it — each of this task only (another id, or a message in a task's stream, is malformed).
 */
export function updatedTask(
  of: TaskViewOf,
  task: Task | undefined,
  event: StreamResponse,
): Task | undefined {
  const payload = event.payload;
  switch (payload?.$case) {
    case "task":
      return checkedTask(of, payload.value);
    case "statusUpdate":
      return withStatus(of, task, payload.value);
    case "artifactUpdate":
      return withArtifactUpdate(of, task, payload.value);
    case "message":
      throw malformed(of); // a subscription carries the task's events only
    default:
      return task;
  }
}
