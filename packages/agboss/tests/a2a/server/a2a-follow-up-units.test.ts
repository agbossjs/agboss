/**
 * #824 (mutation shard `a2a-server`): a follow-up on its own — the pause it answers (the one named,
 * the only one, else `-32602`; none waiting `-32004`), the resume as the caller, the outcome kept
 * with its message; a resend replays it (its acceptance's version, its refusal), waits for a first
 * one still deciding here, decides again when none is kept, and — its pause gone since — is
 * neither accepted nor refused; another content or task under the id, another context, an id that
 * is none, a task that is over.
 */
import { describe, expect, it } from "vitest";
import { followedUpTask } from "../../../src/a2a/server/a2a-follow-up.js";
import { LocalRuns } from "../../../src/a2a/server/a2a-local-runs.js";
import { requestHashOf } from "../../../src/a2a/server/a2a-message-input.js";
import {
  DurableExecutionStatus,
  type DurableExecutionState,
} from "../../../src/app/execution-control.js";
import {
  A2ATaskState,
  type A2AMessageKey,
  type A2AMessageRecord,
} from "../../../src/infrastructure/a2a-task.repository.js";
import { InMemoryA2ATaskRepository } from "../../../src/infrastructure/in-memory-a2a-task.repository.js";
import { InMemoryDatabase } from "../../../src/infrastructure/in-memory-database.js";
import { NotPausedError } from "../../../src/run/resume-agent.js";
import {
  callerOf,
  messageOf,
  NINE,
  refusalOf,
  savedTask,
  scriptOf,
  settle,
  unitParts,
  type Script,
} from "./support/unit-parts.js";

const INPUT_REQUIRED = { state: A2ATaskState.InputRequired, pendingPauses: [] };
const pausedOn = (...pauseIds: string[]): DurableExecutionState =>
  ({
    status: DurableExecutionStatus.Paused,
    pending: pauseIds.map((pauseId) => ({ pauseId })),
  }) as never;

const decide = (messageId: string, fields: Record<string, unknown> = {}, contextId = "") =>
  messageOf(messageId, [], {
    taskId: "task-1",
    contextId,
    data: { decision: { ok: true }, ...fields },
  });

async function setUp(script: Script) {
  const tasks = new InMemoryA2ATaskRepository(new InMemoryDatabase());
  const task = await savedTask(tasks, {}, INPUT_REQUIRED);
  return { tasks, task, parts: unitParts(script, tasks) };
}

/** This process's runs, each task's run here just ended: awaited, then read again. */
class EndedRuns extends LocalRuns {
  override settledOf(): Promise<void> {
    return Promise.resolve();
  }
}

const keyOf = (messageId: string): A2AMessageKey => ({
  tenantId: "acme",
  ownerId: "dana",
  messageId,
});

