/**
 * #1366 (a2a-client shard) — the receiver's checks of a signed envelope, each on its own: the signature of the issuer's
 * key, and the replay window — from `issuedAt` less the clocks' tolerance to `issuedAt` + `expiresIn` plus it, both
 * ends in — an envelope with no date or no lifetime refused as expired; the audience's refusals; and what each refusal
 * is called on the wire and said to the caller.
 */
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CLOCK_SKEW } from "../../src/mesh/mesh-defaults.js";
import { encodeJws, isSignedBy, readJws } from "../../src/mesh/mesh-jws.js";
import type { ReadEnvelope } from "../../src/mesh/mesh-envelope-codec.js";
import {
  audienceRefusalOf,
  MESH_REFUSAL_TEXT,
  MeshRefusalCode,
  signatureRefusalOf,
} from "../../src/mesh/mesh-verification.js";

vi.mock("../../src/mesh/mesh-jws.js", async (original) => {
  const real = await original<typeof import("../../src/mesh/mesh-jws.js")>();
  return { ...real, isSignedBy: vi.fn(real.isSignedBy) };
});

const issuer = generateKeyPairSync("ed25519");
const stranger = generateKeyPairSync("ed25519");
const ISSUED = Date.parse("2030-01-01T00:00:00.000Z");
const LIFETIME = 60_000;
const WINDOW = { maxClockSkew: CLOCK_SKEW, envelopeTtl: LIFETIME };

const envelopeOf = (changes: object = {}) => ({
  schema: 1,
  issuer: "caller",
  origin: {},
  callChain: [],
  issuedAt: new Date(ISSUED).toISOString(),
  expiresIn: "PT60S",
  ...changes,
});
const signedBy = (key = issuer.privateKey, changes: object = {}): ReadEnvelope => {
  const read = readJws(encodeJws("agboss-mesh-envelope", envelopeOf(changes), key));
  return {
    envelope: envelopeOf(changes) as never,
    ...(read?.signed === undefined ? {} : { signed: read.signed }),
  };
};
const at = (offset: number): Date => new Date(ISSUED + offset);
const refusal = (read: ReadEnvelope, now: Date, key = issuer.publicKey) =>
  signatureRefusalOf(read, [key], now, WINDOW);

describe("#1366: the signature of an envelope", () => {
  it("is the issuer's: another key's, or none, is refused as a bad signature", () => {
    expect(refusal(signedBy(), at(0))).toBeUndefined();
    expect(refusal(signedBy(stranger.privateKey), at(0))).toBe(MeshRefusalCode.SignatureInvalid);
    expect(refusal({ envelope: envelopeOf() as never }, at(0))).toBe(
      MeshRefusalCode.SignatureInvalid,
    );
  });

  it("is never checked against a key when the envelope carries no signature at all", () => {
    vi.mocked(isSignedBy).mockClear();

    expect(refusal({ envelope: envelopeOf() as never }, at(0))).toBe(
      MeshRefusalCode.SignatureInvalid,
    );

    expect(isSignedBy).not.toHaveBeenCalled();
  });
});

describe("#1366: the replay window of a signed envelope", () => {
  it("opens the clocks' tolerance before it was issued and closes the same after its lifetime, both ends in", () => {
    const read = signedBy();

    expect(refusal(read, at(-CLOCK_SKEW))).toBeUndefined();
    expect(refusal(read, at(-CLOCK_SKEW - 1))).toBe(MeshRefusalCode.EnvelopeExpired);
    expect(refusal(read, at(LIFETIME + CLOCK_SKEW))).toBeUndefined();
    expect(refusal(read, at(LIFETIME + CLOCK_SKEW + 1))).toBe(MeshRefusalCode.EnvelopeExpired);
    expect(refusal(read, at(LIFETIME / 2))).toBeUndefined();
    expect(CLOCK_SKEW).toBe(30_000);
  });

  it.each([
    ["no issue date", { issuedAt: undefined }],
    ["an issue date that is none", { issuedAt: "yesterday" }],
    ["no lifetime", { expiresIn: undefined }],
    ["a lifetime that is none", { expiresIn: "a minute" }],
    ["neither", { issuedAt: undefined, expiresIn: undefined }],
  ])("%s is expired, whatever the time", (_why, changes) => {
    expect(refusal(signedBy(issuer.privateKey, changes), at(0))).toBe(
      MeshRefusalCode.EnvelopeExpired,
    );
  });
});

