/**
 * #824 (mutation shard `a2a-server`): a task's stream on its own — the task first, each status
 * change (a completed one's output artifact before it, its parts by the task's own skill), the
 * text and tool calls its run here streams (heard at once, each once, also when they come while
 * the reader is away, also from a run started after the stream), the end at a terminal state or —
 * a send's stream — at a rest past the version a follow-up answered, and no listener left behind.
 */
import type { StreamResponse } from "@a2a-js/sdk";
import { describe, expect, it } from "vitest";
import { A2AMediaType, type ServedSkill } from "../../../src/a2a/server/a2a-skills.js";
import { StreamEnd, taskStream } from "../../../src/a2a/server/a2a-stream.js";
import { textPart, wireStatusOf } from "../../../src/a2a/server/a2a-task-view.js";
import { LocalRuns } from "../../../src/a2a/server/a2a-local-runs.js";
import { taskChanged } from "../../../src/a2a/tasks/task-changes.js";
import { DurableExecutionStatus } from "../../../src/app/execution-control.js";
import {
  A2ATaskState,
  type A2ATaskRecord,
  type A2ATaskStatus,
} from "../../../src/infrastructure/a2a-task.repository.js";
import { InMemoryA2ATaskRepository } from "../../../src/infrastructure/in-memory-a2a-task.repository.js";
import { InMemoryDatabase } from "../../../src/infrastructure/in-memory-database.js";
import type { ExecutionStreamEvent } from "../../../src/run/types.js";
import {
  NINE,
  savedTask,
  scriptOf,
  settle,
  TEXT_SKILL,
  unitParts,
  WORKING,
} from "./support/unit-parts.js";

const FINISH = "unit-workflow-finish";
/** Two skills with one finish name: the task's is the second, a text one. */
const SKILLS: readonly ServedSkill[] = [
  {
    ...TEXT_SKILL,
    id: "json-out",
    outputs: [{ finish: FINISH, mediaType: A2AMediaType.Json, schema: null }],
  },
  {
    ...TEXT_SKILL,
    id: "text-out",
    outputs: [{ finish: FINISH, mediaType: A2AMediaType.Text, schema: null }],
  },
];
const COMPLETED: A2ATaskStatus = {
  state: A2ATaskState.Completed,
  pendingPauses: [],
  finish: FINISH,
  output: { text: "done" },
};
const INPUT_REQUIRED: A2ATaskStatus = { state: A2ATaskState.InputRequired, pendingPauses: [] };

/** This process's runs, counting the listeners still attached. */
class CountedRuns extends LocalRuns {
  active = 0;

  override listen(...args: Parameters<LocalRuns["listen"]>): () => void {
    this.active += 1;
    const stop = super.listen(...args);
    let isStopped = false;
    return () => {
      if (!isStopped) this.active -= 1;
      isStopped = true;
      stop();
    };
  }
}

async function setUp(status: A2ATaskStatus = WORKING, skill = "text-out") {
  const tasks = new InMemoryA2ATaskRepository(new InMemoryDatabase());
  const task = await savedTask(tasks, { skill }, status);
  const runs = new CountedRuns();
  const script = scriptOf();
  const parts = unitParts(script, tasks, { skills: SKILLS, runs });
  return { tasks, task, runs, script, parts };
}

const pendingNext = new WeakMap<object, Promise<IteratorResult<StreamResponse>>>();

/** The next event, or "stuck" when none comes without a change (the read kept for the next call). */
const nextOf = async (stream: AsyncGenerator<StreamResponse>) => {
  const next = pendingNext.get(stream) ?? stream.next();
  pendingNext.set(stream, next);
  const read = await Promise.race([next, settle().then(() => "stuck" as const)]);
  if (read === "stuck") return read;
  pendingNext.delete(stream);
  return read.done === true ? "done" : read.value;
};

const ids = (task: A2ATaskRecord) => ({ taskId: task.taskId, contextId: task.contextId });

