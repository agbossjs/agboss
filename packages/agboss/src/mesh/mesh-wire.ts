import { z } from "zod";
import type { ErrorDetails } from "../core/errors.js";
import {
  HopsLimitExceededError,
  isMeshLimitError,
  MeshLoopDetectedError,
  type MeshLimitError,
} from "./mesh-errors.js";

/**
 * A mesh limit on the wire (#398), the #387 refusal shape `{ code, error }` plus the limit's facts
 * in `details`: the body of a `409` refusal (nothing ran), the fields a failed A2A response adds,
 * and `_meta["agboss.dev/error"]` of an MCP error result. Only the two mesh codes carry details —
 * no other error's facts leave the application.
 */
export interface MeshLimitBody {
  readonly code: string;
  readonly error: string;
  readonly details: ErrorDetails;
}

/**
 * A name on the wire (an application, a start, an execution id): printable ASCII of the shapes names
 * and ids take, never a control character, a space or a quote — what a remote says is data, not text
 * for a log or a model. Over 128 characters is not one.
 */
const NAME = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/u);

const EntrySchema = z.object({ application: NAME, start: NAME });

const HopSchema = EntrySchema.extend({ executionId: NAME });

const LoopSchema = z.object({
  code: z.literal("limit.mesh-loop"),
  details: z.object({ entry: EntrySchema, chain: z.array(HopSchema).max(64) }),
});

const HopsSchema = z.object({
  code: z.literal("limit.hops"),
  details: z.object({
    entry: EntrySchema,
    chain: z.array(HopSchema).max(64),
    maxMeshHops: z.int().min(1),
  }),
});

const BodySchema = z.discriminatedUnion("code", [LoopSchema, HopsSchema]);

/** The wire body of a mesh limit; `undefined` for any other error. */
export function meshLimitBodyOf(error: unknown): MeshLimitBody | undefined {
  if (!isMeshLimitError(error)) return undefined;
  return { code: error.code, error: error.message, details: error.details ?? {} };
}

/**
 * The mesh limit a body names (a refusal, a failed response, an MCP result); else `undefined`. The
 * caller reads a body only from a verified mesh peer (signed to its application); the error's
 * message is fixed text — the remote's names are in its fields, never in its message.
 */
export function meshLimitErrorOf(body: unknown): MeshLimitError | undefined {
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return undefined;
  const { data } = parsed;
  if (data.code === "limit.mesh-loop") {
    return new MeshLoopDetectedError({
      entry: data.details.entry,
      callChain: data.details.chain,
      isRemote: true,
    });
  }
  const { entry, chain, maxMeshHops } = data.details;
  return new HopsLimitExceededError({ entry, callChain: chain, maxMeshHops, isRemote: true });
}