describe("#1366: the audience of an envelope", () => {
  const read = (audience: string | undefined, isSigned = false): ReadEnvelope => ({
    envelope: envelopeOf(audience === undefined ? {} : { audience }) as never,
    ...(isSigned ? { signed: signedBy().signed } : {}),
  });

  it("an envelope that is none has nothing to refuse", () => {
    expect(audienceRefusalOf(undefined, "billing")).toBeUndefined();
  });

  it("an envelope addressed to this application is fine, to another is refused", () => {
    expect(audienceRefusalOf(read("billing"), "billing")).toBeUndefined();
    expect(audienceRefusalOf(read("other"), "billing")).toBe(MeshRefusalCode.AudienceMismatch);
  });

  it("one that names none is a claim that only restricts when unsigned, and refused when signed: it could be replayed anywhere", () => {
    expect(audienceRefusalOf(read(undefined), "billing")).toBeUndefined();
    expect(audienceRefusalOf(read(undefined, true), "billing")).toBe(
      MeshRefusalCode.AudienceMissing,
    );
  });
});

describe("#1366: the refusals a caller reads", () => {
  it("are told apart by their code, and each is said in its own words", () => {
    expect(MeshRefusalCode).toMatchInlineSnapshot(`
      {
        "AudienceMismatch": "mesh.audience-mismatch",
        "AudienceMissing": "mesh.audience-missing",
        "BodyMismatch": "mesh.body-mismatch",
        "EndpointForbidden": "mesh.endpoint-forbidden",
        "EnvelopeExpired": "mesh.envelope-expired",
        "IdempotencyKeyReused": "mesh.idempotency-key-reused",
        "PeerUnknown": "mesh.peer-unknown",
        "ReplayCheckUnavailable": "mesh.replay-check-unavailable",
        "Replayed": "mesh.replayed",
        "RequestInProgress": "mesh.request-in-progress",
        "RequestMismatch": "mesh.request-mismatch",
        "SignatureInvalid": "mesh.signature-invalid",
        "SignatureMissing": "mesh.signature-missing",
        "TenantMismatch": "mesh.tenant-mismatch",
      }
    `);
    expect(MESH_REFUSAL_TEXT).toMatchInlineSnapshot(`
      {
        "mesh.audience-mismatch": "the mesh envelope is addressed to another application",
        "mesh.audience-missing": "the signed mesh envelope is addressed to no application",
        "mesh.body-mismatch": "the mesh envelope was signed for another request body",
        "mesh.endpoint-forbidden": "the mesh peer may not call this endpoint",
        "mesh.envelope-expired": "the mesh envelope has expired or is not yet valid",
        "mesh.idempotency-key-reused": "this idempotency key was used for another tool or other arguments",
        "mesh.peer-unknown": "the mesh request is signed by no peer of this application",
        "mesh.replay-check-unavailable": "the mesh could not check the request is new",
        "mesh.replayed": "this signed mesh request was already admitted",
        "mesh.request-in-progress": "a request with this idempotency key is still running",
        "mesh.request-mismatch": "the mesh signature was made for another request",
        "mesh.signature-invalid": "the mesh envelope's signature is not its issuer's",
        "mesh.signature-missing": "this endpoint admits only signed mesh requests",
        "mesh.tenant-mismatch": "the mesh peer's tenant does not match the request",
      }
    `);
  });
});
