import { AGBossError } from "../../../../src/core/errors.js";
import { Integer, ListOf, OneOf, Text } from "../../../../src/dto/index.js";
import {
  Action,
  Clock,
  ExecutionContext,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Produced,
} from "../../../../src/index.js";
import { seconds } from "../../../../src/units/index.js";
import { start } from "../../../helpers/flow.js";

/**
 * #264 PR 2 — the tree's concurrency cap, `@Workflow({ maxConcurrentExecutions })`. Every task is a
 * child execution whose one action works for its `seconds` on the application's clock; the log
 * shows what started and ended, in order, and the most tasks at work at once. A task `fail`s after
 * its wait (none for 0 seconds); the first run of a `hold` task waits until its execution stops (a
 * crash).
 */

export class TaskDto {
  @Text({ prompt: "the task's name" })
  name!: string;

  @Integer({ prompt: "how long it works, in seconds" })
  seconds!: number;

  @OneOf({ values: ["ok", "fail", "hold"], prompt: "how it ends" })
  outcome!: "ok" | "fail" | "hold";
}

export class TaskDoneDto {
  @Text({ prompt: "the task done" })
  name!: string;
}

export class GroupDto {
  @Text({ prompt: "the group's name" })
  name!: string;

  @ListOf(TaskDto, { prompt: "its tasks" })
  tasks!: TaskDto[];
}

export class GroupDoneDto {
  @Text({ prompt: "the group done" })
  name!: string;
}

/** A task that cannot be done: the domain error inside `ActionFailedError`. */
export class TaskFailedError extends AGBossError {
  static override readonly code: string = "test.task-failed";
}

/** What worked, in order, and the most tasks at work at once. */
export const treeLog = { events: [] as string[], working: 0, mostWorking: 0 };

export function resetTreeLog(): void {
  treeLog.events.length = 0;
  treeLog.working = 0;
  treeLog.mostWorking = 0;
}

/** Resolves once `event` is in the log; rejects when it never comes (the test fails, no busy loop). */
export async function untilLogged(event: string): Promise<void> {
  for (let tick = 0; !treeLog.events.includes(event); tick += 1) {
    if (tick > 200_000) throw new Error(`"${event}" never came: ${treeLog.events.join(", ")}`);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

/** Waits until its execution stops; never resolves on its own. */
function untilStopped(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      reject(new Error("stopped"));
    });
  });
}

@Action({
  name: "work-action",
  description: "Works on one task for its seconds",
  input: { task: TaskDto },
  output: TaskDoneDto,
  deps: [Clock, ExecutionContext],
})
export class WorkAction {
  constructor(
    private readonly clock: Clock,
    private readonly executionContext: ExecutionContext,
  ) {}

  async execute(input: { readonly task: Produced<TaskDto, unknown> }): Promise<TaskDoneDto> {
    const { name, outcome } = input.task.value;
    const isFirstHold = outcome === "hold" && !treeLog.events.includes(`start ${name}`);
    treeLog.events.push(`start ${name}`);
    treeLog.working += 1;
    treeLog.mostWorking = Math.max(treeLog.mostWorking, treeLog.working);
    try {
      const { signal } = this.executionContext;
      if (isFirstHold) await untilStopped(signal);
      const wait = input.task.value.seconds;
      if (wait > 0) await this.clock.sleep(seconds(wait), signal);
      if (signal.aborted) {
        treeLog.events.push(`cancelled ${name}`);
        throw new TaskFailedError(`${name} was cancelled`);
      }
      if (outcome === "fail") throw new TaskFailedError(`${name} cannot be done`);
      treeLog.events.push(`end ${name}`);
      return { name };
    } finally {
      treeLog.working -= 1;
    }
  }
}

@WorkflowStart({ name: "task-workflow-start", description: "One task", input: TaskDto })
export class TaskWorkflowStart {}

@WorkflowFinish({ name: "task-done-workflow-finish", description: "Done", output: TaskDoneDto })
export class TaskDoneWorkflowFinish {}

@Workflow({
  name: "task-workflow",
  version: "1.0.0",
  flow: [
    start(TaskWorkflowStart)
      .returns(TaskDto)
      .toAction(WorkAction)
      .returns(TaskDoneDto)
      .toFinish(TaskDoneWorkflowFinish),
  ],
})
export class TaskWorkflow {}
