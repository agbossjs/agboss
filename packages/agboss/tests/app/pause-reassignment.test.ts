/**
 * #946 AC1-AC3: an operator moves an open pause to another addressee (`app.reassignPause`) — the
 * same channel is asked again with a new pause id, `assignee` and `replaces`, and told
 * `onPauseClosed(Reassigned)` for the old message (in no fixed order); the old id answers nothing
 * ("reassigned"), the deputy's answer goes on, the agent's model is not called again and the
 * deadline is kept. A reassignment after the deadline is refused "expired"; two reassignments, or
 * a reassignment and an answer, at the same moment: exactly one wins. The new id goes to the
 * channel only. The chain (V3.4): the checkpoint keeps the first id, the live pause is the last.
 */
import { ExecutionError } from "../../src/core/error-families/run-errors.js";
import { beforeEach, describe, expect, vi } from "vitest";
import { ExecutionStatus } from "../../src/app/types.js";
import { DurableExecutionStatus, executionControlOf } from "../../src/app/execution-control.js";
import {
  PauseError,
  PauseClosedReason,
  PauseResolution,
  PauseStatus,
  ValidationError,
} from "../../src/index.js";
import { pauseKeyOf } from "../../src/infrastructure/pause-record.js";
import { PausedExecutionRepository } from "../../src/infrastructure/paused-execution.repository.js";
import {
  callTool,
  replyWith,
  testWith,
  type ModelRequest,
  type ScriptedTurn,
} from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { hours, seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { logged, resetLogged } from "../helpers/log.js";
import { until } from "../channels/fixtures/pause-scripts.js";
import {
  FinanceDeskBackupChannel,
  BatchRefundAgent,
  BatchWorkflowStart,
  DeskClerkAgent,
  DeskWorkflowStart,
  hooks,
  PausesApplication,
  pauseStore,
  RefundDoneDto,
  RefundTool,
  resetPauses,
  seen,
  type SentAsk,
} from "../channels/fixtures/pauses.workflow.js";
import {
  ExtendManagerBackupChannel,
  ExtendManagerChannel,
  ExtendOwnerBackupChannel,
  resetTold,
  told,
  managerFlow,
  ownerFlow,
  ExtensionApplication,
} from "../flow/fixtures/pause-extension.fixture.js";
import { orderOf } from "../channels/fixtures/pause-scripts.js";
import {
  PricedPausesApplication,
  PriceOrderTool,
  PricedRefundAgent,
  LOOKUP_COST,
  costLedger,
} from "../channels/fixtures/priced-pauses.workflow.js";

const desk = testWith(PausesApplication);
const twoDesks = testWith(PausesApplication, { instances: 2 });
const priced = testWith(PricedPausesApplication);
const extension = testWith(ExtensionApplication, { instances: 3 });
const manager = { actor: { id: "manager-17" } };
const approve = { approved: true };
const REFUND = { text: "refund order 7" };
const THREAD = { threadId: "reassign-thread" };

beforeEach(() => {
  resetPauses();
  resetTold();
  resetLogged();
});

/** Whether the request already carries the tool's answer: the agent's second turn. */
const isAnswered = (request: ModelRequest): boolean =>
  request.kind === "chat" && request.messages.some((line) => line.role === "tool");

/** The asks the desk was sent about `orderId`, in order. */
const asksAbout = (orderId: string): readonly SentAsk[] =>
  seen.asks.filter((ask) => ask.orderId === orderId);

/** The send of a reassignment about `orderId`: the one that names what it replaces. */
const replacementOf = (orderId: string): SentAsk => {
  const found = asksAbout(orderId).find((ask) => ask.replaces !== undefined);
  if (found === undefined) throw new Error(`no reassigned send about ${orderId}`);
  return found;
};

const instance = (apps: readonly TestApp[], index: number): TestApp => {
  const found = apps[index];
  if (found === undefined) throw new Error(`no instance ${String(index)}`);
  return found;
};

/** What the settled calls were refused with. */
const rejectionsOf = (results: readonly PromiseSettledResult<unknown>[]): readonly unknown[] =>
  results.flatMap((one) => (one.status === "rejected" ? [one.reason as unknown] : []));

const failureOf = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => undefined,
    (error: unknown) => error,
  );

/** A desk agent: one refund approval, then done; counts its model's turns. */
function scriptedClerk(
  mockModel: (agent: typeof DeskClerkAgent) => {
    respondWith: (answer: (request: ModelRequest) => ScriptedTurn) => unknown;
  },
): { turns: () => number } {
  let turns = 0;
  mockModel(DeskClerkAgent).respondWith((request) => {
    turns += 1;
    return isAnswered(request) ? replyWith("Refunded.") : callTool(RefundTool, { orderId: "7" });
  });
  return { turns: () => turns };
}

