import { expect } from "vitest";
import {
  PauseResolution,
  type PausedExecutionRepository,
} from "../../infrastructure/paused-execution.repository.js";
import { seconds } from "../../units/index.js";
import type { ContractCase } from "./define.js";
import type { ContractInstances } from "./instance-context.js";
import {
  APPROVED_BY_MANAGER,
  expiringPauseOf,
  LISTENER_KEYS,
  RECIPIENTS,
  MID,
} from "./paused-execution-data.js";

/** #910 AC3, I9, I10: claim, acknowledge, retry and set aside — per mailbox, token-checked. */
type Instances = ContractInstances<PausedExecutionRepository>;
type Store = PausedExecutionRepository;
const [AUDIT, SLACK] = LISTENER_KEYS;
const AT = new Date("2026-01-05T11:00:00.000Z");
const at = (ms: number): Date => new Date(AT.getTime() + ms);

/** A sent pause closed at `MID`: its listener mailboxes hold `opened`, `closed`. */
async function closedPause(store: Store, id: string): Promise<void> {
  await store.findOrCreateByStepKey(expiringPauseOf(id, `run-1:s:1:${id}`));
  await store.markSentByTenantIdAndPauseId("default", id, RECIPIENTS);
  await store.resolveByTenantIdAndPauseId("default", id, APPROVED_BY_MANAGER, MID, RECIPIENTS);
}

