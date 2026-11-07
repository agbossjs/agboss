import { Role, type Message, type StreamResponse } from "@a2a-js/sdk";
import {
  isTerminalA2ATaskState,
  type A2ATaskRecord,
} from "../../infrastructure/a2a-task.repository.js";
import type { ExecutionStreamEvent } from "../../run/types.js";
import { changedTask, isAtRest } from "./a2a-task-wait.js";
import { taskKeyOf, type A2AServerParts } from "./a2a-server-parts.js";
import {
  outputArtifactIdOf,
  outputArtifactOf,
  taskMetadataOf,
  textPart,
  wireStatusOf,
  wireTaskOf,
} from "./a2a-task-view.js";

/**
 * A task's changes as a stream (#808, design §3 and §4.1.5): the task first (spec §3.1.6), then each
 * change of its status, the text its run here streams and its tool calls as `WORKING` updates, and —
 * once `COMPLETED` — its output artifact before the last status. A run on another instance streams
 * its status changes only. It ends when the task is over (`SendStreamingMessage`: also when it waits
 * for its caller) or the request's signal aborts — the task never stops with it.
 *
 * The streamed text is a `TaskArtifactUpdateEvent` of the task's one artifact, its output (#833, as
 * A2A v1.0 streams an artifact in chunks): the first chunk of the stream, and of each run it hears
 * (a resume's turn), starts it (`append: false`), each next one is appended to it (`append: true`, `lastChunk: false`), and the finish's output replaces it
 * (`append: false`, `lastChunk: true`). A client that applies every event as the spec says ends with
 * the artifacts `GetTask` returns; one that joins the chunks' text reads the answer once. A task that
 * rests at a pause or ends without completing has no output: its stream's view keeps the text streamed so far, never
 * marked as the last chunk, and `GetTask` shows no artifact.
 */

/** When a stream ends. */
export enum StreamEnd {
  /** At a terminal state (`SubscribeToTask`). */
  Terminal = "terminal",
  /** At a terminal state or `INPUT_REQUIRED` (`SendStreamingMessage`, like a blocking send). */
  Rest = "rest",
}

/** One event of the run streamed here; `append` — a chunk after the stream's first one. */
function eventOf(
  task: A2ATaskRecord,
  event: ExecutionStreamEvent,
  append: boolean,
): StreamResponse {
  const ids = { taskId: task.taskId, contextId: task.contextId, metadata: undefined };
  if (event.kind === "textDelta")
    return {
      payload: {
        $case: "artifactUpdate",
        value: {
          ...ids,
          artifact: {
            artifactId: outputArtifactIdOf(task.taskId),
            name: "",
            description: "",
            parts: [textPart(event.delta)],
            metadata: undefined,
            extensions: [],
          },
          append,
          lastChunk: false,
        },
      },
    };
  const status = wireStatusOf(task);
  const message = {
    ...(status.message ?? emptyMessageOf(task)),
    parts: [textPart(`calling ${event.tool}`)],
  };
  return { payload: { $case: "statusUpdate", value: { ...ids, status: { ...status, message } } } };
}

function emptyMessageOf(task: A2ATaskRecord): Message {
  return {
    messageId: `${task.taskId}:tool:${String(task.version)}`,
    contextId: task.contextId,
    taskId: task.taskId,
    role: Role.ROLE_AGENT,
    // Stryker disable next-line ArrayDeclaration: every use replaces its parts with the tool call's
    parts: [],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

/** A status update; the last one of a completed task carries its metadata (#810: the run report). */
const statusUpdateOf = (parts: A2AServerParts, task: A2ATaskRecord): StreamResponse => ({
  payload: {
    $case: "statusUpdate",
    value: {
      taskId: task.taskId,
      contextId: task.contextId,
      status: wireStatusOf(task),
      metadata: taskMetadataOf(task, parts.mesh),
    },
  },
});

/** The last events of a task that changed: its output artifact (completed), then its status. */
function changeEventsOf(parts: A2AServerParts, task: A2ATaskRecord): StreamResponse[] {
  const skill = parts.skills.find((served) => served.id === task.skill);
  const artifact = outputArtifactOf(task, skill);
  const artifactEvent: StreamResponse[] =
    artifact === undefined
      ? []
      : [
          {
            payload: {
              $case: "artifactUpdate",
              value: {
                taskId: task.taskId,
                contextId: task.contextId,
                artifact,
                append: false,
                lastChunk: true,
                metadata: undefined,
              },
            },
          },
        ];
  return [...artifactEvent, statusUpdateOf(parts, task)];
}

const isEnd = (task: A2ATaskRecord, end: StreamEnd, answered: number): boolean =>
  end === StreamEnd.Rest ? isAtRest(task, answered) : isTerminalA2ATaskState(task.status.state);

/** The task after its next change, or as it was when its run here streamed an event. */
async function changedOrHeard(
  parts: A2AServerParts,
  task: A2ATaskRecord,
  signal: AbortSignal,
  heard: AbortSignal,
): Promise<A2ATaskRecord> {
  const next = await changedTask(parts, task, AbortSignal.any([signal, heard]));
  return next;
}

/** The stream of a task from `task` on. */
export async function* taskStream(
  parts: A2AServerParts,
  task: A2ATaskRecord,
  options: {
    readonly end: StreamEnd;
    readonly signal: AbortSignal;
    /** A follow-up's: the version its answer found (`isAtRest`). */
    readonly answered?: number;
  },
): AsyncGenerator<StreamResponse, void, undefined> {
  const { signal } = options;
  const queued: ExecutionStreamEvent[] = [];
  const key = taskKeyOf(task);
  let current = task;
  let shown = task.version;
  let wake = new AbortController();
  // whether the artifact has a chunk of the run heard: a run's first chunk starts it anew
  let chunked = false;
  let heard = parts.runs.settledOf(key);
  const hear = (event: ExecutionStreamEvent): void => {
    queued.push(event);
    wake.abort();
  };
  let stopListening = parts.runs.listen(key, hear);
  try {
    yield { payload: { $case: "task", value: wireTaskOf(current, parts) } };
    while (!isEnd(current, options.end, options.answered ?? 0) && !signal.aborted) {
      wake = new AbortController();
      if (queued.length === 0) current = await changedOrHeard(parts, current, signal, wake.signal);
      for (const event of queued.splice(0)) {
        yield eventOf(current, event, chunked);
        if (event.kind === "textDelta") chunked = true;
      }
      if (current.version !== shown) {
        shown = current.version;
        yield* changeEventsOf(parts, current);
      }
      // a run started here since (a resume): its stream is heard from now on, its text anew
      stopListening();
      stopListening = parts.runs.listen(key, hear);
      const run = parts.runs.settledOf(key);
      if (run !== heard) chunked = false;
      heard = run;
    }
  } finally {
    stopListening();
  }
}
