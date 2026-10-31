/**
 * #520 acceptance (M2 automated, and the finish across a restart) — `AnyInstance` children on two
 * instances over one SQLite file: an answered child's lease row is `released = 3` (finished) at
 * once, a paused one's `released = 1` (released, so its resume takes it again) until its end
 * finishes it; the root's own lease is never finished. Once both instances stopped, a new instance
 * on a new connection to the same file takes no lease of a finished child — the finish is on disk —
 * and still takes the root's.
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect } from "vitest";
import { NO_ENVIRONMENT_VALUES } from "../../../src/environments/resolve.js";
import { applicationContextOf } from "../../../src/flow/context/application-context.js";
import { ExecutionStatus, SqliteExecutionLeaseRepository } from "../../../src/index.js";
import {
  callTool,
  replyWith,
  TestConcurrency,
  testWith,
  VirtualClock,
  type ModelRequest,
} from "../../../src/testing/index.js";
import { seconds } from "../../../src/units/index.js";
import { execute } from "../../helpers/flow.js";
import { connectionTo } from "../contracts/store-kinds.js";
import {
  ConfirmReviewTool,
  ItemReviewerAgent,
  resetChildLog,
  ReviewsSummaryWorkflowFinish,
} from "../../flow/runtime/fixtures/children.workflow.js";
import { ItemResultDto } from "../../flow/runtime/fixtures/fan-out.workflow.js";
import { RemoteReviewItemsWorkflowStart } from "../../flow/runtime/fixtures/remote-recovery.workflow.js";
import { resetRemoteLog } from "../../flow/runtime/fixtures/remote-children.workflow.js";
import { RemoteSqliteApplication } from "./fixtures/remote-children.application.js";
import { sqliteFilePerTest } from "./fixtures/sqlite.workflow.js";

const { path } = sqliteFilePerTest();
const test = testWith(RemoteSqliteApplication, {
  instances: 2,
  concurrency: TestConcurrency.Real,
});

beforeEach(() => {
  resetRemoteLog();
  resetChildLog();
});

/** `released` of every lease row on the file, by its key's execution. */
function releasedByExecution(): Readonly<Record<string, number>> {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = database
      .prepare("SELECT root_execution_id, released FROM execution_leases")
      .all() as { root_execution_id: string; released: number }[];
    return Object.fromEntries(rows.map((row) => [row.root_execution_id, row.released]));
  } finally {
    database.close();
  }
}

/** A lease store of a new instance on a new connection to the file, as after a restart. */
function restartedLeases(): SqliteExecutionLeaseRepository {
  const clock = new VirtualClock();
  const application = applicationContextOf({
    name: "remote-sqlite-application",
    version: "1.0.0",
    instanceId: "instance-after-restart",
    startedAt: clock.now(),
    environmentName: "test",
    environment: NO_ENVIRONMENT_VALUES,
  });
  return new SqliteExecutionLeaseRepository(connectionTo(path), clock, application);
}

/** The reviewer: an item named `b` is confirmed first (its child pauses), any other answered. */
const reviewer = (request: ModelRequest) => {
  const input = typeof request.input === "string" ? request.input : JSON.stringify(request.input);
  const name = /"name": "(\w+)"/.exec(input)?.[1] ?? "?";
  const isConfirmed =
    request.kind === "chat" && request.messages.some((line) => line.role === "tool");
  return name === "b" && !isConfirmed
    ? callTool(ConfirmReviewTool, { name })
    : replyWith(ItemResultDto, { name });
};

const items = (...names: readonly string[]) =>
  names.map((name) => ({ name, delay: 0, outcome: "ok" as const }));

describe("#520 M2: the lease rows of AnyInstance children on SQLite", () => {
  test("answered: released = 3 at once; paused: released = 1 until its end finishes it; the root's never 3 — and a restart takes no finished child's lease", async ({
    apps,
    mockLlm,
  }) => {
    mockLlm(ItemReviewerAgent).thenAnswer(reviewer);
    const [a, b] = apps;
    if (a === undefined || b === undefined) throw new Error("the test runs two instances");
    for (const app of apps) await app.ready();
    const paused = await execute(a, RemoteReviewItemsWorkflowStart, items("a", "b"));
    expect(paused.status).toBe(ExecutionStatus.Paused);
    const pausedChild = paused.pending[0]?.childExecutionId ?? "";
    const whilePaused = releasedByExecution();
    const answeredChild =
      Object.keys(whilePaused).find((id) => id !== paused.executionId && id !== pausedChild) ?? "";

    const done = await b.resume({
      pauseId: paused.pending[0]?.pauseId ?? "",
      decision: { approved: true },
    });
    const afterEnd = releasedByExecution();
    for (const app of apps) await app.close({ timeout: seconds(1) });
    const restarted = restartedLeases();

    expect(done).toFinishWith(ReviewsSummaryWorkflowFinish, { text: "a, b" });
    expect(whilePaused).toEqual({
      [paused.executionId]: 1,
      [answeredChild]: 3,
      [pausedChild]: 1,
    });
    expect(afterEnd).toEqual({ [paused.executionId]: 1, [answeredChild]: 3, [pausedChild]: 3 });
    expect(await restarted.acquire("default", answeredChild, seconds(30))).toBeUndefined();
    expect(await restarted.acquire("default", pausedChild, seconds(30))).toBeUndefined();
    expect(await restarted.acquire("default", paused.executionId, seconds(30))).toMatchObject({
      holderInstanceId: "instance-after-restart",
    });
  });
});