describe("#946 AC1: an operator reassigns an approval", () => {
  desk(
    "AC1: the old id is refused 'reassigned', the deputy's answer goes on, the agent's model is not called again",
    async ({ app, mockModel }) => {
      const clerk = scriptedClerk(mockModel);
      const paused = await execute(app, DeskWorkflowStart, REFUND);
      expect(paused.status).toBe(ExecutionStatus.Paused);
      const oldId = asksAbout("7")[0]?.pauseId ?? "";
      expect(clerk.turns()).toBe(1);

      const moved = await app.reassignPause(
        { pauseId: oldId, channel: FinanceDeskBackupChannel, assignees: ["deputy-3"] },
        manager,
      );

      const sent = replacementOf("7");
      expect(sent).toMatchObject({ assignees: ["deputy-3"], replaces: { pauseId: oldId } });
      expect(sent.pauseId).not.toBe(oldId);
      // the caller gets the new pause's key, never its id (a capability)
      expect(moved).toMatchObject({ pauseKey: pauseKeyOf("default", sent.pauseId) });
      const refused = await failureOf(app.resume({ pauseId: oldId, decision: approve }, manager));
      expect(refused).toBeInstanceOf(PauseError.Closed);
      expect(refused).toMatchObject({ reason: PauseClosedReason.Reassigned });

      const done = await app.resume({ pauseId: sent.pauseId, decision: approve }, manager);

      expect(done.status).toBe(ExecutionStatus.Finished);
      // the agent's loop went on from its paused state: its model was asked once more, not twice
      expect(clerk.turns()).toBe(2);
      expect(seen.refunds).toEqual(["7"]);
      expect(asksAbout("7")).toHaveLength(2);
    },
  );

  desk(
    "AC1: the old pause is Cancelled / Reassigned, the replacement is sent; a first send carries neither assignee nor replaces",
    async ({ app, mockModel }) => {
      scriptedClerk(mockModel);
      await execute(app, DeskWorkflowStart, REFUND);
      const [first] = asksAbout("7");
      expect(first).not.toHaveProperty("assignee");
      expect(first).not.toHaveProperty("replaces");

      await app.reassignPause(
        {
          pauseId: first?.pauseId ?? "",
          channel: FinanceDeskBackupChannel,
          assignees: ["deputy-3"],
        },
        manager,
      );

      const old = await pauseStore().findByTenantIdAndPauseId("default", first?.pauseId ?? "");
      const next = await pauseStore().findByTenantIdAndPauseId(
        "default",
        replacementOf("7").pauseId,
      );
      expect(old).toMatchObject({
        status: PauseStatus.Cancelled,
        resolution: PauseResolution.Reassigned,
        reassignedTo: next?.pauseId,
      });
      expect(next).toMatchObject({
        status: PauseStatus.Pending,
        isSent: true,
        assignees: ["deputy-3"],
        reassignedFrom: first?.pauseId,
      });
    },
  );

  desk(
    "AC1: the channel hears the new send and onPauseClosed(reassigned) of the old message — each once, in either order",
    async ({ app, mockModel }) => {
      scriptedClerk(mockModel);
      await execute(app, DeskWorkflowStart, REFUND);
      const oldId = asksAbout("7")[0]?.pauseId ?? "";

      await app.reassignPause(
        { pauseId: oldId, channel: FinanceDeskBackupChannel, assignees: ["deputy-3"] },
        manager,
      );

      await until(() => seen.closed.length === 1);
      expect(seen.closed).toMatchObject([
        {
          channel: "finance-desk",
          pauseId: oldId,
          reason: PauseClosedReason.Reassigned,
          orderId: "7",
        },
      ]);
      expect(asksAbout("7").filter((ask) => ask.replaces !== undefined)).toHaveLength(1);
      // the listeners heard the pause opened, then one reassigned — never the old pause closed and a new one opened
      await until(() => seen.heard.filter((one) => one.listener === "audit").length === 2);
      expect(seen.heard.filter((one) => one.listener === "audit").map((one) => one.type)).toEqual([
        "opened",
        "reassigned",
      ]);
    },
  );

  desk(
    "AC1: one of three approvers reassigned: the other two pauses are unchanged; the pending list names the live pauses; the next answer's pass does not ask again",
    async ({ app, mockModel }) => {
      mockModel(BatchRefundAgent).respondWith((request) => {
        const orderId = orderOf(request);
        return isAnswered(request)
          ? replyWith(RefundDoneDto, { orderId })
          : callTool(RefundTool, { orderId });
      });
      const paused = await execute(app, BatchWorkflowStart, [
        { orderId: "A" },
        { orderId: "B" },
        { orderId: "C" },
      ]);
      expect(paused.pending).toHaveLength(3);
      const idOf = (orderId: string) => asksAbout(orderId)[0]?.pauseId ?? "";

      await app.reassignPause(
        { pauseId: idOf("B"), channel: FinanceDeskBackupChannel, assignees: ["deputy-3"] },
        manager,
      );

      const store = pauseStore();
      for (const orderId of ["A", "C"])
        expect(await store.findByTenantIdAndPauseId("default", idOf(orderId))).toMatchObject({
          status: PauseStatus.Pending,
          isSent: true,
        });
      await until(() => seen.closed.length === 1);
      expect(seen.closed.map((one) => one.orderId)).toEqual(["B"]);
      const newB = replacementOf("B").pauseId;

      // A answers: its pass re-enters B's step (a sibling's resume) — which finds its replacement
      // and interrupts again, no third ask — and the pending list names the live pauses (V3.4)
      const afterA = await app.resume({ pauseId: idOf("A"), decision: approve }, manager);

      expect(afterA.status).toBe(ExecutionStatus.Paused);
      // a channel's pause comes without its id (D4): B's step still waits — at its replacement
      expect(afterA.pending.map((pause) => pause.step)).toHaveLength(2);
      expect(asksAbout("B")).toHaveLength(2);
      const tree = {
        tenantId: "default",
        rootExecutionId: afterA.executionId,
        threadId: afterA.threadId,
      };
      const state = await executionControlOf(app)?.executionStateOf(tree);
      expect(state?.status).toBe(DurableExecutionStatus.Paused);
      expect(state?.status === DurableExecutionStatus.Paused ? state.pending : []).toHaveLength(2);

      await app.resume({ pauseId: newB, decision: approve }, manager);
      const done = await app.resume({ pauseId: idOf("C"), decision: approve }, manager);
      expect(done.status).toBe(ExecutionStatus.Finished);
      expect(seen.refunds.sort()).toEqual(["A", "B", "C"]);
    },
  );

  priced(
    "AC1: a reassigned approval's sleeping loop keeps its spend at finishRun, and a resume counts nothing twice",
    async ({ app, mockModel }) => {
      mockModel(PricedRefundAgent).respondWith((request) => {
        const orderId = orderOf(request);
        const tools =
          request.kind === "chat" ? request.messages.filter((m) => m.role === "tool").length : 0;
        const turns = [
          callTool(PriceOrderTool, { orderId }),
          callTool(RefundTool, { orderId }),
          replyWith(RefundDoneDto, { orderId }),
        ];
        return turns[Math.min(tools, 2)] ?? replyWith(RefundDoneDto, { orderId });
      });
      await execute(app, BatchWorkflowStart, [{ orderId: "A" }, { orderId: "B" }]);
      const idOf = (orderId: string) => asksAbout(orderId)[0]?.pauseId ?? "";
      const ledger = costLedger();
      await app.reassignPause(
        { pauseId: idOf("A"), channel: FinanceDeskBackupChannel, assignees: ["deputy-3"] },
        manager,
      );

      const afterB = await app.resume({ pauseId: idOf("B"), decision: approve }, manager);

      // B finished; A's loop (reassigned) still sleeps: its lookup is counted once, not lost
      expect(afterB.status).toBe(ExecutionStatus.Paused);
      expect(afterB.spend.byCaller["tool:price-order-tool"]).toBeCloseTo(2 * LOOKUP_COST);
      const done = await app.resume(
        { pauseId: replacementOf("A").pauseId, decision: approve },
        manager,
      );
      expect(done.status).toBe(ExecutionStatus.Finished);
      expect(done.spend.byCaller["tool:price-order-tool"]).toBeCloseTo(2 * LOOKUP_COST);
      const lookups = ledger.recorded
        .filter((record) => record.caller === "tool:price-order-tool")
        .reduce((total, record) => total + record.costUsd, 0);
      expect(lookups).toBeCloseTo(2 * LOOKUP_COST);
    },
  );

  desk(
    "AC1: the new id is in no log and no listener's notice without includePauseIds, and in no result of the call",
    async ({ app, mockModel }) => {
      scriptedClerk(mockModel);
      await execute(app, DeskWorkflowStart, REFUND);
      const oldId = asksAbout("7")[0]?.pauseId ?? "";

      const moved = await app.reassignPause(
        { pauseId: oldId, channel: FinanceDeskBackupChannel, assignees: ["deputy-3"] },
        manager,
      );
      const newId = replacementOf("7").pauseId;
      await until(() => seen.heard.filter((one) => one.listener === "audit").length === 2);
      await until(() => seen.heard.filter((one) => one.listener === "trusted").length === 2);

      expect(JSON.stringify(moved)).not.toContain(newId);
      expect(JSON.stringify(logged)).not.toContain(newId);
      for (const one of seen.heard.filter((entry) => entry.listener === "audit"))
        expect(JSON.stringify(one)).not.toContain(newId);
      // the trusted listener may answer pauses: it is told the capability
      expect(
        seen.heard
          .filter((entry) => entry.listener === "trusted")
          .map((one) => JSON.stringify(one)),
      ).toContainEqual(expect.stringContaining(newId));
      const done = await app.resume(
        { pauseId: newId, decision: approve },
        { ...manager, includeRecord: true },
      );
      expect(JSON.stringify(done)).not.toContain(newId);
      // the audit trail shows the step once, under its own key, never a replacement's `~r1`
      expect(done.record?.pauses).toHaveLength(1);
      expect(JSON.stringify(done.record)).not.toContain("~r");
    },
  );
});