describe("#824: the pause a follow-up answers", () => {
  it("none waiting (the records say it runs): -32004, kept; no resume", async () => {
    const script = scriptOf();
    const { parts, tasks } = await setUp(script);

    expect(await refusalOf(followedUpTask(parts, callerOf(), decide("f-1")))).toBe(
      "UnsupportedOperationError a2a.no-pending-pause: the task waits for no answer of yours",
    );
    expect((await tasks.findByMessage(keyOf("f-1")))?.reply).toEqual({
      refused: "unsupported",
      code: "a2a.no-pending-pause",
    });
    expect(script.resumes).toEqual([]);
  });

  it("the only one waiting; of several the one named; else -32602", async () => {
    const one = scriptOf({ state: pausedOn("p-1") });
    const two = scriptOf({ state: pausedOn("p-1", "p-2") });
    const single = await setUp(one);
    const several = await setUp(two);

    await followedUpTask(single.parts, callerOf(), decide("f-1"));
    await followedUpTask(several.parts, callerOf(), decide("f-2", { pauseId: "p-2" }));
    const unnamed = await refusalOf(followedUpTask(several.parts, callerOf(), decide("f-3")));
    const unknown = await refusalOf(
      followedUpTask(several.parts, callerOf(), decide("f-4", { pauseId: "p-9" })),
    );

    expect(one.resumes.map(({ request }) => request)).toEqual([
      { pauseId: "p-1", decision: { ok: true } },
    ]);
    expect(two.resumes.map(({ request }) => request)).toEqual([
      { pauseId: "p-2", decision: { ok: true } },
    ]);
    expect(unnamed).toBe("RequestMalformedError a2a.pause-required: name the pause to answer");
    expect(unknown).toBe(
      "RequestMalformedError a2a.unknown-pause: the task waits for no such pause",
    );
    expect((await several.tasks.findByMessage(keyOf("f-4")))?.reply).toEqual({
      refused: "invalid-params",
      code: "a2a.unknown-pause",
    });
  });

  it("accepted: resumed as the caller, its acceptance kept with the version it answered", async () => {
    const script = scriptOf({ state: pausedOn("p-1") });
    const { parts, tasks } = await setUp(script);

    const reply = await followedUpTask(
      parts,
      callerOf(),
      messageOf("f-1", ["yes please"], { taskId: "task-1" }),
    );

    expect(reply).toMatchObject({ answered: 2, task: { taskId: "task-1" } });
    expect(script.resumes[0]?.request).toEqual({ pauseId: "p-1", reply: "yes please" });
    expect(script.resumes[0]?.options).toMatchObject({ tenantId: "acme", ownerId: "dana" });
    expect((await tasks.findByMessage(keyOf("f-1")))?.reply).toEqual({
      accepted: true,
      answered: 2,
    });
  });

  it("a task that is over takes no more input", async () => {
    const script = scriptOf({ state: pausedOn("p-1") });
    const tasks = new InMemoryA2ATaskRepository(new InMemoryDatabase());
    await savedTask(tasks, {}, { state: A2ATaskState.Failed, pendingPauses: [], errorCode: "x" });

    expect(
      await refusalOf(followedUpTask(unitParts(script, tasks), callerOf(), decide("f-1"))),
    ).toBe("UnsupportedOperationError a2a.task-over: the task is over: it takes no more input");
  });

  it("its context, if named, is the task's; its id a key's text", async () => {
    const script = scriptOf({ state: pausedOn("p-1") });
    const { parts } = await setUp(script);

    await followedUpTask(parts, callerOf(), decide("f-1", {}, "ctx-1"));
    expect(await refusalOf(followedUpTask(parts, callerOf(), decide("f-2", {}, "ctx-2")))).toBe(
      "RequestMalformedError a2a.context-mismatch: the contextId is not the task's",
    );
    expect(await refusalOf(followedUpTask(parts, callerOf(), decide("f\uD800")))).toBe(
      "RequestMalformedError a2a.invalid-id: messageId is not a valid id",
    );
    expect(script.resumes).toHaveLength(1);
  });
});

