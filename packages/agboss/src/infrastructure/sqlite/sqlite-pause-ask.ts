import { z } from "zod";
import { ComponentKind, type ComponentRecord } from "../../flow/runtime/records.js";
import type { PauseRecord } from "../pause-record.js";

/** The tool call an approval's pause asks about. */
const StoredApprovalAsk = z.object({
  callId: z.string(),
  tool: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  summary: z.string(),
});

/** #746: a question role's ask is its own DTO, kept as written; an approval's is the tool call. */
export const askOfStored = (
  ask: Readonly<Record<string, unknown>>,
  component: ComponentRecord | undefined,
): PauseRecord["ask"] =>
  component?.kind === ComponentKind.Question ? ask : StoredApprovalAsk.parse(ask);
