/**
 * #1140: a change announced to a task is never lost. A notice (`taskChanged`) reaches only a reader
 * that waits at that moment; one sent while the stream is writing a frame, or a waiter is reading the
 * store, reached nobody, and the reader then waited for the next notice or the poll — on a clock that
 * does not run, for ever. The reader now keeps the notice (`TaskWatch`) and reads the task again
 * before it waits. The invariant: once the task is terminal, the stream ends with no poll at all,
 * whatever the moment the one notice was sent at.
 */
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { StreamEnd, taskStream } from "../../../src/a2a/server/a2a-stream.js";
import { LocalRuns, TASK_POLL } from "../../../src/a2a/server/a2a-local-runs.js";
import { restingTask } from "../../../src/a2a/server/a2a-task-wait.js";
import {
  A2ATaskState,
  type A2ATaskRecord,
  type A2ATaskRepository,
} from "../../../src/infrastructure/a2a-task.repository.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { InMemoryA2ATaskRepository } from "../../../src/infrastructure/in-memory-a2a-task.repository.js";
import { InMemoryDatabase } from "../../../src/infrastructure/in-memory-database.js";
import { taskChanged, waitedTaskCount } from "../../../src/a2a/tasks/task-changes.js";
import { NINE, savedTask, scriptOf, unitParts, WORKING } from "./support/unit-parts.js";

const DONE = {
  state: A2ATaskState.Completed,
  pendingPauses: [],
  finish: "unit-workflow-finish",
  output: { text: "x" },
};

/** What a stream that never ends looks like to a test: real time is the only clock that runs. */
const NEVER_ENDS = Symbol("the stream did not end");

async function harness() {
  const tasks = new InMemoryA2ATaskRepository(new InMemoryDatabase());
  const task = await savedTask(tasks, { skill: "unit-workflow-start" }, WORKING);
  const runs = new LocalRuns();
  const clock = new VirtualClock(NINE); // the parts' clock, the poll's: not advanced unless a test says so
  const parts = unitParts(scriptOf(), tasks, { runs, clock });
  let emit: Parameters<Parameters<LocalRuns["start"]>[1]>[0] = () => undefined;
  void runs.start(task, (onStream) => {
    emit = onStream;
    return new Promise<void>(() => undefined);
  });
  const complete = async (): Promise<void> => {
    await tasks.compareAndSetStatus(task, task.version, DONE, NINE);
  };
  return {
    tasks,
    task,
    parts,
    clock,
    emit: (event: Parameters<typeof emit>[0]) => {
      emit(event);
    },
    complete,
  };
}

