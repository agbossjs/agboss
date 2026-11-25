import { expect } from "vitest";
import { ExecutionCancelFencedError } from "../../app/lease-lost.js";
import type { ExecutionLease } from "../../infrastructure/execution-lease.repository.js";
import type { EffectKey } from "../../infrastructure/fenced-effect.repository.js";
import { hours } from "../../units/index.js";
import type { ContractGroup } from "./define.js";
import { effectKeyForTesting } from "./effect-key.js";
import { keyOf, leaseOf, rejectionOf, treeOf } from "./fenced-effect-data.js";
import { intentOf, type OutboundCallTarget } from "./outbound-call-data.js";

/**
 * The cancel's mark and the retention (#1117): a tree's mark is permanent — it lives on the tree's
 * lease row (#909) and no sweep lifts it, at any cutoff, once the root's lease is retired or before
 * the tree's first acquire: every new intent of the tree, a child's too, is refused for good.
 */

/** The key of `child`'s payment in the tree of `root-1`. */
const childKey = (child: ExecutionLease): EffectKey =>
  effectKeyForTesting(keyOf(child, "pay"), { rootExecutionId: "root-1" });

export const outboundCancelRetentionCases = (): ContractGroup<OutboundCallTarget> => ({
  title: "a tree's cancel mark is permanent (#1117)",
  cases: [
    {
      name: "#1117: a cancel's mark is never lifted — the root's lease retired and every retention pass at any cutoff, a live child lease of the tree and a child lease taken after it have their new intents refused",
      isFencing: true,
      run: async ({ clock, first, second }) => {
        const root = await leaseOf(first, "root-1", hours(1000));
        const child = await leaseOf(second, "child-1", hours(1000));
        await second.leases.requestCancel(treeOf(root));
        await clock.advance(hours(48));
        await first.leases.retire(root);
        const cutoff = new Date(clock.now().getTime() + hours(24));
        await first.calls.deleteExpired(cutoff);
        await second.calls.deleteExpired(cutoff);
        const later = await leaseOf(first, "child-2", hours(1000));

        const ofChild = await rejectionOf(
          second.calls.saveIfAbsent(childKey(child), intentOf(childKey(child))),
        );
        const ofLater = await rejectionOf(
          first.calls.saveIfAbsent(childKey(later), intentOf(childKey(later))),
        );

        expect(ofChild).toBeInstanceOf(ExecutionCancelFencedError);
        expect(ofLater).toBeInstanceOf(ExecutionCancelFencedError);
        expect(await first.calls.findByKey(childKey(child))).toBeUndefined();
        expect(await first.calls.findByKey(childKey(later))).toBeUndefined();
      },
    },
    {
      name: "#1117: a cancel before the tree's first acquire survives the retention — a sweep long after it, then the first acquire is token 1, and its new intent is refused",
      isFencing: true,
      run: async ({ clock, first, second }) => {
        await second.leases.requestCancel({ tenantId: "default", rootExecutionId: "execution-1" });
        await clock.advance(hours(48));
        await second.calls.deleteExpired(new Date(clock.now().getTime() + hours(24)));
        const lease = await leaseOf(first);
        const key = keyOf(lease, "pay");

        const refused = await rejectionOf(first.calls.saveIfAbsent(key, intentOf(key)));

        expect(lease.token).toBe(1);
        expect(refused).toBeInstanceOf(ExecutionCancelFencedError);
        expect(await first.calls.findByKey(key)).toBeUndefined();
      },
    },
  ],
});
