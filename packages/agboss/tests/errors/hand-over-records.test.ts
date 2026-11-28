/** #1413 M5: a stopping application's record is a hand-over record, whichever class threw it. */
import { describe, expect, it } from "vitest";
import { ApplicationStoppingError } from "../../src/core/errors.js";
import { errorRecordOf } from "../../src/core/error-record.js";
import {
  HAND_OVER_KINDS,
  isHandOverError,
  isHandOverRecord,
} from "../../src/core/error-families/hand-over.js";
import { leaseLostBeforeStartError } from "../../src/app/lease-lost.js";
import { ExecutionLeaseLostError } from "../../src/app/lease-lost.js";
import { ExecutionError, ExecutionErrorKind } from "../../src/core/error-families/run-errors.js";

describe("isHandOverRecord", () => {
  it("takes the record of the standalone ApplicationStoppingError", () => {
    expect(
      isHandOverRecord(errorRecordOf(new ApplicationStoppingError({ message: "closing" }))),
    ).toBe(true);
  });

  it("takes the record of the standalone lease-lost errors (also one before the run started), and not a plain failure", () => {
    expect(
      isHandOverRecord(errorRecordOf(new ExecutionLeaseLostError({ rootExecutionId: "r" }))),
    ).toBe(true);
    expect(
      isHandOverRecord(
        errorRecordOf(
          leaseLostBeforeStartError(new ExecutionLeaseLostError({ rootExecutionId: "r" })),
        ),
      ),
    ).toBe(true);
    expect(
      isHandOverRecord(errorRecordOf(new ExecutionError.OutputInvalid({ message: "x" }))),
    ).toBe(false);
  });
});

describe("isHandOverError", () => {
  it("takes an ExecutionError of the Fenced kind, and no other error", () => {
    const fenced = new ExecutionError.Fenced({
      scopeKey: "acme:root-1",
      tenantId: "acme",
      leaseExecutionId: "root-1",
      token: 3,
    });

    expect([...HAND_OVER_KINDS]).toStrictEqual([ExecutionErrorKind.Fenced]);
    expect(isHandOverError(fenced)).toBe(true);
    expect(isHandOverError(new ExecutionError.OutputInvalid({ message: "x" }))).toBe(false);
    expect(isHandOverError(new Error("plain"))).toBe(false);
    expect(isHandOverError(undefined)).toBe(false);
  });

  it("takes a record whose class line holds the lease-lost code, a lease lost before the run started too", () => {
    const lost = new ExecutionLeaseLostError({ rootExecutionId: "r" });

    expect(errorRecordOf(leaseLostBeforeStartError(lost)).lineage).toContain(
      "execution.lease-lost",
    );
  });
});
