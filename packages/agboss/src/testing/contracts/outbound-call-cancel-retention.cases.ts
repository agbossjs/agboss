import { expect } from "vitest";
import { ExecutionCancelFencedError } from "../../app/lease-lost.js";
import { hours } from "../../units/index.js";
import type { ContractGroup } from "./define.js";
import { keyOf, leaseOf, rejectionOf, treeOf } from "./fenced-effect-data.js";
import { intentOf, type OutboundCallTarget } from "./outbound-call-data.js";

/**
 * The cancel's mark and the retention (#909): the mark is lifted by a sweep only when its tree is
 * over (its lease retired), never by age alone — a tree that is not over, paused for longer than
 * the retention and resumed on another instance, still has its new intents refused.
 */
export const outboundCancelRetentionCases = (): ContractGroup<OutboundCallTarget> => ({
  title: "a tree's cancel mark and the retention (#909)",
  cases: [
    {
      name: "#909: a cancel's mark is not lifted by the retention while its tree has not retired — a sweep at any cutoff, long after the cancel, and a new intent is still refused",
      run: async ({ clock, first, second }) => {
        const lease = await leaseOf(first, "execution-1", hours(1000));
        await second.leases.requestCancel(treeOf(lease));
        await clock.advance(hours(48));
        const key = keyOf(lease, "pay");

        await second.calls.deleteByEndedAtBefore(new Date(clock.now().getTime() + hours(24)));
        const refused = await rejectionOf(first.calls.saveIfAbsent(key, intentOf(key)));

        expect(refused).toBeInstanceOf(ExecutionCancelFencedError);
        expect(await first.calls.findByKey(key)).toBeUndefined();
      },
    },
  ],
});