describe("#946 AC2: the instance dies, or the channel fails, between the reassignment and the new send", () => {
  desk(
    "AC2: a send that fails leaves the replacement unsent; a later look sends it again with replaces and assignee, once",
    async ({ app, mockModel, clock }) => {
      scriptedClerk(mockModel);
      await execute(app, DeskWorkflowStart, REFUND);
      const oldId = asksAbout("7")[0]?.pauseId ?? "";
      hooks.beforeSendReturns = (ask) =>
        ask.replaces === undefined ? Promise.resolve() : Promise.reject(new Error("slack is down"));

      // the reassignment is done: the caller is told, the failed send is logged and retried by the look
      const moved = await app.reassignPause(
        { pauseId: oldId, channel: FinanceDeskBackupChannel, assignees: ["deputy-3"] },
        manager,
      );

      expect(moved.pauseKey).toBeDefined();
      const attempted = replacementOf("7");
      const record = () => pauseStore().findByTenantIdAndPauseId("default", attempted.pauseId);
      expect(await record()).toMatchObject({ isSent: false, status: PauseStatus.Pending });
      expect(logged.some((entry) => entry.code === "pause.reassign-send-failed")).toBe(true);
      // not yet due: the call that made it has had no 30 s
      await clock.advance(seconds(20));
      expect(asksAbout("7")).toHaveLength(2);

      delete hooks.beforeSendReturns;
      await clock.advance(seconds(20));
      await until(async () => (await record())?.isSent === true);

      const sends = asksAbout("7").filter((ask) => ask.replaces !== undefined);
      expect(sends.length).toBeGreaterThanOrEqual(2);
      expect(sends.at(-1)).toMatchObject({
        pauseId: attempted.pauseId,
        assignees: ["deputy-3"],
        replaces: { pauseId: oldId },
      });
      // sent: the look asks no more, however long it looks
      const asked = seen.asks.length;
      await clock.advance(seconds(120));
      expect(seen.asks).toHaveLength(asked);
      const done = await app.resume({ pauseId: attempted.pauseId, decision: approve }, manager);
      expect(done.status).toBe(ExecutionStatus.Finished);
    },
  );

  desk(
    "AC2: the replacement is sent once more at most per look: a channel that keeps failing is asked once each look, never twice at once",
    async ({ app, mockModel, clock }) => {
      scriptedClerk(mockModel);
      await execute(app, DeskWorkflowStart, REFUND);
      const oldId = asksAbout("7")[0]?.pauseId ?? "";
      let release: () => void = () => undefined;
      hooks.beforeSendReturns = (ask) =>
        ask.replaces === undefined
          ? Promise.resolve()
          : new Promise<void>((_resolve, reject) => {
              release = () => {
                reject(new Error("slack is down"));
              };
            });
      const call = app.reassignPause(
        { pauseId: oldId, channel: FinanceDeskBackupChannel, assignees: ["deputy-3"] },
        manager,
      );
      await until(() => asksAbout("7").some((ask) => ask.replaces !== undefined));
      release();
      await call;

      await clock.advance(seconds(40));
      await until(() => asksAbout("7").filter((ask) => ask.replaces !== undefined).length === 2);
      // that look's send is in flight: the next ticks do not start a second one beside it
      await clock.advance(seconds(20));
      expect(asksAbout("7").filter((ask) => ask.replaces !== undefined)).toHaveLength(2);
      release();
    },
  );

  desk(
    "AC2: a slow channel's closed notice is retried while the new send went out (no order asserted)",
    async ({ app, mockModel, clock }) => {
      scriptedClerk(mockModel);
      await execute(app, DeskWorkflowStart, REFUND);
      const oldId = asksAbout("7")[0]?.pauseId ?? "";
      hooks.closeFailure = new Error("the old message cannot be edited yet");

      await app.reassignPause(
        { pauseId: oldId, channel: FinanceDeskBackupChannel, assignees: ["deputy-3"] },
        manager,
      );

      expect(replacementOf("7")).toBeDefined();
      await until(() => seen.closed.length >= 1);
      delete hooks.closeFailure;
      await clock.advance(seconds(60));
      await until(() => seen.closed.length >= 2);
      expect(seen.closed.every((one) => one.reason === PauseClosedReason.Reassigned)).toBe(true);
      expect(new Set(seen.closed.map((one) => one.deliveryId)).size).toBe(1);
    },
  );

  twoDesks(
    "AC2: a failure whose message carries the new pause id reaches no log line, from the call or the re-send look",
    async ({ apps, mockModel, clock }) => {
      scriptedClerk(mockModel);
      await execute(instance(apps, 0), DeskWorkflowStart, REFUND, THREAD);
      const oldId = asksAbout("7")[0]?.pauseId ?? "";
      const store = pauseStore();
      // the store fails marking the replacement sent, its message naming the id it was given
      const failing = vi
        .spyOn(store, "markSentByTenantIdAndPauseId")
        .mockImplementation((_tenant, id) => Promise.reject(new Error(`database refused ${id}`)));

      await instance(apps, 0).reassignPause(
        { pauseId: oldId, channel: FinanceDeskBackupChannel, assignees: ["deputy-3"] },
        manager,
      );
      await clock.advance(seconds(40));
      await until(() => failing.mock.calls.length >= 2);
      await clock.advance(seconds(10));

      const newId = replacementOf("7").pauseId;
      const codes = logged.map((entry) => entry.code);
      expect(codes).toContain("pause.reassign-send-failed");
      expect(codes).toContain("pause.resend-failed");
      expect(JSON.stringify(logged)).not.toContain(newId);
      expect(JSON.stringify(logged)).not.toContain("database refused");
      failing.mockRestore();
    },
  );

  desk(
    "AC2: a channel that decides at once for the reassigned send answers the replacement through the normal answer path, once; the run goes on",
    async ({ app, mockModel }) => {
      const clerk = scriptedClerk(mockModel);
      await execute(app, DeskWorkflowStart, REFUND, THREAD);
      const oldId = asksAbout("7")[0]?.pauseId ?? "";
      hooks.decideReassigned = approve;

      await app.reassignPause(
        { pauseId: oldId, channel: FinanceDeskBackupChannel, assignees: ["deputy-3"] },
        manager,
      );

      const newId = replacementOf("7").pauseId;
      const stored = await pauseStore().findByTenantIdAndPauseId("default", newId);
      expect(stored).toMatchObject({
        status: PauseStatus.Taken,
        answer: { decision: approve, actor: { id: "finance-desk-backup-channel" } },
      });
      expect(seen.refunds).toEqual(["7"]);
      expect(clerk.turns()).toBe(2);
      expect(asksAbout("7").filter((ask) => ask.replaces !== undefined)).toHaveLength(1);
      // nothing waits: the new id answers nothing more
      expect(
        await failureOf(app.resume({ pauseId: newId, decision: approve }, manager)),
      ).toBeInstanceOf(PauseError.Closed);
    },
  );

  twoDesks(
    "AC2 (money path): a reassigned send that decides, the answer lost before it was recorded, then the re-send looks of two instances: the channel decides again and the answer applies exactly once",
    async ({ apps, mockModel, clock }) => {
      const clerk = scriptedClerk(mockModel);
      await execute(instance(apps, 0), DeskWorkflowStart, REFUND, THREAD);
      const oldId = asksAbout("7")[0]?.pauseId ?? "";
      hooks.decideReassigned = approve;
      const store = pauseStore();
      // the instance dies after the channel decided, before the answer was recorded
      const crash = vi
        .spyOn(store, "resolveByTenantIdAndPauseId")
        .mockRejectedValueOnce(new Error("the instance died"));

      await instance(apps, 0).reassignPause(
        { pauseId: oldId, channel: FinanceDeskBackupChannel, assignees: ["deputy-3"] },
        manager,
      );

      const newId = replacementOf("7").pauseId;
      expect(await store.findByTenantIdAndPauseId("default", newId)).toMatchObject({
        status: PauseStatus.Pending,
        isSent: false,
      });
      expect(seen.refunds).toEqual([]);
      crash.mockRestore();

      // both instances' look find it unsent after 30 s: both asked, both decided, one answer applied
      await clock.advance(seconds(40));
      await until(
        async () =>
          (await store.findByTenantIdAndPauseId("default", newId))?.status === PauseStatus.Taken,
      );
      await clock.advance(seconds(60));

      expect(seen.refunds).toEqual(["7"]);
      expect(clerk.turns()).toBe(2);
      expect(
        asksAbout("7").filter((ask) => ask.replaces !== undefined).length,
      ).toBeGreaterThanOrEqual(2);
      expect(await store.findByTenantIdAndPauseId("default", newId)).toMatchObject({
        status: PauseStatus.Taken,
        answer: { decision: approve },
      });
    },
  );

  desk(
    "V3.4: a Resolved replacement whose first interrupt still waits is closed not taken at the tree's end, never marked Taken",
    async ({ app, mockModel, clock }) => {
      scriptedClerk(mockModel);
      await execute(app, DeskWorkflowStart, REFUND, THREAD);
      const oldId = asksAbout("7")[0]?.pauseId ?? "";
      await app.reassignPause(
        { pauseId: oldId, channel: FinanceDeskBackupChannel, assignees: ["deputy-3"] },
        manager,
      );
      const newId = replacementOf("7").pauseId;
      const store = pauseStore();
      // the answer is recorded; no pass took it
      await store.resolveByTenantIdAndPauseId(
        "default",
        newId,
        { decision: approve, actor: { id: "deputy-3" } },
        clock.now(),
        { listeners: [] },
      );

      await app.cancel(THREAD.threadId);

      const closed = await store.findByTenantIdAndPauseId("default", newId);
      expect(closed).toMatchObject({
        status: PauseStatus.Cancelled,
        resolution: PauseResolution.Cancelled,
        answer: { decision: approve },
      });
      expect(seen.refunds).toEqual([]);
      await until(() => seen.notTaken.length === 1);
      expect(seen.notTaken[0]).toMatchObject({ pauseId: newId, orderId: "7" });
    },
  );
});