export const DELIVERY_CASES: readonly ContractCase<PausedExecutionRepository>[] = [
  {
    name: "claim returns the head; ack advances; the next head is due at once",
    run: async ({ first, second }: Instances): Promise<void> => {
      await closedPause(first, "pause-a");

      const [claim] = await first.claimNoticesDue(AT, 10, seconds(60), [AUDIT]);
      expect(claim?.mailbox).toMatchObject({ recipient: AUDIT, delivered: 0, attempts: 0 });
      expect(claim?.mailbox.notices.map((notice) => notice.kind)).toEqual(["opened", "closed"]);
      expect(claim?.until).toEqual(at(60_000));
      if (claim === undefined) return;

      const next = await second.ackNotice(claim, at(1));
      expect(next).toMatchObject({ token: claim.token });
      expect(next?.mailbox).toMatchObject({ delivered: 1, attempts: 0, nextAttemptAt: at(1) });
      expect(next).toBeDefined();
      if (next === undefined) return;
      expect(await first.ackNotice(next, at(2))).toBeUndefined();
      expect(await first.claimNoticesDue(at(3), 10, seconds(60), [AUDIT])).toEqual([]);
    },
  },
  {
    name: "a second claimant gets nothing while the claim holds, the mailbox after it expires",
    run: async ({ first, second }: Instances): Promise<void> => {
      await closedPause(first, "pause-a");
      const [claim] = await first.claimNoticesDue(AT, 10, seconds(60), [AUDIT]);

      expect(await second.claimNoticesDue(at(59_999), 10, seconds(60), [AUDIT])).toEqual([]);
      const [taken] = await second.claimNoticesDue(at(60_000), 10, seconds(60), [AUDIT]);

      expect(taken?.token).not.toBe(claim?.token);
      expect(taken?.mailbox.recipient).toBe(AUDIT);
    },
  },
  {
    name: "an ack, retry or set-aside with a lost token changes nothing (zombie); so does an ack after `until`",
    run: async ({ first, second }: Instances): Promise<void> => {
      await closedPause(first, "pause-a");
      const [stale] = await first.claimNoticesDue(AT, 10, seconds(60), [AUDIT]);
      const [current] = await second.claimNoticesDue(at(60_000), 10, seconds(60), [AUDIT]);
      if (stale === undefined || current === undefined)
        throw new Error("both claims were expected");

      expect(await first.ackNotice(stale, at(60_001))).toBeUndefined();
      expect(await first.retryNotice(stale, at(70_000), "zombie")).toBe(false);
      expect(await first.setAsideNotices(stale, at(60_001), "zombie")).toBe(false);
      expect(await second.ackNotice(current, at(120_000))).toBeUndefined();

      const [again] = await second.claimNoticesDue(at(120_000), 10, seconds(60), [AUDIT]);
      expect(again?.mailbox).toMatchObject({ delivered: 0, attempts: 0 });
      expect(await first.countNotices()).toEqual({ live: 3, dead: 0 });
    },
  },
  {
    name: "retry sets nextAttemptAt and releases; not claimable before it",
    run: async ({ first, second }: Instances): Promise<void> => {
      await closedPause(first, "pause-a");
      const [claim] = await first.claimNoticesDue(AT, 10, seconds(60), [AUDIT]);
      if (claim === undefined) throw new Error("a claim was expected");

      expect(await first.retryNotice(claim, at(5_000), "receiver.timeout")).toBe(true);

      expect(await second.claimNoticesDue(at(4_999), 10, seconds(60), [AUDIT])).toEqual([]);
      const [again] = await second.claimNoticesDue(at(5_000), 10, seconds(60), [AUDIT]);
      expect(again?.mailbox).toMatchObject({
        attempts: 1,
        problem: "receiver.timeout",
        nextAttemptAt: at(5_000),
      });
    },
  },
  {
    name: "setAside marks dead; a dead mailbox is never claimed; counted",
    run: async ({ first, second }: Instances): Promise<void> => {
      await closedPause(first, "pause-a");
      const [claim] = await first.claimNoticesDue(AT, 10, seconds(60), [AUDIT]);
      if (claim === undefined) throw new Error("a claim was expected");
      expect(await first.countNotices()).toEqual({ live: 3, dead: 0 });

      expect(await first.setAsideNotices(claim, at(1), "receiver.gone")).toBe(true);

      expect(await second.claimNoticesDue(at(10_000_000), 10, seconds(60), [AUDIT])).toEqual([]);
      expect(await second.countNotices()).toEqual({ live: 2, dead: 1 });
    },
  },
  {
    name: "a mailbox of another recipient is not claimed; an empty list claims nothing",
    run: async ({ first }: Instances): Promise<void> => {
      await closedPause(first, "pause-a");

      expect(await first.claimNoticesDue(AT, 10, seconds(60), ["listener:nobody"])).toEqual([]);
      expect(await first.claimNoticesDue(AT, 10, seconds(60), [])).toEqual([]);
      const claims = await first.claimNoticesDue(AT, 10, seconds(60), [SLACK]);
      expect(claims.map((claim) => claim.mailbox.recipient)).toEqual([SLACK]);
    },
  },
  {
    name: "claims are per mailbox: a stuck head of one pause does not hold another's; limit and order by nextAttemptAt",
    run: async ({ first, second }: Instances): Promise<void> => {
      await closedPause(first, "pause-a");
      await closedPause(first, "pause-b");
      const [stuck] = await first.claimNoticesDue(AT, 1, seconds(60), [AUDIT]);

      const others = await second.claimNoticesDue(at(1), 10, seconds(60), [AUDIT]);

      expect(stuck).toBeDefined();
      expect(others.map((claim) => claim.mailbox.pauseId)).toEqual(
        ["pause-a", "pause-b"].filter((id) => id !== stuck?.mailbox.pauseId),
      );
    },
  },
  {
    name: "claim and ack of an empty store, and a limit outside 1–1000, are refused or empty",
    run: async ({ first }: Instances): Promise<void> => {
      expect(await first.claimNoticesDue(AT, 1000, seconds(60), [AUDIT])).toEqual([]);
      await expect(first.claimNoticesDue(AT, 0, seconds(60), [AUDIT])).rejects.toBeInstanceOf(
        RangeError,
      );
      await expect(first.claimNoticesDue(AT, 1001, seconds(60), [AUDIT])).rejects.toBeInstanceOf(
        RangeError,
      );
      await first.findOrCreateByStepKey(expiringPauseOf("pause-a"));
      await first.cancelByTenantIdAndPauseId(
        "default",
        "pause-a",
        PauseResolution.Cancelled,
        MID,
        RECIPIENTS,
      );
      expect(await first.claimNoticesDue(AT, 1, seconds(60), [AUDIT])).toEqual([]);
    },
  },
];
