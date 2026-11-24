import type { AnyTenantApp, ExecutionOutput } from "../../app/types.js";
import { sendToTest } from "./fixture/pod-link.js";
import type { PodCommand } from "./pod-protocol.js";

/**
 * The calls a fault pod makes for its test in the background (#959, #941, #946): an `execute`, a
 * resume, a cancel or a reassignment — each ends as an event under the call's tag, its outcome or its failure.
 */

/** What a test reads of a finished `execute` or `resume`; a rest lists the ids of its pauses (#959). */
const outcomeOf = (done: ExecutionOutput) => ({
  status: done.status,
  executionId: done.executionId,
  output: done.output,
  finish: done.finish?.name,
  pauseIds: done.pending.flatMap((pause) => (pause.pauseId === undefined ? [] : [pause.pauseId])),
});

/** What a test is told of a call that ended: its outcome or its failure, under the call's tag. */
export function told(tag: string, call: Promise<ExecutionOutput>, failed: string): void {
  call.then(
    (done) => {
      sendToTest({ kind: "event", event: { type: "finished", tag, ...outcomeOf(done) } });
    },
    (error: unknown) => {
      const name = error instanceof Error ? error.name : typeof error;
      sendToTest({
        kind: "event",
        event: { type: failed, tag, error: name, message: String(error) },
      });
    },
  );
}

/** `app.cancel` of a thread in the background: its end is an event under the call's tag. */
function cancelled(app: AnyTenantApp, tag: string, threadId: string): void {
  app.cancel(threadId).then(
    (done) => {
      sendToTest({ kind: "event", event: { type: "cancelled", tag, ...done } });
    },
    (error: unknown) => {
      sendToTest({
        kind: "event",
        event: { type: "cancel-failed", tag, error: error instanceof Error ? error.name : "" },
      });
    },
  );
}

/** `app.reassignPause` in the background (#946): its end is an event under the call's tag. */
function reassigned(app: AnyTenantApp, tag: string, pauseId: string, assignee: string): void {
  app.reassignPause({ pauseId, assignees: [assignee] }).then(
    () => {
      sendToTest({ kind: "event", event: { type: "reassigned", tag } });
    },
    (error: unknown) => {
      const name = error instanceof Error ? error.name : typeof error;
      sendToTest({ kind: "event", event: { type: "reassign-failed", tag, error: name } });
    },
  );
}

/** A resume (#959), a cancel (#941) or a reassignment (#946) of a pause or a thread, started in the background; its tag. */
function calledInBackground(
  app: AnyTenantApp,
  command: Extract<PodCommand, { readonly op: "resume" | "cancel" | "reassign" }>,
): string {
  if (command.op === "cancel") cancelled(app, command.tag, command.threadId);
  else if (command.op === "reassign")
    reassigned(app, command.tag, command.pauseId, command.assignee);
  else
    told(
      command.tag,
      app.resume({ pauseId: command.pauseId, decision: { approved: true } }),
      "resume-failed",
    );
  return command.tag;
}

/** A resume, a cancel or a reassignment started in the background: its tag; `undefined` for another command. */
export function calledDone(app: AnyTenantApp, command: PodCommand): string | undefined {
  switch (command.op) {
    case "resume":
    case "cancel":
    case "reassign":
      return calledInBackground(app, command);
    default:
      return undefined;
  }
}
