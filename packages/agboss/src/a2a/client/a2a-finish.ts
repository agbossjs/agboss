import type { Message, Task } from "@a2a-js/sdk";
import { A2AError } from "../../core/error-families/remote-errors.js";
import { A2A_SKILLS_EXTENSION } from "../a2a-extension-uris.js";
import { safeTaskIdOf } from "./a2a-task-errors.js";

/**
 * The finish an AGBoss answer ended at (#916): a task's output artifact — or a direct message —
 * names it in `metadata[skills-uri].finish`. A typed client that takes only some of its skill's
 * finishes (`target.finishes`) gets `A2AError.UnexpectedFinish` for any other, before its output is
 * read; an answer that names no finish (a foreign agent's) is read as before.
 */

/** A finish name as a card lists it (`refund-workflow-finish`); anything else is never shown. */
const FINISH_NAME = /^[a-z][a-z0-9-]{0,199}$/u;

const finishIn = (metadata: Readonly<Record<string, unknown>> | undefined): unknown => {
  const entry: unknown = metadata?.[A2A_SKILLS_EXTENSION];
  return typeof entry === "object" && entry !== null ? Reflect.get(entry, "finish") : undefined;
};

/** The finish an answer names: `null` for none, `""` for a name no card could list. */
function namedFinishOf(answer: Task | Message): string | null {
  const named =
    "messageId" in answer
      ? [finishIn(answer.metadata)]
      : answer.artifacts.map((artifact) => finishIn(artifact.metadata));
  const found = named.find((finish) => finish !== undefined);
  if (found === undefined) return null;
  return typeof found === "string" && FINISH_NAME.test(found) ? found : "";
}

/** Throws `A2AError.UnexpectedFinish` when `answer` names a finish outside `finishes`. */
export function assertTakenFinish(
  agent: string,
  finishes: readonly string[] | undefined,
  answer: Task | Message | undefined,
): void {
  if (finishes === undefined || answer === undefined) return;
  const finish = namedFinishOf(answer);
  if (finish === null || finishes.includes(finish)) return;
  const taskId = "messageId" in answer ? undefined : safeTaskIdOf(answer.id);
  throw new A2AError.UnexpectedFinish({
    agent,
    finish: finish === "" ? undefined : finish,
    finishes,
    taskId,
  });
}