describe("#946 AC3: the deadline, and the races", () => {
  extension(
    "AC3: after the deadline a reassignment is refused 'expired', before the look expired the pause and after; nothing is made",
    async ({ app, clock }) => {
      const paused = await execute(app, managerFlow.start, { orderId: "o-1" }, THREAD);
      const pauseId = told.sent[0]?.pauseId ?? "";
      const deadline = paused.pending[0]?.expiresAt ?? "";
      const store = app.resolve(PausedExecutionRepository);

      // the look is held back: the pause still reads Pending at its deadline
      const look = vi.spyOn(store, "findPendingByExpiresAtBefore").mockResolvedValue([]);
      await clock.advance(hours(24));
      const early = await failureOf(
        app.reassignPause(
          { pauseId, channel: ExtendManagerBackupChannel, assignees: ["deputy-3"] },
          manager,
        ),
      );
      look.mockRestore();
      await clock.advance(seconds(10));
      await until(
        async () =>
          (await store.findByTenantIdAndPauseId("default", pauseId))?.status !==
          PauseStatus.Pending,
      );
      const late = await failureOf(
        app.reassignPause(
          { pauseId, channel: ExtendManagerBackupChannel, assignees: ["deputy-3"] },
          manager,
        ),
      );

      for (const refused of [early, late]) {
        expect(refused).toBeInstanceOf(PauseError.Closed);
        expect(refused).toMatchObject({ reason: PauseClosedReason.Expired, closedAt: deadline });
      }
      expect(told.sent).toHaveLength(1);
      expect(
        (await store.findAllByTenantIdAndRootExecutionId("default", paused.executionId)).length,
      ).toBe(1);
    },
  );

  extension(
    "#1366: at the very instant of the deadline a reassignment is refused before it reaches the store",
    async ({ app, clock }) => {
      await execute(app, managerFlow.start, { orderId: "o-1" }, THREAD);
      const pauseId = told.sent[0]?.pauseId ?? "";
      const store = app.resolve(PausedExecutionRepository);
      const look = vi.spyOn(store, "findPendingByExpiresAtBefore").mockResolvedValue([]);
      const write = vi.spyOn(store, "reassignByTenantIdAndPauseId");
      await clock.advance(hours(24));

      const refused = await failureOf(
        app.reassignPause(
          { pauseId, channel: ExtendManagerBackupChannel, assignees: ["deputy-3"] },
          manager,
        ),
      );
      look.mockRestore();

      expect(refused).toBeInstanceOf(PauseError.Closed);
      expect(write).not.toHaveBeenCalled();
    },
  );

  extension(
    "AC3: two reassignments at once from two instances: exactly one wins, one new send, the other is refused 'reassigned'",
    async ({ apps }) => {
      await execute(instance(apps, 0), managerFlow.start, { orderId: "o-1" }, THREAD);
      const pauseId = told.sent[0]?.pauseId ?? "";

      const results = await Promise.allSettled([
        instance(apps, 1).reassignPause(
          { pauseId, channel: ExtendManagerBackupChannel, assignees: ["deputy-1"] },
          manager,
        ),
        instance(apps, 2).reassignPause(
          { pauseId, channel: ExtendManagerBackupChannel, assignees: ["deputy-2"] },
          manager,
        ),
      ]);

      expect(results.filter((one) => one.status === "fulfilled")).toHaveLength(1);
      const lost = rejectionsOf(results);
      expect(lost).toHaveLength(1);
      const [refused] = lost;
      expect(refused).toBeInstanceOf(PauseError.Closed);
      expect(refused).toMatchObject({ reason: PauseClosedReason.Reassigned });
      expect(told.sent.filter((ask) => ask.replaces !== undefined)).toHaveLength(1);
    },
  );

  extension(
    "AC3: a reassignment and an answer at once, either order: exactly one wins",
    async ({ apps }) => {
      for (const [index, answerFirst] of [true, false].entries()) {
        resetTold();
        const app = instance(apps, 0);
        await execute(
          app,
          managerFlow.start,
          { orderId: `o-${String(index)}` },
          { threadId: `race-${String(index)}` },
        );
        const pauseId = told.sent[0]?.pauseId ?? "";
        const answer = () => instance(apps, 1).resume({ pauseId, decision: approve }, manager);
        const move = () =>
          instance(apps, 2).reassignPause(
            { pauseId, channel: ExtendManagerBackupChannel, assignees: ["deputy-1"] },
            manager,
          );

        const started = answerFirst ? [answer(), move()] : [move(), answer()];
        const results = await Promise.allSettled(started);

        expect(results.filter((one) => one.status === "fulfilled")).toHaveLength(1);
        const reassignedOk = told.sent.some((ask) => ask.replaces !== undefined);
        const [loser] = rejectionsOf(results);
        expect(loser).toBeInstanceOf(PauseError.Closed);
        expect(loser).toMatchObject({
          // the loser is refused with the reason of the close that won
          reason: reassignedOk ? PauseClosedReason.Reassigned : PauseClosedReason.Answered,
        });
        // the reassignment won: the deputy's answer finishes the run; the answer won: nothing was made
        if (reassignedOk) {
          const newId = told.sent.find((ask) => ask.replaces !== undefined)?.pauseId ?? "";
          expect(
            (await instance(apps, 1).resume({ pauseId: newId, decision: approve }, manager)).status,
          ).toBe(ExecutionStatus.Finished);
        } else expect(told.sent).toHaveLength(1);
      }
    },
  );

  extension(
    "AC2: a thread owner's pause the channel decides at once for: the answer is the channel's, never the owner's who only reassigned it",
    async ({ app }) => {
      await execute(app, ownerFlow.start, { orderId: "o-1" }, { ...THREAD, ownerId: "alice" });
      const pauseId = (await pausesOf(app))[0]?.pauseId ?? "";
      told.ownerDecides = approve;

      await app.reassignPause(
        { pauseId, channel: ExtendOwnerBackupChannel, assignees: ["deputy-3"] },
        { ownerId: "alice" },
      );

      const store = app.resolve(PausedExecutionRepository);
      const all = await store.findPageByTenantId("default", { statuses: [PauseStatus.Taken] }, 10);
      expect(all.pauses).toHaveLength(1);
      const [taken] = all.pauses;
      expect(taken?.answer?.actor?.id).toBe(taken?.channel);
      expect(taken?.answer?.actor?.id).not.toBe("alice");
      expect(told.recorded).toEqual(["o-1: approved"]);
    },
  );

  extension(
    "AC3: the replacement keeps the deadline: it expires at the old pause's, the channel decides, the run goes on",
    async ({ app, clock }) => {
      const paused = await execute(app, managerFlow.start, { orderId: "o-1" }, THREAD);
      const pauseId = told.sent[0]?.pauseId ?? "";
      const deadline = paused.pending[0]?.expiresAt ?? "";
      await clock.advance(hours(1));
      await app.reassignPause(
        { pauseId, channel: ExtendManagerBackupChannel, assignees: ["deputy-3"] },
        manager,
      );
      const newId = told.sent.find((ask) => ask.replaces !== undefined)?.pauseId ?? "";
      const store = app.resolve(PausedExecutionRepository);

      expect((await store.findByTenantIdAndPauseId("default", newId))?.expiresAt).toBe(deadline);
      await clock.advance(hours(22));
      expect((await store.findByTenantIdAndPauseId("default", newId))?.status).toBe(
        PauseStatus.Pending,
      );
      await clock.advance(hours(1));
      await clock.advance(seconds(10));
      await until(() => told.recorded.length === 1);

      // the first interrupt of the step still names the old pause; the live one expired and decided
      expect(told.recorded).toEqual(["o-1: approved"]);
      expect((await store.findByTenantIdAndPauseId("default", newId))?.resolution).toBe(
        PauseResolution.DecidedOnExpiry,
      );
    },
  );

  extension(
    "AC3: a second reassignment of the replacement: step key ~r2, never ~r1~r1; the last one answers",
    async ({ app }) => {
      await execute(app, managerFlow.start, { orderId: "o-1" }, THREAD);
      const first = told.sent[0]?.pauseId ?? "";
      await app.reassignPause(
        { pauseId: first, channel: ExtendManagerBackupChannel, assignees: ["deputy-1"] },
        manager,
      );
      const second = told.sent.find((ask) => ask.replaces?.pauseId === first)?.pauseId ?? "";

      await app.reassignPause(
        { pauseId: second, channel: ExtendManagerChannel, assignees: ["deputy-2"] },
        manager,
      );

      const third = told.sent.find((ask) => ask.replaces?.pauseId === second);
      expect(third).toMatchObject({ assignees: ["deputy-2"] });
      const keys = await stepKeysOf(app, first);
      const base = keys[0] ?? "";
      expect(keys).toEqual([base, `${base}~r1`, `${base}~r2`]);
      // the old ids answer nothing; the last one does
      await expectReassigned(app, [first, second]);
      const done = await app.resume({ pauseId: third?.pauseId ?? "", decision: approve }, manager);
      expect(done.status).toBe(ExecutionStatus.Finished);
    },
  );
});

