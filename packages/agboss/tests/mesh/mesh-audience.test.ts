import { describe, expect, it } from "vitest";
import { encodeMeshEnvelope, readMeshEnvelope } from "../../src/mesh/mesh-envelope-codec.js";
import type { MeshEnvelope } from "../../src/mesh/mesh-envelope.js";
import { audienceRefusalOf, MeshRefusalCode } from "../../src/mesh/mesh-verification.js";
import { meshKeyPair } from "../a2a/fixtures/mesh-keys.js";

/**
 * #809 security: the receiver's audience check, shared by every inbound mesh path (MCP today, the
 * A2A server in P3): a signed envelope must be addressed to the receiver — none is
 * `mesh.audience-missing`, another's `mesh.audience-mismatch`. Unsigned, it is a claim that only
 * restricts, refused only when it names someone else.
 */

const claims: MeshEnvelope = {
  schema: 1,
  issuer: "orders-application",
  origin: {
    rootExecutionId: "root-1",
    executionId: "root-1",
    workflow: { name: "orders-workflow", version: "1.0.0" },
    step: { component: "orders-desk-agent", idempotencyKey: "root-1:orders-desk-agent:1:c1" },
  },
  callChain: [],
  issuedAt: "2026-01-05T09:00:00.000Z",
  expiresIn: "PT60S",
  bodyHash: "sha256:00",
  budget: { remaining: "1", currency: "USD" },
};

const readOf = (audience: string | undefined, isSigned: boolean) =>
  readMeshEnvelope(
    encodeMeshEnvelope(
      audience === undefined ? claims : { ...claims, audience },
      isSigned ? meshKeyPair().privateKey : undefined,
    ),
  );

describe("#809 security: audienceRefusalOf", () => {
  it("a signed envelope naming no audience is mesh.audience-missing", () => {
    expect(audienceRefusalOf(readOf(undefined, true), "billing-application")).toBe(
      MeshRefusalCode.AudienceMissing,
    );
  });

  it("an envelope naming another application is mesh.audience-mismatch, signed or not", () => {
    expect(audienceRefusalOf(readOf("third-application", true), "billing-application")).toBe(
      MeshRefusalCode.AudienceMismatch,
    );
    expect(audienceRefusalOf(readOf("third-application", false), "billing-application")).toBe(
      MeshRefusalCode.AudienceMismatch,
    );
  });

  it("one addressed to the receiver holds; unsigned without an audience is a claim; none is nothing", () => {
    expect(audienceRefusalOf(readOf("billing-application", true), "billing-application")).toBe(
      undefined,
    );
    expect(audienceRefusalOf(readOf(undefined, false), "billing-application")).toBeUndefined();
    expect(audienceRefusalOf(undefined, "billing-application")).toBeUndefined();
  });
});
