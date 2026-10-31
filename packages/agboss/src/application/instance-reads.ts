/**
 * What an operator reads of an instance (#300, #501, #505): its probes, its lease log, its outbound
 * calls — each read under a tenant id checked as a key's text first (#568).
 */
import type { App } from "../app/types.js";
import { checkedTenantId } from "../flow/context/context-values.js";
import { shownCallOf } from "../infrastructure/fenced-effect-key.js";
import type { ExecutionLeaseEventRepository } from "../infrastructure/execution-lease-event.repository.js";
import {
  OutboundCallStatus,
  type OutboundCallRepository,
} from "../infrastructure/outbound-call.repository.js";
import type { ApplicationHealth } from "../health/health-sources.js";

/** The stores and probes an operator reads of the instance. */
export interface InstanceReadSources {
  readonly health: Pick<ApplicationHealth, "checkLiveness" | "checkReadiness">;
  readonly leaseEvents: ExecutionLeaseEventRepository;
  readonly outboundCalls: OutboundCallRepository;
}

/** What an operator reads of the instance: its probes, its lease log, its outbound calls. */
type InstanceReads = Pick<
  App,
  "checkLiveness" | "checkReadiness" | "leaseEventsOf" | "outboundCallsOf" | "pendingOutboundCalls"
>;

export const instanceReadsOf = ({
  health,
  leaseEvents,
  outboundCalls,
}: InstanceReadSources): InstanceReads => ({
  checkLiveness: () => health.checkLiveness(),
  checkReadiness: () => health.checkReadiness(),
  // #568: a tenant id is a key's text here too — on UTF-8 stores t\uD800 would read t\uFFFD's rows
  leaseEventsOf: async ({ tenantId, rootExecutionId }) => {
    checkedTenantId(tenantId);
    return leaseEvents.findAllByTenantIdAndRootExecutionIdOrderByOccurredAt(
      tenantId,
      rootExecutionId,
    );
  },
  outboundCallsOf: async ({ tenantId, rootExecutionId }) => {
    checkedTenantId(tenantId);
    // stored masked by the calling workflow's policies (#505); a business key by its handle (#508)
    return (await outboundCalls.findAllByTenantIdAndRootExecutionId(tenantId, rootExecutionId)).map(
      shownCallOf,
    );
  },
  pendingOutboundCalls: async ({ tenantId }) => {
    checkedTenantId(tenantId);
    return (
      await outboundCalls.findAllByTenantIdAndStatus(tenantId, OutboundCallStatus.Pending)
    ).map(shownCallOf);
  },
});