describe("#946: who may reassign, and what is refused", () => {
  extension(
    "the respondent is checked as for an answer (a thread owner's pause)",
    async ({ app }) => {
      await execute(app, ownerFlow.start, { orderId: "o-1" }, { ...THREAD, ownerId: "alice" });
      const pauseId = (await pausesOf(app))[0]?.pauseId ?? "";
      const request = { pauseId, channel: ExtendOwnerBackupChannel, assignees: ["deputy-3"] };

      expect(await failureOf(app.reassignPause(request, { ownerId: "bob" }))).toBeInstanceOf(
        ExecutionError.ThreadOwnerMismatch,
      );
      expect(await failureOf(app.reassignPause(request, manager))).toBeInstanceOf(
        PauseError.PermissionDenied,
      );
      const moved = await app.reassignPause(request, { ownerId: "alice" });

      expect(moved.pauseKey).toHaveLength(32);
    },
  );

  extension("a Channel pause needs answeredBy: none and ownerId are refused", async ({ app }) => {
    await execute(app, managerFlow.start, { orderId: "o-1" }, THREAD);
    const request = {
      pauseId: told.sent[0]?.pauseId ?? "",
      channel: ExtendManagerBackupChannel,
      assignees: ["deputy-3"],
    };

    for (const options of [{}, { actor: { id: " " } }, { ownerId: "alice" }])
      expect(await failureOf(app.reassignPause(request, options as never))).toBeInstanceOf(
        PauseError.PermissionDenied,
      );
    expect(told.sent).toHaveLength(1);
  });

  extension(
    "an assignee that is no key's text is a ValidationError.DtoInvalid on ReassignPauseRequest",
    async ({ app }) => {
      await execute(app, managerFlow.start, { orderId: "o-1" }, THREAD);
      const pauseId = told.sent[0]?.pauseId ?? "";

      for (const assignee of [
        "",
        " x",
        "x ",
        "a  b",
        "a\u0000b",
        "x".repeat(2000),
        "bob\uD800",
        5,
        undefined,
      ])
        expect(
          await failureOf(
            app.reassignPause(
              { pauseId, channel: ExtendManagerBackupChannel, assignees: [assignee] as never },
              manager,
            ),
          ),
        ).toMatchObject({ name: "ValidationError.DtoInvalid", dto: "ReassignPauseRequest" });
      expect(
        await failureOf(
          app.reassignPause(
            { pauseId: "", channel: ExtendManagerBackupChannel, assignees: ["x"] },
            manager,
          ),
        ),
      ).toBeInstanceOf(ValidationError.DtoInvalid);
      expect(told.sent).toHaveLength(1);
    },
  );

  extension(
    "another tenant's pause, and an unknown one, are PauseError.UnknownPause",
    async ({ app }) => {
      await execute(
        app,
        managerFlow.start,
        { orderId: "o-1" },
        { ...THREAD, tenant: { tenantId: "acme" } },
      );
      const request = {
        pauseId: told.sent[0]?.pauseId ?? "",
        channel: ExtendManagerBackupChannel,
        assignees: ["deputy-3"],
      };

      expect(await failureOf(app.reassignPause(request, manager))).toBeInstanceOf(
        PauseError.UnknownPause,
      );
      expect(
        await failureOf(
          app.reassignPause({ ...request, pauseId: "nope" }, { ...manager, tenantId: "acme" }),
        ),
      ).toBeInstanceOf(PauseError.UnknownPause);
      const moved = await app.reassignPause(request, { ...manager, tenantId: "acme" });
      expect(moved.pauseKey).toBeDefined();
    },
  );

  extension(
    "a closed pause is refused with the reason of its close, a decided-at-once one never waited",
    async ({ app }) => {
      await execute(app, managerFlow.start, { orderId: "o-1" }, THREAD);
      const pauseId = told.sent[0]?.pauseId ?? "";
      await app.resume({ pauseId, decision: approve }, manager);

      const refused = await failureOf(
        app.reassignPause(
          { pauseId, channel: ExtendManagerBackupChannel, assignees: ["deputy-3"] },
          manager,
        ),
      );

      expect(refused).toBeInstanceOf(PauseError.Closed);
      expect(refused).toMatchObject({ reason: PauseClosedReason.Answered });
    },
  );
});

/** The step keys of the tree of pause `pauseId`, sorted. */
async function stepKeysOf(app: TestApp, pauseId: string): Promise<readonly string[]> {
  const store = app.resolve(PausedExecutionRepository);
  const root = (await store.findByTenantIdAndPauseId("default", pauseId))?.rootExecutionId ?? "";
  const tree = await store.findAllByTenantIdAndRootExecutionId("default", root);
  return tree.map((pause) => pause.stepKey).sort();
}

/** Every id of `ids` is refused as reassigned. */
async function expectReassigned(app: TestApp, ids: readonly string[]): Promise<void> {
  for (const pauseId of ids)
    expect(await failureOf(app.resume({ pauseId, decision: approve }, manager))).toMatchObject({
      reason: PauseClosedReason.Reassigned,
    });
}

/** Every pause the application's store holds, oldest first. */
async function pausesOf(app: { resolve: <T>(token: abstract new (...args: never[]) => T) => T }) {
  const store = app.resolve(PausedExecutionRepository);
  return (await store.findPageByTenantId("default", { statuses: [PauseStatus.Pending] }, 50))
    .pauses;
}
