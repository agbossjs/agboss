import type { FencedEffectReport, HandOverReport, OutboundCallReport } from "./audit-log.js";
import type { AuditLogWriter } from "./execution-leases.js";
import { AuditLogReports, CancelFoundHooks } from "./lease-yields.js";

/**
 * What a held lease records of its steps (#501, #505): their hand-overs, fenced effects and
 * outbound calls, written to the audit log in the lease's order — the lease is released (or
 * abandoned, #928) only after them.
 */
export abstract class ReportingLease extends CancelFoundHooks {
  protected readonly reports = new AuditLogReports();
  abstract readonly scopeKey: string;

  protected constructor(private readonly events: AuditLogWriter | undefined) {
    super();
  }

  recordHandOver(report: HandOverReport): void {
    this.reports.handOver(this.events, report, this.scopeKey);
  }

  recordFencedEffect(report: FencedEffectReport): void {
    this.#stepCall((record, log, holder) => record.recordFencedEffect(log, report, holder));
  }

  recordOutboundCall(report: OutboundCallReport): void {
    this.#stepCall((record, log, holder) => record.recordOutboundCall(log, report, holder));
  }

  /** A step's call under the lease, written to the audit log in the lease's order. */
  #stepCall(write: Parameters<AuditLogReports["stepCall"]>[1]): void {
    this.reports.stepCall(this.events, write);
  }
}
