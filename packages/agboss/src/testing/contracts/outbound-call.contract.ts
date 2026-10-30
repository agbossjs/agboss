import { registerContract } from "./define.js";
import { outboundAttemptCases } from "./outbound-call-attempt.cases.js";
import { outboundBusinessKeyCases } from "./outbound-call-business.cases.js";
import type { OutboundCallStores } from "./outbound-call-data.js";
import { outboundListingCases, outboundRefusalCases } from "./outbound-call-refusal.cases.js";
import { outboundTextCases } from "./outbound-call-text.cases.js";
import { outboundWriteCases } from "./outbound-call-write.cases.js";
import type { ContractTarget } from "./seam.js";

export type { OutboundCallStores } from "./outbound-call-data.js";

/**
 * `OutboundCallRepository` (#505): the intents of calls that leave the system, one per key — saved
 * `Pending` once (a second save refused, two instances racing record one), read back by any
 * instance and the holder of a newer lease, completed, failed and made pending again — a new
 * attempt only from the state its caller read (a compare-and-set, one winner); every fenced
 * method refused for a stale token, a released or an expired lease, changing nothing; listed by
 * tree and by status in the order recorded; removed by the retention cutoff on the `Clock` once
 * ended, never while pending; under a business key (#508) one intent per tenant, name and key.
 */
export function outboundCallContract(target: ContractTarget<OutboundCallStores>): void {
  registerContract(
    "outbound call contract",
    target,
    [
      outboundWriteCases(),
      outboundRefusalCases(),
      outboundListingCases(),
      outboundAttemptCases(),
      outboundTextCases(),
      outboundBusinessKeyCases(),
    ],
    (stores) => stores.calls.ping(),
  );
}
