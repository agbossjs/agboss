/**
 * Bug hunt 2026-11-25 (pauses, findings 1 and 2): what lands on a pause while its first `send` is
 * still returning. A reassignment — moved or in place — is refused `PauseError.UpdateContended`
 * (retry is safe once the send returned), so the step never takes a moved pause for withdrawn and
 * the channel always hears the new assignees. A channel that decides at once while a person already
 * answered acts on the recorded answer only: the store's compare-and-set decides, never `send`.
 */
import { beforeEach, describe, expect } from "vitest";
import {
  ExecutionRecordRepository,
  PauseError,
  PauseResolution,
  PauseStatus,
} from "../../src/index.js";
import { callTool, replyWith, testWith, type ModelRequest } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import {
  DeskClerkAgent,
  DeskWorkflowStart,
  FinanceDeskBackupChannel,
  hooks,
  PausesApplication,
  pauseStore,
  RefundTool,
  resetPauses,
  seen,
} from "./fixtures/pauses.workflow.js";
import { until } from "./fixtures/pause-scripts.js";

const desk = testWith(PausesApplication);
const manager = { actor: { id: "manager-17" } };
const isAnswered = (request: ModelRequest): boolean =>
  request.kind === "chat" && request.messages.some((line) => line.role === "tool");

beforeEach(resetPauses);

describe("a reassignment while the pause's first send is in flight", () => {
  desk(
    "a move is UpdateContended and changes nothing; the run rests at its pause, and the retry after the send moves it",
    async ({ app, mockModel }) => {
      mockModel(DeskClerkAgent).respondWith((request) =>
        isAnswered(request) ? replyWith("Refunded.") : callTool(RefundTool, { orderId: "7" }),
      );
      let during: unknown;
      hooks.beforeSendReturns = async (ask) => {
        if (ask.replaces !== undefined) return;
        during = await app
          .reassignPause(
            { pauseId: ask.pauseId, channel: FinanceDeskBackupChannel, assignees: ["deputy-3"] },
            manager,
          )
          .catch((error: unknown) => error);
      };

      const out = await execute(app, DeskWorkflowStart, { text: "refund order 7" });

      expect(during).toBeInstanceOf(PauseError.UpdateContended);
      expect(out.status).toBe("paused");
      const [first] = await pauseStore().findAllByTenantIdAndRootExecutionId(
        "default",
        out.executionId,
      );
      expect(first).toMatchObject({ status: PauseStatus.Pending, isSent: true });
      expect(first?.trail.map((entry) => entry.action)).toEqual(["opened"]);

      const moved = await app.reassignPause(
        {
          pauseId: first?.pauseId ?? "",
          channel: FinanceDeskBackupChannel,
          assignees: ["deputy-3"],
        },
        manager,
      );
      expect(moved).toMatchObject({
        channel: "finance-desk-backup-channel",
        assignees: ["deputy-3"],
      });
      expect(seen.refunds).toEqual([]);
    },
  );

  desk(
    "an in-place change is UpdateContended; the retry after the send is told to the channel's listeners",
    async ({ app, mockModel }) => {
      mockModel(DeskClerkAgent).respondWith((request) =>
        isAnswered(request) ? replyWith("Refunded.") : callTool(RefundTool, { orderId: "7" }),
      );
      let during: unknown;
      hooks.beforeSendReturns = async (ask) => {
        during = await app
          .reassignPause({ pauseId: ask.pauseId, assignees: ["deputy-3"] }, manager)
          .catch((error: unknown) => error);
      };

      const out = await execute(app, DeskWorkflowStart, { text: "refund order 7" });

      expect(during).toBeInstanceOf(PauseError.UpdateContended);
      const [first] = await pauseStore().findAllByTenantIdAndRootExecutionId(
        "default",
        out.executionId,
      );
      expect(first?.assignees).toBeUndefined();

      await app.reassignPause({ pauseId: first?.pauseId ?? "", assignees: ["deputy-3"] }, manager);
      await until(() => seen.heard.some((heard) => heard.type === "reassigned"));
      const stored = await pauseStore().findByTenantIdAndPauseId("default", first?.pauseId ?? "");
      expect(stored?.assignees).toEqual(["deputy-3"]);
    },
  );
});

describe("a channel's decision at once while the pause was answered during send", () => {
  desk(
    "the recorded answer wins: the step acts on the person's no, never on the channel's yes",
    async ({ app, mockModel }) => {
      mockModel(DeskClerkAgent).respondWith((request) =>
        isAnswered(request) ? replyWith("Not refunded.") : callTool(RefundTool, { orderId: "7" }),
      );
      hooks.decideFirst = true;
      hooks.decideReassigned = { approved: true };
      let answered: Promise<unknown> | undefined;
      hooks.beforeSendReturns = async (ask) => {
        // a person answers "no" while send() is still returning
        answered = app
          .resume(
            { pauseId: ask.pauseId, decision: { approved: false } },
            { actor: { id: "alice" } },
          )
          .then((outcome) => outcome.status);
        await until(async () => {
          const pause = await pauseStore().findByTenantIdAndPauseId("default", ask.pauseId);
          return pause?.status !== PauseStatus.Pending;
        });
      };

      const out = await execute(app, DeskWorkflowStart, { text: "refund order 7" });
      await answered;

      expect(seen.refunds).toEqual([]);
      const [pause] = await pauseStore().findAllByTenantIdAndRootExecutionId(
        "default",
        out.executionId,
      );
      expect(pause?.answer).toMatchObject({
        decision: { approved: false },
        actor: { id: "alice" },
      });
      const log = await app
        .resolve(ExecutionRecordRepository)
        .findPauseAnswersByTenantIdAndRootExecutionId("default", out.executionId);
      // the one decision acted on is the one logged: the person's reply, never the channel's
      expect(log.map((entry) => [entry.decision, entry.actor?.id, entry.resolution])).toEqual([
        [{ approved: false }, "alice", PauseResolution.Replied],
      ]);
      expect(pause?.status).toBe(PauseStatus.Taken);
    },
  );
});
