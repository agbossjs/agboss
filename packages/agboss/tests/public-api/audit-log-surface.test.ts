/**
 * #889 — the execution audit log's surface (API review G6): the committed API reports (kept equal
 * to the build by `api-report.test.ts`) name the audit log, the tree query, `pendingOutboundCallsOf`,
 * `LeaseTakeoverReason.Reclaimed` and `retention.auditLog`, and nothing of the "lease event" names
 * before them; the hooks `ExecutionObserver` is made of are exported, one `HookResult` spelling.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ExecutionAuditLogRepository,
  LeaseTakeoverReason,
  type App,
  type AuditLogHooks,
  type ExecutionAuditEventRecord,
  type ExecutionObserver,
  type ExecutionTreeQuery,
  type HookResult,
  type OnExecutionLeaseTakeover,
  type OnFencedEffect,
  type OnOutboundCall,
  type OnStepHandedOver,
  type RetentionOptions,
} from "../../src/index.js";

const reports = new URL("../../api/", import.meta.url).pathname;
const reportNames = readdirSync(reports).filter((name) => name.endsWith(".api.md"));
const reportOf = (name: string): string => readFileSync(join(reports, name), "utf8");
const allReports = reportNames.map(reportOf).join("\n");

/** The symbols a report says no entry point exports, by report. */
const forgottenIn = (report: string): string[] =>
  [...report.matchAll(/\(ae-forgotten-export\) The symbol "([^"]+)"/gu)].map(
    (match) => match[1] ?? "",
  );

describe("#889 AC2: the audit log in the public surface", () => {
  it("AC2: the root report names the new names", () => {
    const root = reportOf("agboss.api.md");
    for (const name of [
      "class ExecutionAuditLogRepository",
      "class SqliteExecutionAuditLogRepository",
      "type ExecutionAuditEventRecord",
      "interface ExecutionAuditEventBase",
      "enum ExecutionAuditEventKind",
      "interface AuditEventStep",
      "interface ExecutionTreeQuery",
      "auditLogOf(tree: ExecutionTreeQuery)",
      "outboundCallsOf(tree: ExecutionTreeQuery)",
      "pendingOutboundCallsOf(",
      'Reclaimed = "reclaimed"',
      "readonly auditLog?: Milliseconds",
      "readonly auditLog?: readonly ExecutionAuditEventRecord[]",
      "type AuditLogHooks",
      "type HookResult",
    ])
      expect(root, name).toContain(name);
    expect(reportOf("agboss-testing-contracts.api.md")).toContain("executionAuditLogContract");
  });

  it("AC2: no report keeps a name of before", () => {
    for (const gone of [
      "ExecutionLeaseEvent",
      "leaseEventsOf",
      "LeaseEventsQuery",
      "LeaseEventHooks",
      "LeaseEventStep",
      "pendingOutboundCalls(",
      "Reacquired",
      "leaseEvents",
      "executionLeaseEvent",
    ])
      expect(allReports, gone).not.toContain(gone);
  });

  it("AC2: the types say the same", () => {
    expectTypeOf<App["auditLogOf"]>().parameter(0).toEqualTypeOf<ExecutionTreeQuery>();
    expectTypeOf<App["outboundCallsOf"]>().parameter(0).toEqualTypeOf<ExecutionTreeQuery>();
    expectTypeOf<ReturnType<App["auditLogOf"]>>().toEqualTypeOf<
      Promise<readonly ExecutionAuditEventRecord[]>
    >();
    expectTypeOf<RetentionOptions["auditLog"]>().not.toBeNever();
    expect(LeaseTakeoverReason.Reclaimed).toBe("reclaimed");
    expect(Object.keys(LeaseTakeoverReason)).not.toContain("Reacquired");
    expect(ExecutionAuditLogRepository.name).toBe("ExecutionAuditLogRepository");
  });
});

describe("#889 AC3: the observer's hooks are exported", () => {
  it("AC3: no report has the audit log's hooks or HookResult as a forgotten export", () => {
    for (const name of reportNames)
      expect(forgottenIn(reportOf(name)), name).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/^(AuditLogHooks|HookResult)$/u)]),
      );
  });

  it("AC3: everything ExecutionObserver is made of is exported by every entry that exports it", () => {
    for (const name of reportNames)
      expect(
        forgottenIn(reportOf(name)).filter((symbol) =>
          /^On[A-Z]|Hooks$|^HookResult$/u.test(symbol),
        ),
        name,
      ).toEqual([]);
  });

  it("AC3: AuditLogHooks is the four hooks, each returning HookResult", () => {
    expectTypeOf<AuditLogHooks>().toEqualTypeOf<
      OnExecutionLeaseTakeover & OnStepHandedOver & OnFencedEffect & OnOutboundCall
    >();
    expectTypeOf<ReturnType<AuditLogHooks["onOutboundCall"]>>().toEqualTypeOf<HookResult>();
    expectTypeOf<
      ReturnType<AuditLogHooks["onExecutionLeaseTakeover"]>
    >().toEqualTypeOf<HookResult>();
    expectTypeOf<Required<ExecutionObserver>>().toExtend<AuditLogHooks>();

    // an observer of the four hooks, typed by the exported names alone, is an ExecutionObserver
    const done = (): HookResult => undefined;
    const hooks: AuditLogHooks = {
      onExecutionLeaseTakeover: done,
      onStepHandedOver: done,
      onFencedEffect: done,
      onOutboundCall: done,
    };
    const observer: ExecutionObserver = hooks;
    expect(Object.keys(observer)).toEqual([
      "onExecutionLeaseTakeover",
      "onStepHandedOver",
      "onFencedEffect",
      "onOutboundCall",
    ]);
  });
});
