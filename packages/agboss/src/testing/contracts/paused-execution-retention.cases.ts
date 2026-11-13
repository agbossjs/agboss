import { expect } from "vitest";
import {
  PauseResolution,
  type PausedExecutionRepository,
} from "../../infrastructure/paused-execution.repository.js";
import type { PauseNoticeClaim } from "../../infrastructure/pause-notices.js";
import { seconds } from "../../units/index.js";
import type { ContractCase } from "./define.js";
import type { ContractInstances } from "./instance-context.js";
import {
  ALL_KEYS,
  expiringPauseOf,
  LISTENER_KEYS,
  NINE,
  RECIPIENTS,
  TEN,
} from "./paused-execution-data.js";

/** #910 AC3, I11: a pause with a live mailbox is never removed; a mailbox nobody claims ends. */
type Instances = ContractInstances<PausedExecutionRepository>;
type Store = PausedExecutionRepository;
const [AUDIT] = LISTENER_KEYS;
const LATE = new Date("2026-02-01T00:00:00.000Z");

/** A sent pause `id` withdrawn at `NINE`: its mailboxes hold `opened`, `closed` (the channel's `closed`). */
async function withdrawn(store: Store, id: string): Promise<void> {
  await store.findOrCreateByStepKey(expiringPauseOf(id, `run-1:s:1:${id}`));
  await store.markSentByTenantIdAndPauseId("default", id, RECIPIENTS);
  await store.cancelByTenantIdAndPauseId(
    "default",
    id,
    PauseResolution.Withdrawn,
    NINE,
    RECIPIENTS,
  );
}

/** Acknowledges every notice of a claimed mailbox. */
async function acknowledge(store: Store, claim: PauseNoticeClaim): Promise<void> {
  let next: PauseNoticeClaim | undefined = claim;
  while (next !== undefined) next = await store.ackNotice(next, LATE);
}

export const RETENTION_CASES: readonly ContractCase<PausedExecutionRepository>[] = [
  {
    name: "deleteByResolvedAtBefore keeps a closed pause with a live mailbox, removes it once delivered, mailboxes with it",
    run: async ({ first, second }: Instances): Promise<void> => {
      await withdrawn(first, "pause-a");

      await second.deleteByResolvedAtBefore(TEN);
      expect(await first.findByTenantIdAndPauseId("default", "pause-a")).toBeDefined();
      for (const claim of await first.claimNoticesDue(LATE, 1000, seconds(60), ALL_KEYS))
        await acknowledge(first, claim);
      await second.deleteByResolvedAtBefore(TEN);

      expect(await first.findByTenantIdAndPauseId("default", "pause-a")).toBeUndefined();
      expect(await first.countNotices()).toEqual({ live: 0, dead: 0 });
    },
  },
  {
    name: "a pause whose mailboxes are dead is removed with them; findClosedByResolvedAtBefore lists exactly what the delete removes",
    run: async ({ first, second }: Instances): Promise<void> => {
      await withdrawn(first, "pause-a");
      await withdrawn(first, "pause-b");
      await first.findOrCreateByStepKey(expiringPauseOf("pause-c", "run-1:s:1:c"));
      for (const claim of await first.claimNoticesDue(LATE, 1000, seconds(60), ALL_KEYS)) {
        if (claim.mailbox.pauseId === "pause-b")
          await first.setAsideNotices(claim, LATE, "receiver.gone");
        else await acknowledge(first, claim);
      }

      const listed = await second.findClosedByResolvedAtBefore(TEN, 10);
      expect(await second.findClosedByResolvedAtBefore(TEN, 1)).toHaveLength(1);
      expect(await second.findClosedByResolvedAtBefore(NINE, 10)).toEqual([]);
      await second.deleteByResolvedAtBefore(TEN);

      expect(listed.map((pause) => pause.pauseId).sort()).toEqual(["pause-a", "pause-b"]);
      const left = await first.findAllByTenantIdAndRootExecutionId("default", "run-1");
      expect(left.map((pause) => pause.pauseId)).toEqual(["pause-c"]);
      expect(await first.countNotices()).toEqual({ live: 0, dead: 0 });
    },
  },
  {
    name: "a mailbox of a recipient nobody claims is set aside once its head is older, then the pause goes with retention; a younger head is kept",
    run: async ({ first, second }: Instances): Promise<void> => {
      await withdrawn(first, "pause-a");
      const others = ALL_KEYS.filter((key) => key !== AUDIT);
      for (const claim of await first.claimNoticesDue(LATE, 1000, seconds(1), others))
        await acknowledge(first, claim);

      expect(await second.setAsideStaleNoticesBefore(NINE, LATE, "stale", 10)).toEqual([]);
      const aside = await second.setAsideStaleNoticesBefore(TEN, LATE, "stale", 10);

      expect(aside).toEqual([{ tenantId: "default", pauseId: "pause-a", recipient: AUDIT }]);
      expect(await first.countNotices()).toEqual({ live: 0, dead: 1 });
      await second.deleteByResolvedAtBefore(TEN);
      expect(await first.findByTenantIdAndPauseId("default", "pause-a")).toBeUndefined();
    },
  },
  {
    name: "a claimed mailbox is not set aside, an unclaimed one is, at most limit",
    run: async ({ first, second }: Instances): Promise<void> => {
      await withdrawn(first, "pause-a");
      await withdrawn(first, "pause-b");
      await first.claimNoticesDue(LATE, 2, seconds(600), [AUDIT]);

      const aside = await second.setAsideStaleNoticesBefore(TEN, LATE, "stale", 10);
      const afterClaims = new Date(LATE.getTime() + 601_000);
      const one = await second.setAsideStaleNoticesBefore(TEN, afterClaims, "stale", 1);

      expect(aside).toHaveLength(4);
      expect(aside.every((box) => box.recipient !== AUDIT)).toBe(true);
      expect(one).toEqual([expect.objectContaining({ recipient: AUDIT })]);
    },
  },
];