describe("#824: a follow-up sent again", () => {
  it("accepted before: replayed with the version it answered, not resumed again", async () => {
    const script = scriptOf({ state: pausedOn("p-1") });
    const { parts, tasks, task } = await setUp(script);
    await followedUpTask(parts, callerOf(), decide("f-1"));
    await tasks.compareAndSetStatus(task, 2, INPUT_REQUIRED, NINE);

    const again = await followedUpTask(parts, callerOf(), decide("f-1"));

    expect([again.answered, again.task.version, script.resumes.length]).toEqual([2, 3, 1]);
  });

  it("refused before: the same refusal; other content or another task under the id: -32602", async () => {
    const script = scriptOf({ state: pausedOn("p-1", "p-2") });
    const { parts, tasks } = await setUp(script);
    await refusalOf(followedUpTask(parts, callerOf(), decide("f-1")));
    await tasks.saveMessageIfAbsent({
      ...keyOf("f-other"),
      requestHash: requestHashOf("unit-workflow-start", decide("f-other")),
      taskId: "task-9",
      savedAt: NINE,
    });
    const reused =
      "RequestMalformedError a2a.message-id-reused: messageId reused with different content";

    expect(await refusalOf(followedUpTask(parts, callerOf(), decide("f-1")))).toBe(
      "RequestMalformedError a2a.pause-required: name the pause to answer",
    );
    expect(
      await refusalOf(followedUpTask(parts, callerOf(), decide("f-1", { pauseId: "p-2" }))),
    ).toBe(reused);
    expect(await refusalOf(followedUpTask(parts, callerOf(), decide("f-other")))).toBe(reused);
    expect(script.resumes).toEqual([]);
  });

  it("a kept reply that is none: logged, and decided again", async () => {
    const script = scriptOf({ state: pausedOn("p-1") });
    const { parts, tasks } = await setUp(script);
    const first = decide("f-1");
    await followedUpTask(parts, callerOf(), first);
    const kept = await tasks.findByMessage(keyOf("f-1"));
    const unreadable = Object.assign(Object.create(tasks) as InMemoryA2ATaskRepository, {
      saveMessageIfAbsent: () => Promise.resolve({ ...kept, reply: 42 }),
    });

    await followedUpTask(unitParts(script, unreadable), callerOf(), first);

    expect(script.warnings).toEqual([
      `a2a.follow-up-reply-unread a kept reply of task task-1 is unreadable: decided again ${JSON.stringify({ tenantId: "acme", executionId: "task-1" })}`,
    ]);
    expect(script.resumes).toHaveLength(2);
  });

  it("its first still deciding here: waited for, never resumed beside it", async () => {
    let release = (): void => undefined;
    const script = scriptOf({ state: pausedOn("p-1") });
    const { parts } = await setUp(script);
    script.hold = new Promise<void>((resolve) => (release = resolve));

    const first = followedUpTask(parts, callerOf(), decide("f-1"));
    await settle();
    const again = followedUpTask(parts, callerOf(), decide("f-1"));
    await settle();
    const during = script.resumes.length;
    release();
    await Promise.all([first, again]);

    expect(during).toBe(1);
    expect(script.warnings).toEqual([]);
  });

  it("none kept and none deciding here: decided again — even if a reply was kept since elsewhere", async () => {
    const script = scriptOf({ state: pausedOn("p-1") });
    const { tasks } = await setUp(script);
    const record: A2AMessageRecord = {
      ...keyOf("f-1"),
      requestHash: "",
      taskId: "task-1",
      savedAt: NINE,
    };
    const message = decide("f-1");
    const hash = requestHashOf("unit-workflow-start", message);
    const answeredElsewhere = Object.assign(Object.create(tasks) as InMemoryA2ATaskRepository, {
      saveMessageIfAbsent: () => Promise.resolve({ ...record, requestHash: hash }),
      findByMessage: () =>
        Promise.resolve({ ...record, requestHash: hash, reply: { accepted: true, answered: 2 } }),
    });

    await followedUpTask(unitParts(script, answeredElsewhere), callerOf(), message);

    expect(script.resumes).toHaveLength(1);
  });

  it("deciding here, its message gone once it ended: decided again", async () => {
    const script = scriptOf({ state: pausedOn("p-1") });
    const { tasks } = await setUp(script);
    const message = decide("f-1");
    const record = {
      ...keyOf("f-1"),
      requestHash: requestHashOf("unit-workflow-start", message),
      taskId: "task-1",
      savedAt: NINE,
    };
    const gone = Object.assign(Object.create(tasks) as InMemoryA2ATaskRepository, {
      saveMessageIfAbsent: () => Promise.resolve(record),
      findByMessage: () => Promise.resolve(undefined),
    });
    const parts = unitParts(script, gone, { runs: new EndedRuns() });

    await followedUpTask(parts, callerOf(), message);

    expect(script.resumes).toHaveLength(1);
  });

  it("its first outcome lost and its pause gone since: the task as it is, nothing kept or thrown", async () => {
    const lostWith = async (state: DurableExecutionState, runError?: Error) => {
      const script = scriptOf({ state, ...(runError === undefined ? {} : { runError }) });
      const { tasks } = await setUp(script);
      const message = decide("f-1");
      await tasks.saveMessageIfAbsent({
        ...keyOf("f-1"),
        requestHash: requestHashOf("unit-workflow-start", message),
        taskId: "task-1",
        savedAt: NINE,
      });
      const answer = await refusalOf(followedUpTask(unitParts(script, tasks), callerOf(), message));
      return [answer, (await tasks.findByMessage(keyOf("f-1")))?.reply];
    };

    expect(await lostWith({ status: DurableExecutionStatus.Running })).toEqual([
      "resolved",
      undefined,
    ]);
    expect(await lostWith(pausedOn("p-1"), new NotPausedError("x"))).toEqual([
      "resolved",
      undefined,
    ]);
    expect(await lostWith(pausedOn("p-1", "p-2"))).toEqual([
      "RequestMalformedError a2a.pause-required: name the pause to answer",
      { refused: "invalid-params", code: "a2a.pause-required" },
    ]);
  });

  it("its task swept once its answer was taken: not found", async () => {
    const script = scriptOf({ state: pausedOn("p-1") });
    const { tasks } = await setUp(script);
    let reads = 0;
    const sweeping = Object.assign(Object.create(tasks) as InMemoryA2ATaskRepository, {
      findById: (key: { tenantId: string; taskId: string }) =>
        (reads += 1) === 1 ? tasks.findById(key) : Promise.resolve(undefined),
    });

    expect(
      await refusalOf(followedUpTask(unitParts(script, sweeping), callerOf(), decide("f-1"))),
    ).toBe("TaskNotFoundError: task not found");
    expect(script.resumes).toHaveLength(1);
  });
});
