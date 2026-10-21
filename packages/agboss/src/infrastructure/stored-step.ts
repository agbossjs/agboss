import { z } from "zod";
import { ComponentKind, type ComponentRecord } from "../flow/runtime/records.js";

/**
 * The join keys a stored pause keeps of its waiting step (#268 S93), read back with defaults: a
 * record stored before them names its agent only — an agent's record without hashes, iteration
 * unknown, no validation attempts.
 */

const optionalText = z.string().optional();

/** A component record as JSON stored it (`undefined` hashes are left out by JSON). */
export const StoredComponent = z.object({
  name: z.string(),
  kind: z.enum(ComponentKind).default(ComponentKind.Agent),
  promptHash: optionalText,
  schemaHash: optionalText,
});

/** A stored component as its record: every hash present, `undefined` when it has none. */
export const componentOfStored = (stored: z.infer<typeof StoredComponent>): ComponentRecord => ({
  name: stored.name,
  kind: stored.kind,
  promptHash: stored.promptHash,
  schemaHash: stored.schemaHash,
});

/** What a stored pause keeps of its step's loop (both absent before #268 S93). */
export const StoredLoopProgress = {
  component: StoredComponent.optional(),
  toolLoopIteration: z.number().optional(),
  validationAttempts: z.number().optional(),
};
