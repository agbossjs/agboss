/**
 * #1318, #1356 (mesh-charge shard): the tokens a remote run reports. A report names them only when the run used some, and
 * a caller counts them as input tokens in the step's record, even when the run cost nothing.
 */
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runInFrame } from "../../src/flow/context/frame.js";
import { ZERO_USAGE, type UsageRecord } from "../../src/finops/usage.js";
import { encodeRunReport, takeRunReport, verifiedRunReportOf } from "../../src/mesh/mesh-report.js";
import { rememberContextMeshSettings, type MeshSettings } from "../../src/mesh/mesh-settings.js";
import { VirtualClock } from "../../src/testing/index.js";
import { hours, usd } from "../../src/units/index.js";
import { MESH_DEFAULTS } from "../helpers/mesh-settings.js";

const peer = generateKeyPairSync("ed25519");
const NOW = new Date("2026-11-04T12:05:00.000Z");
const facts = {
  issuer: "peer-app",
  executionId: "exec-1",
  spentUsd: usd(0),
  bodyHash: "hash-1",
  issuedAt: NOW,
};
const peers = new Map([["peer-app", [peer.publicKey]]]);
const signed = (changes: object): string =>
  encodeRunReport({ ...facts, ...changes }, peer.privateKey);

describe("#1318: the tokens in a signed report", () => {
  it.each([
    ["500 tokens", 500],
    ["one token", 1],
  ])("%s are named, and read back as written", (_name, spentTokens) => {
    expect(verifiedRunReportOf(signed({ spentTokens }), peers, "hash-1")?.spend).toStrictEqual({
      total: "0",
      currency: "USD",
      totalTokens: spentTokens,
    });
  });

  it.each([
    ["none", undefined],
    ["zero", 0],
    ["a negative count", -5],
  ])("%s are not named at all", (_name, spentTokens) => {
    expect(verifiedRunReportOf(signed({ spentTokens }), peers, "hash-1")?.spend).toStrictEqual({
      total: "0",
      currency: "USD",
    });
  });

  it("a count that is no whole number makes the report unreadable: it counts nothing", () => {
    expect(verifiedRunReportOf(signed({ spentTokens: 1.5 }), peers, "hash-1")).toBeUndefined();
  });
});

/** What a frame's step is charged when it takes `report` for the request of "hash-1". */
async function chargedFor(report: string, cost = 0): Promise<UsageRecord[]> {
  const usage: UsageRecord[] = [];
  const application = {};
  const settings: MeshSettings = {
    application: "caller-application",
    maxMeshHops: 8,
    keys: { peers },
    ...MESH_DEFAULTS,
    clock: new VirtualClock(NOW),
    idempotencyRetention: hours(1),
    workflows: [],
    endpoints: [],
    contracts: () => Promise.reject(new Error("no contracts in a unit")),
  };
  rememberContextMeshSettings(application as never, settings);
  const spec = {
    execution: { tenant: { application }, signal: new AbortController().signal },
    step: {},
    services: { reportUsage: (record: UsageRecord) => usage.push(record) },
  } as never;
  await runInFrame(spec, () => {
    takeRunReport(
      "mcp",
      report,
      "hash-1",
      cost > 0 ? { application: "peer-app", price: usd(cost) } : undefined,
    );
    return Promise.resolve();
  });
  return usage;
}

describe("#1318: the tokens a caller counts", () => {
  it("a run that cost nothing but used tokens is a charge of those tokens, as input tokens", async () => {
    const [record, ...rest] = await chargedFor(signed({ spentTokens: 500 }));

    expect(rest).toEqual([]);
    expect(record).toMatchObject({
      caller: "service:mcp:peer-app",
      model: "mcp:peer-app",
      costUsd: 0,
      inputTokens: 500,
      outputTokens: 0,
    });
  });

  it("a run that cost dollars and used tokens is charged both", async () => {
    const [record] = await chargedFor(signed({ spentUsd: usd(2), spentTokens: 40 }));

    expect(record).toMatchObject({ costUsd: 2, inputTokens: 40 });
  });

  it("a run of dollars alone counts no tokens", async () => {
    const [record, ...rest] = await chargedFor(signed({ spentUsd: usd(2) }));

    expect(rest).toEqual([]);
    expect(record).toMatchObject({ costUsd: 2, inputTokens: ZERO_USAGE.inputTokens });
  });

  it("a run of no dollars and no tokens is no charge", async () => {
    expect(await chargedFor(signed({}))).toEqual([]);
  });
});
