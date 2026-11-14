import type { StreamResponse } from "@a2a-js/sdk";
import { A2ATaskState, type A2ATaskRecord } from "../../infrastructure/a2a-task.repository.js";
import type { ExecutionStreamEvent, StreamStep } from "../../run/types.js";
import { outputArtifactIdOf, textPart } from "./a2a-task-view.js";

/**
 * What a streaming client shows of a task's output artifact (#833, #1006): the text of exactly one
 * step — the last one that streamed. A delta of another step (a retry, the turn after a tool call,
 * another branch) is the first chunk of a new view and replaces the old (`append: false`); a retraction
 * of the step shown replaces it with nothing; and a task that ends without completing replaces what
 * it showed with an empty last chunk, so the client's view never keeps rejected text.
 */

const sameStep = (left: StreamStep, right: StreamStep): boolean =>
  left.agent === right.agent &&
  left.visit === right.visit &&
  left.branch === right.branch &&
  left.attempt === right.attempt;

/** The states that end a task without an output. */
const WITHOUT_OUTPUT: ReadonlySet<A2ATaskState> = new Set<A2ATaskState>([
  A2ATaskState.Failed,
  A2ATaskState.Canceled,
  A2ATaskState.Rejected,
]);

/** An artifact chunk of the task's output. */
function chunkOf(
  task: A2ATaskRecord,
  text: string,
  flags: { readonly append: boolean; readonly lastChunk: boolean },
): StreamResponse {
  return {
    payload: {
      $case: "artifactUpdate",
      value: {
        taskId: task.taskId,
        contextId: task.contextId,
        artifact: {
          artifactId: outputArtifactIdOf(task.taskId),
          name: "",
          description: "",
          parts: [textPart(text)],
          metadata: undefined,
          extensions: [],
        },
        ...flags,
        metadata: undefined,
      },
    },
  };
}

/** The client's view of one task's output artifact, as its stream has made it. */
export class ArtifactView {
  #step: StreamStep | undefined;
  #touched = false;

  /** A run heard anew (a resume's turn): its first chunk starts the artifact over. */
  restart(): void {
    this.#step = undefined;
  }

  /** The chunk a text event is, `undefined` for an event that is no text. */
  textOf(task: A2ATaskRecord, event: ExecutionStreamEvent): StreamResponse | undefined {
    if (event.kind !== "textDelta") return undefined;
    const append = this.#step !== undefined && sameStep(this.#step, event.step);
    this.#step = event.step;
    this.#touched = true;
    return chunkOf(task, event.delta, { append, lastChunk: false });
  }

  /** The replacement a retraction of the step shown is; nothing for a step that is not shown. */
  retractionOf(task: A2ATaskRecord, event: ExecutionStreamEvent): StreamResponse | undefined {
    if (event.kind !== "discarded") return undefined;
    if (this.#step === undefined || !sameStep(this.#step, event.step)) return undefined;
    this.#step = undefined;
    return chunkOf(task, "", { append: false, lastChunk: false });
  }

  /** The last chunk of a task that ends without an output, when its stream showed any text. */
  closing(task: A2ATaskRecord): StreamResponse[] {
    if (!this.#touched || !WITHOUT_OUTPUT.has(task.status.state)) return [];
    this.#step = undefined;
    this.#touched = false;
    return [chunkOf(task, "", { append: false, lastChunk: true })];
  }
}
