/**
 * #1193 with #946 and #943: a channel that decides at once for a reassigned send gives a decision,
 * never a person's reply. It is not counted in `time_to_answer` (a human's wait), it is logged as
 * `decided` (the first send's decided-at-once outcome is) and the replacement, never opened, is not
 * counted closed either: `opened` and `closed` balance. A person's answer of a replacement is still
 * counted as before.
 */
import { DataPointType } from "@opentelemetry/sdk-metrics";
import { beforeEach, describe, expect } from "vitest";
import { PauseResolution, PauseStatus } from "../../src/index.js";
import { ExecutionRecordRepository } from "../../src/infrastructure/execution-record.repository.js";
import { PausedExecutionRepository } from "../../src/infrastructure/paused-execution.repository.js";
import { testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import { until } from "../channels/fixtures/pause-scripts.js";
import {
  ExtensionApplication,
  managerFlow,
  ownerFlow,
  resetTold,
  told,
} from "../flow/fixtures/pause-extension.fixture.js";
import { resetPauses } from "../channels/fixtures/pauses.workflow.js";
import { collect, instanceMeter, totalOf } from "./support/metric-reader.js";

const OPENED = "agboss.instance.pauses.opened";
const CLOSED = "agboss.instance.pauses.closed";
const TIME_TO_ANSWER = "agboss.instance.pauses.time_to_answer";
const approve = { approved: true };

beforeEach(() => {
  resetPauses();
  resetTold();
});

const meter = instanceMeter();
const extension = testWith(ExtensionApplication, {
  instances: [{ meterProvider: meter.provider }],
});

/** What the instance has counted so far: one meter serves every test of the file, so a test reads its delta. */
interface Counted {
  readonly answered: number;
  readonly opened: number;
  readonly closed: Readonly<Record<string, number>>;
}

async function counted(): Promise<Counted> {
  const collected = await collect(meter);
  const data = collected.get(TIME_TO_ANSWER)?.data;
  const answered =
    data?.dataPointType === DataPointType.HISTOGRAM
      ? data.dataPoints.reduce((sum, point) => sum + point.value.count, 0)
      : 0;
  const closed: Record<string, number> = {};
  for (const { attributes, value } of collected.get(CLOSED)?.points ?? []) {
    const reason = String(attributes.reason);
    closed[reason] = (closed[reason] ?? 0) + value;
  }
  return { answered, opened: totalOf(collected, OPENED), closed };
}

/** What was counted between `before` and now. */
async function countedSince(before: Counted): Promise<Counted> {
  const now = await counted();
  const closed: Record<string, number> = {};
  for (const [reason, count] of Object.entries(now.closed)) {
    const delta = count - (before.closed[reason] ?? 0);
    if (delta !== 0) closed[reason] = delta;
  }
  return { answered: now.answered - before.answered, opened: now.opened - before.opened, closed };
}

describe("#1193: a channel's decision for a reassigned send is a decision", () => {
  extension(
    "decided at once: logged `decided`, not in time_to_answer, opened and closed balance",
    async ({ app }) => {
      const before = await counted();
      await execute(app, ownerFlow.start, { orderId: "o-1" }, { threadId: "t1", ownerId: "alice" });
      const store = app.resolve(PausedExecutionRepository);
      const [first] = (
        await store.findPageByTenantId("default", { statuses: [PauseStatus.Pending] }, 10)
      ).pauses;
      told.ownerDecides = approve;

      await app.reassignPause(
        { pauseId: first?.pauseId ?? "", assignee: "deputy-3" },
        { ownerId: "alice" },
      );
      await until(() => told.recorded.length === 1);

      const log = await app
        .resolve(ExecutionRecordRepository)
        .findPauseAnswersByTenantIdAndRootExecutionId("default", first?.rootExecutionId ?? "");
      expect(log.map((entry) => entry.resolution)).toEqual([PauseResolution.Decided]);
      // #1197: the stored answer says so too, so a crash before the log write is repaired as `decided`
      const stored = await store.findPageByTenantId(
        "default",
        { statuses: [PauseStatus.Taken] },
        10,
      );
      expect(stored.pauses.map((one) => one.answer?.byChannel)).toEqual([true]);
      // the first pause opened and closed `reassigned`; the replacement was never opened, so never closed
      expect(await countedSince(before)).toEqual({
        answered: 0,
        opened: 1,
        closed: { reassigned: 1 },
      });
    },
  );

  extension(
    "a person's answer of the replacement is still a reply: logged `replied`, in time_to_answer, balanced",
    async ({ app }) => {
      const before = await counted();
      await execute(app, managerFlow.start, { orderId: "o-2" }, { threadId: "t2" });
      const store = app.resolve(PausedExecutionRepository);
      const [first] = (
        await store.findPageByTenantId("default", { statuses: [PauseStatus.Pending] }, 10)
      ).pauses;
      await app.reassignPause(
        { pauseId: first?.pauseId ?? "", assignee: "deputy-3" },
        { answeredBy: "manager-17" },
      );
      await until(() => told.sent.some((ask) => ask.replaces !== undefined));
      const newId = told.sent.find((ask) => ask.replaces !== undefined)?.pauseId ?? "";

      await app.resume({ pauseId: newId, decision: approve }, { answeredBy: "deputy-3" });

      const log = await app
        .resolve(ExecutionRecordRepository)
        .findPauseAnswersByTenantIdAndRootExecutionId("default", first?.rootExecutionId ?? "");
      expect(log.map((entry) => entry.resolution)).toEqual([PauseResolution.Replied]);
      expect(await countedSince(before)).toEqual({
        answered: 1,
        opened: 2,
        closed: { reassigned: 1, answered: 1 },
      });
    },
  );
});
