import type { RagMode, RagTenancy } from "../rag/types.js";

/** One knowledge base of an agent. */
export interface RagSnapshot {
  readonly name: string;
  readonly mode: RagMode;
  readonly topK: number;
  /** Whose content it serves (#796). */
  readonly tenancy: RagTenancy;
}

/** An agent's knowledge bases as `describe --json` carries them: its config entries, no reranking. */
export const ragSnapshotsOf = (rag: readonly RagSnapshot[] | undefined): readonly RagSnapshot[] =>
  (rag ?? []).map(({ name, mode, topK, tenancy }) => ({ name, mode, topK, tenancy }));
