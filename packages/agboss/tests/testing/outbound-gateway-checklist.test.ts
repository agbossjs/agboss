/**
 * #508 AC5 — `outboundGatewayChecklist` probes G1–G5 through an adapter: against a full
 * `FakeOutboundGateway` every requirement passes; with one capability off its requirement fails
 * visibly, its evidence saying what it costs (no lookup: reconciliation cannot work).
 */
import { describe, expect, it } from "vitest";
import {
  FakeOutboundGateway,
  GatewayCheckStatus,
  GatewayRequirement,
  outboundGatewayChecklist,
  VirtualClock,
  type FakeGatewayCapabilities,
  type GatewayChecklistReport,
} from "../../src/testing/index.js";
import { hours, seconds } from "../../src/units/index.js";

/** The checklist against a fake with `capabilities`, through an adapter of the fake's own calls. */
function checklistOn(capabilities: Partial<FakeGatewayCapabilities> = {}, withClock = true) {
  const clock = new VirtualClock();
  const gateway = new FakeOutboundGateway({ clock, capabilities });
  return outboundGatewayChecklist({
    send: (charge) => gateway.charge(charge),
    ...(gateway.capabilities.lookupByKey ? { lookup: (key: string) => gateway.lookup(key) } : {}),
    ...(withClock ? { clock } : {}),
  });
}

const statusesOf = (report: GatewayChecklistReport) =>
  Object.fromEntries(report.results.map((result) => [result.requirement, result.status]));

const evidenceOf = (report: GatewayChecklistReport, requirement: GatewayRequirement): string =>
  report.results.find((result) => result.requirement === requirement)?.evidence ?? "";

const ALL_PASSED = {
  G1: GatewayCheckStatus.Passed,
  G2: GatewayCheckStatus.Passed,
  G3: GatewayCheckStatus.Passed,
  G4: GatewayCheckStatus.Passed,
  G5: GatewayCheckStatus.Passed,
};

describe("#508 AC5: the checklist against the fake gateway, offline", () => {
  it("AC5: each requirement passes on a full fake and fails visibly when its capability is off", async () => {
    const full = await checklistOn();

    expect(statusesOf(full)).toEqual(ALL_PASSED);
    expect(full.isPassed).toBe(true);
    expect(full.results.map((result) => result.requirement)).toEqual([
      "G1",
      "G2",
      GatewayRequirement.KeyRetention,
      "G4",
      GatewayRequirement.ConflictOnMismatch,
    ]);
  });

  it.each([
    [
      GatewayRequirement.LookupByKey,
      { lookupByKey: false },
      /no lookup by key: reconciliation cannot work/,
    ],
    [
      GatewayRequirement.KeyRetention,
      { keyRetention: seconds(1) },
      /after 24 h key .* made a new payment .*a late replay is a new charge/,
    ],
    [
      GatewayRequirement.FirstResponseOnRepeat,
      { firstResponseOnRepeat: false },
      /a repeat cannot be told from a new charge/,
    ],
    [
      GatewayRequirement.ConflictOnMismatch,
      { conflictOnMismatch: false },
      /with another amount was accepted .*only AGBoss's fingerprint/,
    ],
  ] as const)(
    "AC5: %s off — only it fails, its evidence saying what it costs",
    async (requirement, capabilities, evidence) => {
      const report = await checklistOn(capabilities);

      expect(statusesOf(report)).toEqual({
        ...ALL_PASSED,
        [requirement]: GatewayCheckStatus.Failed,
      });
      expect(evidenceOf(report, requirement)).toMatch(evidence);
      expect(report.isPassed).toBe(false);
    },
  );

  it("AC5: G1 off — no idempotency fails every requirement that rests on it", async () => {
    const report = await checklistOn({ idempotencyKeys: false });

    expect(statusesOf(report)).toEqual({
      G1: GatewayCheckStatus.Failed,
      G2: GatewayCheckStatus.Failed,
      G3: GatewayCheckStatus.Failed,
      G4: GatewayCheckStatus.Failed,
      G5: GatewayCheckStatus.Failed,
    });
    expect(evidenceOf(report, GatewayRequirement.IdempotencyKeys)).toMatch(
      /made a second payment .*a crash after sending can charge twice/,
    );
    expect(evidenceOf(report, GatewayRequirement.LookupByKey)).toMatch(/did not find payment/);
  });

  it("the evidence of a pass names what showed it", async () => {
    const report = await checklistOn();

    expect(evidenceOf(report, GatewayRequirement.IdempotencyKeys)).toBe(
      "a repeat of key agboss-checklist-g1 gave the same payment pay-1",
    );
    expect(evidenceOf(report, GatewayRequirement.ConflictOnMismatch)).toMatch(/was refused: key/);
  });

  it("no clock to move: G3 is skipped, not failed — the run still passes", async () => {
    const report = await checklistOn({}, false);

    expect(statusesOf(report)).toEqual({ ...ALL_PASSED, G3: GatewayCheckStatus.Skipped });
    expect(evidenceOf(report, GatewayRequirement.KeyRetention)).toMatch(/no clock to move/);
    expect(report.isPassed).toBe(true);
  });

  it("a gateway that fails a probe fails that requirement with the error as evidence", async () => {
    const report = await outboundGatewayChecklist({
      send: () => Promise.reject(new Error("sandbox is down")),
      lookup: () => Promise.resolve(undefined),
    });

    expect(report.results.every((result) => result.status !== GatewayCheckStatus.Passed)).toBe(
      true,
    );
    expect(evidenceOf(report, GatewayRequirement.IdempotencyKeys)).toBe(
      "the gateway failed the probe: sandbox is down",
    );
  });

  it("a lookup that finds a payment for a key never sent fails G2", async () => {
    const report = await outboundGatewayChecklist({
      send: () => Promise.resolve({ paymentId: "pay-1" }),
      lookup: () => Promise.resolve({ paymentId: "pay-1" }),
      requiredRetention: hours(1),
      keyPrefix: "sandbox-run-3",
    });

    expect(evidenceOf(report, GatewayRequirement.LookupByKey)).toBe(
      "a key never sent found payment pay-1",
    );
    expect(evidenceOf(report, GatewayRequirement.IdempotencyKeys)).toContain("sandbox-run-3-g1");
  });
});
