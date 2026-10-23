import type { KeyObject } from "node:crypto";
import { z } from "zod";
import type { MeshEnvelope } from "./mesh-envelope.js";
import { encodeJws, readJws, type JwsSignature } from "./mesh-jws.js";

/**
 * The envelope as text (#398): a compact JWS of type `agboss-mesh` — signed (`EdDSA`) with the
 * caller's `mesh.signingKey`, else unsecured (`alg: "none"`). Anything else — too long, not a JWS,
 * another `alg`, a payload that is not an envelope of `schema: 1` — is not an envelope: the
 * receiver reads the request as one without (a claim it cannot read is no claim; stripping the
 * header is no different).
 */

const TYP = "agboss-mesh";

const ID = z.string().min(1).max(500);

const HopSchema = z.object({ application: ID, start: ID, executionId: ID });

const EnvelopeSchema = z.object({
  schema: z.literal(1),
  issuer: ID,
  audience: ID.optional(),
  origin: z.object({
    rootExecutionId: ID,
    executionId: ID,
    parentExecutionId: ID.optional(),
    workflow: z.object({ name: ID, version: ID }),
    step: z.object({ component: ID, idempotencyKey: ID, tool: ID.optional() }),
  }),
  callChain: z.array(HopSchema).max(64),
  issuedAt: z.iso.datetime().optional(),
  expiresIn: ID.optional(),
  bodyHash: ID.optional(),
  budget: z.object({ remaining: ID, currency: z.literal("USD") }).optional(),
  deadline: z.object({ remaining: ID }).optional(),
});

/** An envelope read, and — when it was signed — what its signature covers. */
export interface ReadEnvelope {
  readonly envelope: MeshEnvelope;
  readonly signed?: JwsSignature;
}

/** The envelope as the `agboss-mesh` header / `_meta["agboss.dev/mesh"]` value. */
export const encodeMeshEnvelope = (envelope: MeshEnvelope, signingKey?: KeyObject): string =>
  encodeJws(TYP, envelope, signingKey);

/** The envelope a header value carries and its signature; `undefined` when it carries none. */
export function readMeshEnvelope(value: unknown): ReadEnvelope | undefined {
  const jws = readJws(value);
  if (jws === undefined) return undefined;
  const parsed = EnvelopeSchema.safeParse(jws.payload);
  if (!parsed.success) return undefined;
  const envelope = Object.freeze(parsed.data);
  return jws.signed === undefined ? { envelope } : { envelope, signed: jws.signed };
}

/** The envelope a header value carries; `undefined` when it carries none it can read. */
export const meshEnvelopeOf = (value: unknown): MeshEnvelope | undefined =>
  readMeshEnvelope(value)?.envelope;
