/**
 * #1317, bug hunt 2026-11-25 finding 1: the gate covers a SQLite repository method only up to its
 * first `await`. Every method that awaits before (or between) its statements is started here, a
 * `runOnce` hold is opened in the same tick, and the hold ends a few turns later: the method must
 * then succeed — its statements queued behind the hold, never run inside it ("unreachable").
 */
import { emptyCheckpoint, type CheckpointMetadata } from "@langchain/langgraph";
import { beforeAll, describe, expect, it } from "vitest";
import { applicationContextOf } from "../../../src/flow/context/application-context.js";
import { randomIdGenerator } from "../../../src/infrastructure/clock.js";
import { OutboundCallStatus } from "../../../src/infrastructure/outbound-call-status.js";
import {
  ExecutionAuditEventKind,
  LeaseTakeoverReason,
} from "../../../src/infrastructure/execution-audit-log.repository.js";
import { SqliteCheckpointSaver } from "../../../src/infrastructure/sqlite/sqlite-checkpoint-saver.js";
import type { SqliteConnection } from "../../../src/infrastructure/sqlite/sqlite-connection.js";
import { SqliteExecutionAuditLogRepository } from "../../../src/infrastructure/sqlite/sqlite-execution-audit-log.repository.js";
import { SqliteExecutionLeaseRepository } from "../../../src/infrastructure/sqlite/sqlite-execution-lease.repository.js";
import { SqliteExecutionRecordRepository } from "../../../src/infrastructure/sqlite/sqlite-execution-record.repository.js";
import { SqliteOutboundCallRepository } from "../../../src/infrastructure/sqlite/sqlite-outbound-call.repository.js";
import { keyOf, leaseOf } from "../../../src/testing/contracts/fenced-effect-data.js";
import { intentOf } from "../../../src/testing/contracts/outbound-call-data.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { hours, usd } from "../../../src/units/index.js";
import { storeClockOf } from "../../helpers/store-clock.js";
import { connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";

const turns = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The stores of one file, and the call each case starts. */
function storesOf(connection: SqliteConnection) {
  const clock = new VirtualClock();
  const context = applicationContextOf({
    name: "a",
    version: "1.0.0",
    instanceId: "i",
    startedAt: clock.now(),
    profiles: ["test"],
  });
  return {
    clock,
    leases: new SqliteExecutionLeaseRepository(connection, storeClockOf(clock), context),
    calls: new SqliteOutboundCallRepository(connection, storeClockOf(clock)),
    saver: new SqliteCheckpointSaver(connection),
    audit: new SqliteExecutionAuditLogRepository(connection),
    records: new SqliteExecutionRecordRepository(connection, clock, context, randomIdGenerator),
  };
}

type Stores = ReturnType<typeof storesOf>;

/** A case: its rows written first, then the call raced against the hold, and what it answers. */
interface SameTickCase {
  readonly name: string;
  readonly call: (stores: Stores) => Promise<() => Promise<unknown>>;
  readonly answer: unknown;
}

const AT = { configurable: { thread_id: "t", checkpoint_ns: "", tenant_id: "default" } };
const loop = (step: unknown): CheckpointMetadata =>
  ({ source: "loop", step, parents: {} }) as CheckpointMetadata;

async function recordedKey(stores: Stores) {
  const lease = await leaseOf(stores);
  const key = keyOf(lease);
  await stores.calls.saveIfAbsent(key, intentOf(key));
  return { key, token: lease.token };
}

async function checkpointed(stores: Stores, step: unknown = 1) {
  const config = await stores.saver.put(AT, { ...emptyCheckpoint(), id: "c1" }, loop(step));
  await stores.saver.putWrites(config, [["channel", "value"]], "task-1");
  return config;
}

const FAILURE = { name: "PaymentDeclinedError", code: "PaymentDeclinedError", message: "declined" };

const OUTBOUND: readonly SameTickCase[] = [
  {
    name: "outbound call: markCompleted",
    call: async (stores) => {
      const { key } = await recordedKey(stores);
      return () => stores.calls.markCompleted(key, "owner-1", '"ok"', null);
    },
    answer: true,
  },
  {
    name: "outbound call: markFailed",
    call: async (stores) => {
      const { key } = await recordedKey(stores);
      return () => stores.calls.markFailed(key, "owner-1", FAILURE, null);
    },
    answer: true,
  },
  {
    name: "outbound call: markPending",
    call: async (stores) => {
      const { key } = await recordedKey(stores);
      await stores.calls.markFailed(key, "owner-1", FAILURE, null);
      const read = { status: OutboundCallStatus.Failed, attempt: 1, attemptOwner: "owner-1" };
      return () => stores.calls.markPending(key, read, { attempt: 2, attemptOwner: "owner-2" });
    },
    answer: true,
  },
  {
    name: "outbound call: leaseStateOf",
    call: async (stores) => {
      const { token } = await recordedKey(stores);
      const lease = { tenantId: "default", leaseExecutionId: "execution-1", token };
      return async () => typeof (await stores.calls.leaseStateOf(lease));
    },
    answer: "string",
  },
  {
    name: "execution lease: claimExecutionId",
    call: async (stores) => () =>
      stores.leases.claimExecutionId({ tenantId: "default", executionId: "execution-9" }),
    answer: true,
  },
];

const CHECKPOINTS: readonly SameTickCase[] = [
  {
    name: "checkpoint saver: put",
    call:
      async ({ saver }) =>
      async () => {
        const config = await saver.put(AT, { ...emptyCheckpoint(), id: "c2" }, loop(2));
        return config.configurable?.checkpoint_id as unknown;
      },
    answer: "c2",
  },
  {
    name: "checkpoint saver: putWrites",
    call: async (stores) => {
      const config = await checkpointed(stores);
      return () => stores.saver.putWrites(config, [["other", "value"]], "task-2");
    },
    answer: undefined,
  },
  {
    name: "checkpoint saver: getTuple",
    call: async (stores) => {
      await checkpointed(stores);
      return async () => (await stores.saver.getTuple(AT))?.pendingWrites?.length;
    },
    answer: 1,
  },
  {
    name: "checkpoint saver: list",
    call: async (stores) => {
      await checkpointed(stores);
      return async () => {
        const ids: string[] = [];
        for await (const tuple of stores.saver.list(AT)) ids.push(tuple.checkpoint.id);
        return ids;
      };
    },
    answer: ["c1"],
  },
  {
    name: "checkpoint saver: latestByStep, a step only the serde reads",
    call: async (stores) => {
      await checkpointed(stores, "not a number");
      return async () => (await stores.saver.latestByStep(AT))?.pendingWrites?.length;
    },
    answer: 1,
  },
];

const SWEEPS: readonly SameTickCase[] = [
  {
    name: "audit log: deleteExpired",
    call: async ({ audit }) => {
      await audit.save({
        kind: ExecutionAuditEventKind.Takeover,
        occurredAt: "2026-11-24T10:00:00.000Z",
        tenantId: "default",
        rootExecutionId: "ended",
        executionId: "ended",
        scopeKey: "default:ended",
        token: 2,
        holderInstanceId: "instance-2",
        reason: LeaseTakeoverReason.Recovered,
      });
      const cutoff = new Date("2026-11-25T00:00:00.000Z");
      return () => audit.deleteExpired(cutoff, () => Promise.resolve(true));
    },
    answer: 1,
  },
  {
    name: "execution records: deleteIdleThreads",
    call: async ({ records, clock }) => {
      const workflow = "desk-workflow";
      const threadId = await records.createThread({ workflow, tenantId: "default" });
      await records.append({
        ...{ runId: "run-1", threadId, tenantId: "default", workflow, task: "t" },
        ...{ replyWith: "r", status: "answered", stopReason: "", route: [], steps: [] },
        ...{ costUsd: usd(0), promptVersion: "p", modelVersion: "m", replayOf: null },
        ...{ configVersion: null, configHash: null },
      });
      const cutoff = new Date(clock.now().getTime() + hours(1));
      const cutoffs = new Map([[workflow, cutoff]]);
      return () => records.deleteIdleThreads(cutoffs, () => Promise.resolve(true));
    },
    answer: 1,
  },
];

describe("#1317: a hold opened in the same tick as a SQLite method never fails it", () => {
  // the modules the methods load lazily, loaded first: each method's await is then one short
  // gap, which the hold opened in the same tick always falls into
  beforeAll(async () => {
    await import("../../../src/infrastructure/outbound-call-changes.js");
    await import("../../../src/infrastructure/live-lease.js");
    await import("../../../src/infrastructure/sqlite/sqlite-execution-ids.js");
  });

  it.each([...OUTBOUND, ...CHECKPOINTS, ...SWEEPS])("$name", async ({ call, answer }) => {
    const connection = connectionTo(temporarySqlitePath());
    const started = await call(storesOf(connection));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calling = started();
    const holding = connection.held(() => gate);
    const settled = calling.then(
      (value: unknown) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await turns();
    release();
    await holding;

    expect(await settled).toEqual({ value: answer });
  });
});
