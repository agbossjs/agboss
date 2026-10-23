import { z } from "zod";
import type { MeshEnvelope } from "./mesh-envelope.js";

/**
 * The envelope as text (#398 PR 1): an unsecured JWS compact serialisation
 * (`base64url(header).base64url(payload).` — RFC 7515 A.5). PR 2 signs the same payload; a
 * receiver of PR 1 reads only `alg: "none"`. Anything else — too long, not three parts, another
 * `alg`, a payload that is not an envelope of `schema: 1` — is not an envelope: the receiver reads
 * the request as one without (a claim it cannot read is no claim; stripping the header is no
 * different).
 */

const HEADER = { alg: "none", typ: "agboss-mesh" } as const;

/** The longest header read: a chain of 64 hops fits many times over. */
const MAX_LENGTH = 16_384;

const ID = z.string().min(1).max(500);

const HopSchema = z.object({ application: ID, start: ID, executionId: ID });

const EnvelopeSchema = z.object({
  schema: z.literal(1),
  issuer: ID,
  origin: z.object({
    rootExecutionId: ID,
    executionId: ID,
    parentExecutionId: ID.optional(),
    workflow: z.object({ name: ID, version: ID }),
    step: z.object({ component: ID, idempotencyKey: ID }),
  }),
  callChain: z.array(HopSchema).max(64),
});

const HeaderSchema = z.object({ alg: z.literal("none") });

const encodePart = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

/** The envelope as the `agboss-mesh` header / `_meta["agboss.dev/mesh"]` value. */
export const encodeMeshEnvelope = (envelope: MeshEnvelope): string =>
  `${encodePart(HEADER)}.${encodePart(envelope)}.`;

const decodePart = (part: string): unknown => {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
};

/** The envelope a header value carries; `undefined` when it carries none it can read. */
export function meshEnvelopeOf(value: unknown): MeshEnvelope | undefined {
  if (typeof value !== "string" || value.length > MAX_LENGTH) return undefined;
  const [header, payload, signature, ...rest] = value.split(".");
  if (header === undefined || payload === undefined || signature !== "" || rest.length > 0)
    return undefined;
  if (!HeaderSchema.safeParse(decodePart(header)).success) return undefined;
  const parsed = EnvelopeSchema.safeParse(decodePart(payload));
  return parsed.success ? Object.freeze(parsed.data) : undefined;
}