/** The next result of `it`, or `NEVER_ENDS` after `ms` of real time. */
async function within(
  it: AsyncGenerator<unknown, void, undefined>,
  ms: number,
): Promise<IteratorResult<unknown, void> | typeof NEVER_ENDS> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<typeof NEVER_ENDS>((resolve) => {
    timer = setTimeout(() => {
      resolve(NEVER_ENDS);
    }, ms);
  });
  try {
    return await Promise.race([it.next(), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The frames of the stream until it ends, the notice sent after the `at`-th frame (`-1`: before the first). */
async function framesWithNoticeAt(at: number): Promise<readonly unknown[] | typeof NEVER_ENDS> {
  const { task, parts, emit, complete } = await harness();
  const stream = taskStream(parts, task, {
    end: StreamEnd.Terminal,
    signal: new AbortController().signal,
  });
  const frames: unknown[] = [];
  const notice = async (): Promise<void> => {
    await complete();
    taskChanged(task); // the one notice, as a real producer sends it
  };
  if (at < 0) await notice();
  for (;;) {
    const next = await within(stream, 1500);
    if (next === NEVER_ENDS) return NEVER_ENDS;
    if (next.done === true) return frames;
    frames.push(next.value);
    if (frames.length === 1 && at !== -1) {
      // the stream is suspended at its first frame (the task): three events for its next batch
      emit({ kind: "toolCall", tool: "a" });
      emit({ kind: "toolCall", tool: "b" });
      emit({ kind: "toolCall", tool: "c" });
    }
    if (frames.length === at + 1) await notice();
  }
}

describe("#1140: the notice is sent at any moment of the stream's writing", () => {
  // -1: before the stream began; 0: at its first frame; 1-3: inside the batch of three events (3: the
  // last of them, the stream about to go round to wait again)
  it.each([-1, 0, 1, 2, 3])(
    "a notice after frame %i: the stream ends, with no poll",
    async (at) => {
      const frames = await framesWithNoticeAt(at);

      expect(frames).not.toBe(NEVER_ENDS);
      const last = (frames as readonly { payload: { $case: string } }[]).at(-1);
      expect(last?.payload.$case).toBe("statusUpdate"); // its last word: the task is completed
      expect(waitedTaskCount()).toBe(0); // and nothing is left subscribed
    },
  );

  it("the notice sent while the stream waits ends it too (the common path)", async () => {
    const { task, parts, complete } = await harness();
    const stream = taskStream(parts, task, {
      end: StreamEnd.Terminal,
      signal: new AbortController().signal,
    });
    const first = await within(stream, 1500);
    expect(first).not.toBe(NEVER_ENDS);
    const waiting = within(stream, 1500);
    await nextTurn();
    await nextTurn();

    await complete();
    taskChanged(task);

    // the closing frames, then the end
    let frames = 0;
    let result = await waiting;
    while (result !== NEVER_ENDS && result.done !== true) {
      frames += 1;
      result = await within(stream, 1500);
    }
    expect(result).not.toBe(NEVER_ENDS);
    expect(frames).toBeGreaterThan(0);
    expect(waitedTaskCount()).toBe(0);
  });

  it("a poll of the stream's own clock ends it too, when no notice came (another instance wrote the task)", async () => {
    const { task, parts, clock, complete } = await harness();
    const stream = taskStream(parts, task, {
      end: StreamEnd.Terminal,
      signal: new AbortController().signal,
    });
    await within(stream, 1500);
    const waiting = within(stream, 1500);
    await nextTurn();
    await nextTurn();

    await complete(); // no notice: the write was another instance's
    for (let polls = 0; polls < 5; polls += 1) {
      await clock.advance(TASK_POLL);
      await nextTurn();
    }

    let result = await waiting;
    while (result !== NEVER_ENDS && result.done !== true) result = await within(stream, 1500);
    expect(result).not.toBe(NEVER_ENDS);
  });
});

/** A store whose first read of the task answers the old record, then writes the task over (and tells it). */
function overwrittenDuringFirstRead(
  tasks: InMemoryA2ATaskRepository,
  task: A2ATaskRecord,
): A2ATaskRepository {
  let first = true;
  return new Proxy(tasks, {
    get(target, property, receiver) {
      if (property !== "findById") return Reflect.get(target, property, receiver) as unknown;
      return async (key: Parameters<A2ATaskRepository["findById"]>[0]) => {
        const read = await target.findById(key);
        if (first) {
          first = false;
          await target.compareAndSetStatus(task, task.version, DONE, NINE);
          taskChanged(task); // announced while this read is on its way back: nobody waits
        }
        return read;
      };
    },
  });
}

describe("#1140: a waiter's read of the store", () => {
  it("a notice announced while it reads is not lost: it reads again, with no poll", async () => {
    const tasks = new InMemoryA2ATaskRepository(new InMemoryDatabase());
    const task = await savedTask(tasks, { skill: "unit-workflow-start" }, WORKING);
    const parts = unitParts(scriptOf(), overwrittenDuringFirstRead(tasks, task));
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<typeof NEVER_ENDS>((resolve) => {
      timer = setTimeout(() => {
        resolve(NEVER_ENDS);
      }, 1500);
    });

    const shown = await Promise.race([
      restingTask(parts, task, new AbortController().signal),
      late,
    ]);
    clearTimeout(timer);

    expect(shown).not.toBe(NEVER_ENDS);
    expect((shown as A2ATaskRecord).status.state).toBe(A2ATaskState.Completed);
    expect(waitedTaskCount()).toBe(0);
  });
});
