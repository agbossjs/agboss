import { registerContract } from "./define.js";
import type { OutboundCallStores } from "./outbound-call-data.js";
import { outboundListingCases, outboundRefusalCases } from "./outbound-call-refusal.cases.js";
import { outboundWriteCases } from "./outbound-call-write.cases.js";
import type { ContractTarget } from "./seam.js";

export type { OutboundCallStores } from "./outbound-call-data.js";

/**
 * `OutboundCallRepository` (#505): the intents of calls that leave the system, one per key — saved
 * `Pending` once (a second save refused, two instances racing record one), read back by any
 * instance and the holder of a newer lease, completed, failed and made pending again; every fenced
 * method refused for a stale token, a released or an expired lease, changing nothing; listed by
 * tree and by status in the order recorded; removed by the retention cutoff on the `Clock` once
 * ended, never while pending.
 */
export function outboundCallContract(target: ContractTarget<OutboundCallStores>): void {
  registerContract(
    "outbound call contract",
    target,
    [outboundWriteCases(), outboundRefusalCases(), outboundListingCases()],
    (stores) => stores.calls.ping(),
  );
}
