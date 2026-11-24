import { usd } from "../../src/units/index.js";
/**
 * #1366 (mesh-charge shard) — which signed report a caller takes, each rule on its own: only one that is signed by
 * the key of the peer it names, for the very request it sent (its body hash), and well formed; every other counts
 * nothing. The report is typed on the wire.
 */
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { encodeJws, isSignedBy } from "../../src/mesh/mesh-jws.js";
import { encodeRunReport, verifiedRunReportOf } from "../../src/mesh/mesh-report.js";

vi.mock("../../src/mesh/mesh-jws.js", async (original) => {
  const real = await original<typeof import("../../src/mesh/mesh-jws.js")>();
  return { ...real, isSignedBy: vi.fn(real.isSignedBy) };
});

const peer = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");
const peers = new Map([["peer-app", peer.publicKey]]);
const facts = {
  issuer: "peer-app",
  executionId: "exec-1",
  spentUsd: usd(0.25),
  bodyHash: "hash-1",
  issuedAt: new Date("2030-01-01T00:00:00.000Z"),
};
const signed = (changes: object = {}, key = peer.privateKey): string =>
  encodeRunReport({ ...facts, ...changes }, key);

describe("#1366: the report a caller takes", () => {
  it("is the one the issuer's key signed for this request, as it was signed", () => {
    expect(verifiedRunReportOf(signed(), peers, "hash-1")).toEqual({
      schema: 1,
      issuer: "peer-app",
      executionId: "exec-1",
      spend: { total: "0.25", currency: "USD" },
      bodyHash: "hash-1",
      issuedAt: "2030-01-01T00:00:00.000Z",
    });
  });

  it("is typed on the wire", () => {
    const header = signed().split(".")[0] ?? "";

    expect(JSON.parse(Buffer.from(header, "base64url").toString("utf8"))).toEqual({
      alg: "EdDSA",
      typ: "agboss-mesh-report",
    });
  });

  it.each([
    ["another request's hash", () => verifiedRunReportOf(signed(), peers, "hash-2")],
    [
      "an issuer no key is known for",
      () => verifiedRunReportOf(signed({ issuer: "stranger" }), peers, "hash-1"),
    ],
    [
      "a signature of another key",
      () => verifiedRunReportOf(signed({}, other.privateKey), peers, "hash-1"),
    ],
    [
      "no signature",
      () => verifiedRunReportOf(encodeJws("agboss-mesh-report", { ...facts }), peers, "hash-1"),
    ],
    ["a text that is no report", () => verifiedRunReportOf("not a jws", peers, "hash-1")],
    ["a value that is no text", () => verifiedRunReportOf(42, peers, "hash-1")],
  ])("%s counts nothing", (_why, take) => {
    expect(take()).toBeUndefined();
  });

  it("is never verified against a key that is not held: an issuer with none is refused before any check is made", () => {
    vi.mocked(isSignedBy).mockClear();

    expect(verifiedRunReportOf(signed({ issuer: "stranger" }), peers, "hash-1")).toBeUndefined();

    expect(isSignedBy).not.toHaveBeenCalled();
  });

  it.each([
    ["a payload of another shape", { schema: 1, issuer: "peer-app" }],
    [
      "a currency that is not dollars",
      {
        schema: 1,
        issuer: "peer-app",
        executionId: "e",
        spend: { total: "1", currency: "EUR" },
        bodyHash: "hash-1",
        issuedAt: "2030-01-01T00:00:00.000Z",
      },
    ],
    [
      "a date that is none",
      {
        schema: 1,
        issuer: "peer-app",
        executionId: "e",
        spend: { total: "1", currency: "USD" },
        bodyHash: "hash-1",
        issuedAt: "yesterday",
      },
    ],
  ])("%s, though signed by the peer for this request, counts nothing", (_why, payload) => {
    const report = encodeJws("agboss-mesh-report", payload, peer.privateKey);

    expect(verifiedRunReportOf(report, peers, "hash-1")).toBeUndefined();
  });
});
