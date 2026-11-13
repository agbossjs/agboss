/**
 * #934: a kept history record is read whole by the core (`executionHistoryRecordOfJson`), version
 * tolerant. `history-record-0.1.0.json` is a record in the shape of 0.1.0's `ExecutionHistoryRecord`,
 * every field and every nested record filled: it was written as a typed literal against the
 * published `@agboss/core@0.1.0` declarations (the compiler of that package refused any field the
 * type does not have) and printed by that package's enums. A record at current main adds `auditLog`,
 * `outboundCalls` and the cost report's `unknownCalls`; both must read, a wrong-typed field must not.
 */
import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  executionHistoryRecordOfJson,
  StoredNamesUnreadableError,
} from "../../src/stores/index.js";

const OLD: Record<string, unknown> = JSON.parse(
  readFileSync(new URL("./sqlite/history-record-0.1.0.json", import.meta.url), "utf8"),
);
const SECRET = "sk-live-PLANTED-SECRET-934";

/** `value` with `change` laid over its top level. */
const with_ = (change: Record<string, unknown>): unknown => ({ ...OLD, ...change });

const AUDIT = {
  kind: "outbound-call",
  occurredAt: "t",
  tenantId: "default",
  rootExecutionId: "run-1",
  executionId: "run-1",
  scopeKey: "default:run-1",
  token: 3,
  holderInstanceId: "i-1",
  name: "charge",
  target: "pay",
  operation: "charge",
  status: "completed",
  attempt: 1,
  outcome: "sent",
  step: { nodeId: "n", visitNumber: 1, idempotencyKey: "k" },
};
const CALL = {
  tenantId: "default",
  name: "charge",
  rootExecutionId: "run-1",
  executionId: "run-1",
  workflow: "w",
  target: "pay",
  operation: "charge",
  idempotencyKey: "k",
  request: "{}",
  attempt: 1,
  attemptOwner: "i-1",
  step: { nodeId: "n", visitNumber: 1 },
  status: "completed",
  result: "{}",
  token: 3,
  leaseExecutionId: "run-1",
  recordedAt: "t",
};

describe("a kept record is read whole", () => {
  it("in the shape 0.1.0 wrote it: every field is kept, the names are the new ones", () => {
    const record = executionHistoryRecordOfJson(OLD);

    expect(record).toMatchObject({
      executionId: "run-1",
      spend: { totalUsd: 0.0123, unknownCalls: 0 },
      pauses: [{ answerer: "channel", answeredBy: "manager-17" }],
      children: [{ spend: { unknownCalls: 0 }, children: [{ pauses: [{ answeredBy: "bob" }] }] }],
    });
    expect(record.steps[0]?.step).toMatchObject({ callId: "call-1", itemIndex: undefined });
    expect(record.toolCalls[0]?.remote).toEqual({ application: "peer", executionId: "r-9" });
    expect(record.compensations[0]?.compensated.compensates?.nodeId).toBe("x");
    expect(record.error?.cause?.message).toBe("inner");
    expect(record).not.toHaveProperty("auditLog");
  });

  it("at current main: with the audit log, the outbound calls and a counted unknown call", () => {
    const record = executionHistoryRecordOfJson(
      with_({
        auditLog: [AUDIT],
        outboundCalls: [CALL],
        spend: Object.assign({}, OLD.spend, { unknownCalls: 2 }),
      }),
    );

    expect(record.auditLog).toHaveLength(1);
    expect(record.outboundCalls?.[0]?.name).toBe("charge");
    expect(record.spend.unknownCalls).toBe(2);
  });

  it("a key the type does not know is dropped", () => {
    expect(executionHistoryRecordOfJson(with_({ later: 1 }))).not.toHaveProperty("later");
  });

  it.each([
    ["a spend that is a text", { spend: SECRET }, "spend"],
    ["a spend whose total is a text", { spend: { totalUsd: SECRET } }, "spend.totalUsd"],
    ["a step that is a number", { steps: [42] }, "steps.0"],
    [
      "a step whose hash is an object",
      { steps: [{ inputHash: { t: SECRET } }] },
      "steps.0.inputHash",
    ],
    [
      "a tool call with a status no one knows",
      { toolCalls: [{ status: SECRET }] },
      "toolCalls.0.status",
    ],
    ["an audit row of no kind", { auditLog: [{ kind: SECRET }] }, "auditLog.0.kind"],
    [
      "an outbound call with a text token",
      { outboundCalls: [{ ...CALL, token: SECRET }] },
      "outboundCalls.0.token",
    ],
    ["a pauses list that is a text", { pauses: SECRET }, "pauses"],
  ])("%s is unreadable: the id and the field, no value", (_name, change, field) => {
    let error: unknown;
    try {
      executionHistoryRecordOfJson(with_(change));
    } catch (thrown) {
      error = thrown;
    }

    expect(error).toBeInstanceOf(StoredNamesUnreadableError);
    if (!(error instanceof Error)) throw new TypeError("nothing was thrown");
    expect(error.message).toContain("executionId run-1");
    expect(error.message).toContain(field);
    expect(inspect(error, { depth: 12 })).not.toContain(SECRET);
  });
});