const delta = (task: A2ATaskRecord, text: string): StreamResponse => ({
  payload: {
    $case: "artifactUpdate",
    value: {
      ...ids(task),
      metadata: undefined,
      artifact: {
        artifactId: "stream",
        name: "",
        description: "",
        parts: [textPart(text)],
        metadata: undefined,
        extensions: [],
      },
      append: true,
      lastChunk: false,
    },
  },
});

async function written(
  tasks: InMemoryA2ATaskRepository,
  task: A2ATaskRecord,
  status: A2ATaskStatus,
) {
  const next = await tasks.compareAndSetStatus(task, task.version, status, NINE);
  if (next === undefined) throw new Error("not written");
  taskChanged(task);
  return next;
}

describe("#824: a task's stream", () => {
  it("the task, then a completed change: its output by its own skill, then its status; the end", async () => {
    const { tasks, task, runs, parts } = await setUp();
    const stream = taskStream(parts, task, {
      end: StreamEnd.Terminal,
      signal: new AbortController().signal,
    });

    expect(await nextOf(stream)).toMatchObject({
      payload: { $case: "task", value: { id: task.taskId } },
    });
    expect(await nextOf(stream)).toBe("stuck");
    const completed = await written(tasks, task, COMPLETED);

    expect(await nextOf(stream)).toStrictEqual({
      payload: {
        $case: "artifactUpdate",
        value: {
          ...ids(task),
          artifact: {
            artifactId: `${task.taskId}:output`,
            name: FINISH,
            description: "",
            parts: [textPart("done")],
            metadata: { "https://agboss.dev/a2a/skills/v1": { finish: FINISH } },
            extensions: [],
          },
          append: false,
          lastChunk: true,
          metadata: undefined,
        },
      },
    });
    expect(await nextOf(stream)).toStrictEqual({
      payload: {
        $case: "statusUpdate",
        value: { ...ids(task), status: wireStatusOf(completed), metadata: undefined },
      },
    });
    expect(await nextOf(stream)).toBe("done");
    expect(runs.active).toBe(0);
  });

  it("a change that completes nothing: its status only", async () => {
    const { tasks, task, parts } = await setUp(WORKING, "json-out");
    const stream = taskStream(parts, task, {
      end: StreamEnd.Terminal,
      signal: new AbortController().signal,
    });
    await nextOf(stream);
    expect(await nextOf(stream)).toBe("stuck");

    const changed = await written(tasks, task, {
      ...WORKING,
      message: "awaiting finance out of band",
    });

    expect(await nextOf(stream)).toStrictEqual({
      payload: {
        $case: "statusUpdate",
        value: { ...ids(task), status: wireStatusOf(changed), metadata: undefined },
      },
    });
    expect(await nextOf(stream)).toBe("stuck");
  });

  it("its run's text and tool calls at once, each once, also while away; its end read from the records", async () => {
    const { task, runs, script, parts } = await setUp();
    let emit: (event: ExecutionStreamEvent) => void = () => undefined;
    let finish = (): void => undefined;
    void runs.start(task, (onStream) => {
      emit = onStream;
      return new Promise<void>((resolve) => (finish = resolve));
    });
    const stream = taskStream(parts, task, {
      end: StreamEnd.Terminal,
      signal: new AbortController().signal,
    });
    await nextOf(stream);

    emit({ kind: "textDelta", delta: "he" });
    emit({ kind: "toolCall", tool: "lookup-tool" });
    const first = await nextOf(stream);
    const tool = await nextOf(stream);
    emit({ kind: "textDelta", delta: "llo" });
    const away = await nextOf(stream);
    const after = await nextOf(stream);

    expect(first).toStrictEqual(delta(task, "he"));
    expect(tool).toStrictEqual({
      payload: {
        $case: "statusUpdate",
        value: {
          ...ids(task),
          metadata: undefined,
          status: {
            ...wireStatusOf(task),
            message: {
              messageId: `${task.taskId}:tool:2`,
              contextId: task.contextId,
              taskId: task.taskId,
              role: 2,
              parts: [textPart("calling lookup-tool")],
              metadata: undefined,
              extensions: [],
              referenceTaskIds: [],
            },
          },
        },
      },
    });
    expect([away, after]).toStrictEqual([delta(task, "llo"), "stuck"]);
    script.state = {
      status: DurableExecutionStatus.Finished,
      finish: FINISH,
      output: { text: "done" },
    };
    finish();
    expect(await nextOf(stream)).toMatchObject({ payload: { $case: "artifactUpdate" } });
    expect(await nextOf(stream)).toMatchObject({ payload: { $case: "statusUpdate" } });
    expect(await nextOf(stream)).toBe("done");
    expect(runs.active).toBe(0);
  });

  it("a tool call of a task with a status message: that message, its parts the call", async () => {
    const { task, runs, parts } = await setUp({
      ...WORKING,
      message: "awaiting finance out of band",
    });
    let emit: (event: ExecutionStreamEvent) => void = () => undefined;
    void runs.start(task, (onStream) => {
      emit = onStream;
      return new Promise<void>(() => undefined);
    });
    const stream = taskStream(parts, task, {
      end: StreamEnd.Terminal,
      signal: new AbortController().signal,
    });
    await nextOf(stream);

    emit({ kind: "toolCall", tool: "lookup-tool" });
    const shown = await nextOf(stream);

    const status = wireStatusOf(task);
    expect(shown).toStrictEqual({
      payload: {
        $case: "statusUpdate",
        value: {
          ...ids(task),
          metadata: undefined,
          status: {
            ...status,
            message: { ...status.message, parts: [textPart("calling lookup-tool")] },
          },
        },
      },
    });
  });

  it("a run started after the stream is heard once the stream read a change", async () => {
    const { tasks, task, runs, parts } = await setUp();
    const stream = taskStream(parts, task, {
      end: StreamEnd.Terminal,
      signal: new AbortController().signal,
    });
    await nextOf(stream);
    expect(await nextOf(stream)).toBe("stuck");
    let emit: (event: ExecutionStreamEvent) => void = () => undefined;
    void runs.start(task, (onStream) => {
      emit = onStream;
      return new Promise<void>(() => undefined);
    });

    await written(tasks, task, { ...WORKING, message: "resumed" });
    expect(await nextOf(stream)).toMatchObject({ payload: { $case: "statusUpdate" } });
    expect(await nextOf(stream)).toBe("stuck");
    emit({ kind: "textDelta", delta: "hi" });

    expect(await nextOf(stream)).toStrictEqual(delta(task, "hi"));
  });

  it("a send's stream ends at a rest past the version its follow-up answered; a subscription waits on", async () => {
    const waiting = await setUp(INPUT_REQUIRED);
    const signal = new AbortController().signal;
    const atRest = taskStream(waiting.parts, waiting.task, { end: StreamEnd.Rest, signal });
    const answered = taskStream(waiting.parts, waiting.task, {
      end: StreamEnd.Rest,
      signal,
      answered: 2,
    });
    const subscribed = taskStream(waiting.parts, waiting.task, { end: StreamEnd.Terminal, signal });
    for (const stream of [atRest, answered, subscribed]) await nextOf(stream);

    expect([await nextOf(atRest), await nextOf(answered), await nextOf(subscribed)]).toEqual([
      "done",
      "stuck",
      "stuck",
    ]);
    const asked = await written(waiting.tasks, waiting.task, {
      ...INPUT_REQUIRED,
      message: "again",
    });
    expect(await nextOf(answered)).toMatchObject({
      payload: { value: { status: wireStatusOf(asked) } },
    });
    expect(await nextOf(answered)).toBe("done");
  });
});
