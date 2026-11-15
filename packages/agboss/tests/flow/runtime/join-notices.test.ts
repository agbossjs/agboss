import { describe, expect, it } from "vitest";
import { InMemoryPausedExecutionRepository } from "../../../src/infrastructure/in-memory-paused-execution.repository.js";
import { noticeJoinFailed } from "../../../src/flow/runtime/launch/join-notices.js";
import { BranchStatus } from "../../../src/flow/runtime/launch/records.js";
import type { LaunchPauses } from "../../../src/flow/runtime/launch/withdrawn-pauses.js";
import { branchKeyOf } from "../../../src/flow/runtime/pause.js";
import { PauseNoticeKind } from "../../../src/infrastructure/pause-notices.js";
import type { PauseRecord } from "../../../src/infrastructure/pause-record.js";
import {
  APPROVED_BY_MANAGER,
  BEFORE_DEADLINE,
  expiringPauseOf,
  RECIPIENTS,
} from "../../../src/testing/contracts/paused-execution-data.js";

/**
 * #945 — the join's outcome notice: written once per answered pause whatever runs the join (a crash
 * runs it again, another instance too), for the branches that finished only.
 */

const EXECUTION = "run-1";
const ticket = {
  launchId: `${EXECUTION}:launcher:1`,
  key: "launcher",
  launcher: "launcher",
  visitNumber: 1,
  items: 2,
  taken: 2,
  branches: [0, 1].map((index) => ({
    index,
    node: `approver-${String(index)}-agent`,
    nodeId: `approver-${String(index)}-agent`,
    copyNumber: 1,
    visitNumber: 1,
    stepsBefore: 0,
    failure: "fail-fast" as never,
  })),
};

const keyOf = (index: number): string =>
  branchKeyOf({
    executionId: EXECUTION,
    nodeId: `approver-${String(index)}-agent`,
    visitNumber: 1,
  });

/** A pause of branch `index`: sent, answered, taken. */
async function takenPause(
  store: InMemoryPausedExecutionRepository,
  index: number,
): Promise<PauseRecord> {
  const made: PauseRecord = {
    ...expiringPauseOf(`pause-${String(index)}`, `${keyOf(index)}:call-1`),
    nodeId: `approver-${String(index)}-agent`,
    branchKeys: [keyOf(index)],
  };
  await store.findOrCreateByStepKey(made);
  await store.markSentByTenantIdAndPauseId("default", made.pauseId, RECIPIENTS);
  await store.resolveByTenantIdAndPauseId(
    "default",
    made.pauseId,
    APPROVED_BY_MANAGER,
    BEFORE_DEADLINE,
    RECIPIENTS,
  );
  await store.markTakenByTenantIdAndPauseId("default", made.pauseId);
  return made;
}

const site = (store: InMemoryPausedExecutionRepository): LaunchPauses => ({
  stores: {
    pauses: store,
    answers: { record: () => Promise.resolve() } as never,
    notices: { recipientsOf: () => RECIPIENTS, delivered: () => undefined },
  },
  tenantId: "default",
  rootExecutionId: EXECUTION,
  launchExecutionId: EXECUTION,
  now: () => BEFORE_DEADLINE,
});

const record = (index: number, status: BranchStatus) => ({
  launchId: ticket.launchId,
  index,
  status,
  read: [],
});

describe("noticeJoinFailed", () => {
  it("writes one notice per answered pause however many times the join runs", async () => {
    const store = new InMemoryPausedExecutionRepository();
    await takenPause(store, 0);
    const failure = {
      ticket,
      records: [record(0, BranchStatus.Finished), record(1, BranchStatus.Expired)],
      errorCode: "step.pause-expired",
    };

    await noticeJoinFailed(site(store), failure);
    await noticeJoinFailed(site(store), failure);

    const claims = await store.claimNoticesDue(
      new Date("2027-01-01T00:00:00Z"),
      10,
      60_000 as never,
      ["channel:refund-approval-channel"],
    );
    const kinds = claims.flatMap((claim) => claim.mailbox.notices.map((notice) => notice.kind));
    expect(kinds.filter((kind) => kind === PauseNoticeKind.JoinFailed)).toHaveLength(1);
  });

  it("tells no branch that did not finish", async () => {
    const store = new InMemoryPausedExecutionRepository();
    await takenPause(store, 0);

    await noticeJoinFailed(site(store), {
      ticket,
      records: [record(0, BranchStatus.Cancelled), record(1, BranchStatus.Expired)],
      errorCode: "step.pause-expired",
    });

    const claims = await store.claimNoticesDue(
      new Date("2027-01-01T00:00:00Z"),
      10,
      60_000 as never,
      ["channel:refund-approval-channel"],
    );
    expect(
      claims
        .flatMap((claim) => claim.mailbox.notices)
        .filter((n) => n.kind === PauseNoticeKind.JoinFailed),
    ).toEqual([]);
  });

  it("does nothing without the application's pause stores", async () => {
    await expect(
      noticeJoinFailed(undefined, { ticket, records: [], errorCode: "x" }),
    ).resolves.toBeUndefined();
  });
});
