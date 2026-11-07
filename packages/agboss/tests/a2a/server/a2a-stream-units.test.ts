/**
 * #824 (mutation shard `a2a-server`): a task's stream on its own — the task first, each status
 * change (a completed one's output artifact before it, its parts by the task's own skill), the
 * text and tool calls its run here streams (heard at once, each once, also when they come while
 * the reader is away, also from a run started after the stream), the end at a terminal state or —
 * a send's stream — at a rest past the version a follow-up answered, and no listener left behind.
 */
import type { Part, StreamResponse } from "@a2a-js/sdk";
import { InMemoryTaskStore, ResultManager, ServerCallContext } from "@a2a-js/sdk/server";
import { describe, expect, it } from "vitest";
import { A2AMediaType, type ServedSkill } from "../../../src/a2a/server/a2a-skills.js";
import { StreamEnd, taskStream } from "../../../src/a2a/server/a2a-stream.js";
import { taskKeyOf } from "../../../src/a2a/server/a2a-server-parts.js";
import { textPart, wireStatusOf, wireTaskOf } from "../../../src/a2a/server/a2a-task-view.js";
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

/** A chunk of the task's output artifact (#833): the stream's first starts it, the next append. */
const delta = (task: A2ATaskRecord, text: string, append: boolean): StreamResponse => ({
  payload: {
    $case: "artifactUpdate",
    value: {
      ...ids(task),
      metadata: undefined,
      artifact: {
        artifactId: `${task.taskId}:output`,
        name: "",
        description: "",
        parts: [textPart(text)],
        metadata: undefined,
        extensions: [],
      },
      append,
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

    expect(first).toStrictEqual(delta(task, "he", false));
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
    expect([away, after]).toStrictEqual([delta(task, "llo", true), "stuck"]);
    script.state = {
      status: DurableExecutionStatus.Finished,
      finish: FINISH,
      output: { text: "done" },
      spentUsd: 0,
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

    expect(await nextOf(stream)).toStrictEqual(delta(task, "hi", false));
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

/**
 * The artifacts a client ends with that applies every event as A2A v1.0 says — by the SDK's own
 * task builder (`ResultManager`, its server's): append to the artifact of that id, else replace.
 */
async function appliedArtifacts(events: readonly (StreamResponse | string)[]) {
  const manager = new ResultManager(new InMemoryTaskStore(), new ServerCallContext());
  for (const event of events) {
    if (typeof event === "string" || event.payload === undefined) continue;
    const { $case, value } = event.payload;
    await manager.processEvent({ kind: $case, data: value } as Parameters<
      ResultManager["processEvent"]
    >[0]);
  }
  return manager.getCurrentTask()?.artifacts;
}

/** The events up to the stream's end, or until none comes ("stuck"): at most `limit` of them. */
async function restOf(stream: AsyncGenerator<StreamResponse>, limit = 10) {
  const events: StreamResponse[] = [];
  for (let count = 0; count < limit; count += 1) {
    const read = await nextOf(stream);
    if (typeof read === "string") return events;
    events.push(read);
  }
  throw new Error(`more than ${String(limit)} events`);
}

/** The text each artifact holds, joined. */
const artifactTextOf = (artifacts: readonly { parts: readonly Part[] }[] | undefined) =>
  (artifacts ?? []).map(({ parts }) =>
    parts.map((part) => (part.content?.$case === "text" ? part.content.value : "")).join(""),
  );

describe("#833: the streamed text is the chunks of the task's one artifact, its output", () => {
  it("AC: chunks then the output — a client applying them ends with GetTask's artifacts", async () => {
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
    const events: (StreamResponse | string)[] = [await nextOf(stream)];

    emit({ kind: "textDelta", delta: "do" });
    events.push(await nextOf(stream));
    emit({ kind: "textDelta", delta: "ne" });
    events.push(await nextOf(stream));
    const chunked = await appliedArtifacts(events);
    script.state = {
      status: DurableExecutionStatus.Finished,
      finish: FINISH,
      output: { text: "done" },
      spentUsd: 0,
    };
    finish();
    events.push(...(await restOf(stream)));
    const ended = await parts.tasks.findById(taskKeyOf(task));
    if (ended === undefined) throw new Error("no task");

    expect(events.slice(1, 3)).toStrictEqual([delta(task, "do", false), delta(task, "ne", true)]);
    expect(chunked).toStrictEqual([
      {
        artifactId: `${task.taskId}:output`,
        name: "",
        description: "",
        parts: [textPart("do"), textPart("ne")],
        metadata: undefined,
        extensions: [],
      },
    ]);
    expect(ended.status.state).toBe(A2ATaskState.Completed);
    expect(await appliedArtifacts(events)).toStrictEqual(wireTaskOf(ended, parts).artifacts);
    expect(wireTaskOf(ended, parts).artifacts).toHaveLength(1);
    expect(artifactTextOf(await appliedArtifacts(events))).toEqual(["done"]);
  });

  it("a tool call before the first chunk: that chunk still starts the artifact", async () => {
    const { task, runs, parts } = await setUp();
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
    await nextOf(stream);
    emit({ kind: "textDelta", delta: "hi" });

    expect(await nextOf(stream)).toStrictEqual(delta(task, "hi", false));
  });

  it("each stream starts the artifact anew: a second subscriber's first chunk is not appended", async () => {
    const { task, runs, parts } = await setUp();
    let emit: (event: ExecutionStreamEvent) => void = () => undefined;
    void runs.start(task, (onStream) => {
      emit = onStream;
      return new Promise<void>(() => undefined);
    });
    const signal = new AbortController().signal;
    const first = taskStream(parts, task, { end: StreamEnd.Terminal, signal });
    await nextOf(first);
    emit({ kind: "textDelta", delta: "a" });
    await nextOf(first);
    const second = taskStream(parts, task, { end: StreamEnd.Terminal, signal });
    await nextOf(second);

    emit({ kind: "textDelta", delta: "b" });

    expect(await nextOf(first)).toStrictEqual(delta(task, "b", true));
    expect(await nextOf(second)).toStrictEqual(delta(task, "b", false));
  });

  it("a subscription through a pause and its resume: the resumed run's first chunk starts the artifact anew", async () => {
    const { tasks, task, runs, parts } = await setUp();
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
    const events = [await nextOf(stream)];
    emit({ kind: "textDelta", delta: "Which order?" });
    events.push(await nextOf(stream));
    await written(tasks, task, INPUT_REQUIRED);
    finish();
    events.push(...(await restOf(stream)));
    // the run's end read against its records (scripted: still working) — the task as it is now
    const paused = await tasks.findById(taskKeyOf(task));
    if (paused === undefined) throw new Error("no task");

    void runs.start(task, (onStream) => {
      emit = onStream;
      return new Promise<void>(() => undefined);
    });
    await written(tasks, paused, WORKING);
    events.push(...(await restOf(stream)));
    emit({ kind: "textDelta", delta: "Order 7 shipped." });
    const resumed = await nextOf(stream);

    expect(events[1]).toStrictEqual(delta(task, "Which order?", false));
    expect(resumed).toStrictEqual(delta(task, "Order 7 shipped.", false));
    expect(artifactTextOf(await appliedArtifacts([...events, resumed]))).toEqual([
      "Order 7 shipped.",
    ]);
  });
});
