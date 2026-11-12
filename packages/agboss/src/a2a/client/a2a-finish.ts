import type { Message, Task } from "@a2a-js/sdk";
import { AGBossError } from "../../core/errors.js";
import { A2A_SKILLS_EXTENSION } from "../a2a-extension-uris.js";
import { safeTaskIdOf } from "./a2a-task-errors.js";

/**
 * The finish an AGBoss answer ended at (#916): a task's output artifact — or a direct message —
 * names it in `metadata[skills-uri].finish`. A typed client that takes only some of its skill's
 * finishes (`target.finishes`) gets `A2AUnexpectedFinishError` for any other, before its output is
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

/** What an unexpected finish knows: the agent, the finish, the ones the client takes, the task. */
export interface A2AUnexpectedFinishErrorOptions {
  readonly agent: string;
  /** The finish the answer named; `undefined` when its name is not one a card could list. */
  readonly finish: string | undefined;
  /** The finishes the client takes (`target.finishes`). */
  readonly finishes: readonly string[];
  readonly taskId: string | undefined;
  readonly cause?: unknown;
}

/**
 * The agent's answer ended at a finish the typed client does not take (#916): its `@A2AAgent({
 * target: { finishes } })` names others. Raised before the output is read, so a side path —
 * `.onError(A2AUnexpectedFinishError, …)` — takes it, never a generic validation failure.
 */
export class A2AUnexpectedFinishError extends AGBossError {
  static override readonly code = "a2a.unexpected-finish" as const;
  declare readonly code: typeof A2AUnexpectedFinishError.code;
  override name = "A2AUnexpectedFinishError";
  readonly agent: string;
  readonly finish: string | undefined;
  readonly finishes: readonly string[];
  readonly taskId: string | undefined;

  constructor(options: A2AUnexpectedFinishErrorOptions) {
    const ended = options.finish ?? "a finish of no valid name";
    super(
      `A2A agent ${options.agent} ended at ${ended}, not one of the finishes the client takes (${options.finishes.join(", ")})`,
      {
        cause: options.cause,
        details: {
          agent: options.agent,
          ...(options.finish === undefined ? {} : { finish: options.finish }),
          finishes: [...options.finishes],
          ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
        },
      },
    );
    this.agent = options.agent;
    this.finish = options.finish;
    this.finishes = options.finishes;
    this.taskId = options.taskId;
  }
}

/** Throws `A2AUnexpectedFinishError` when `answer` names a finish outside `finishes`. */
export function assertTakenFinish(
  agent: string,
  finishes: readonly string[] | undefined,
  answer: Task | Message | undefined,
): void {
  if (finishes === undefined || answer === undefined) return;
  const finish = namedFinishOf(answer);
  if (finish === null || finishes.includes(finish)) return;
  const taskId = "messageId" in answer ? undefined : safeTaskIdOf(answer.id);
  throw new A2AUnexpectedFinishError({
    agent,
    finish: finish === "" ? undefined : finish,
    finishes,
    taskId,
  });
}
