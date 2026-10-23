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

const NAME = z.string().min(1).max(200);

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

/** The mesh limit a body names (a refusal, a failed response, an MCP result); else `undefined`. */
export function meshLimitErrorOf(body: unknown): MeshLimitError | undefined {
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return undefined;
  const { data } = parsed;
  if (data.code === "limit.mesh-loop") {
    return new MeshLoopDetectedError(data.details.entry, data.details.chain);
  }
  const { entry, chain, maxMeshHops } = data.details;
  return new HopsLimitExceededError(entry, chain, maxMeshHops);
}
