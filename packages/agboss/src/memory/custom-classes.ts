import type { Class } from "../components/injection.js";
import type { AssembledMemories } from "./assembly.js";
import { CUSTOM_COMPACTION } from "./memory.decorator.js";

/** The code compactions in use: the classes the container creates, at start. */
export const customCompactionClassesOf = (
  memories: AssembledMemories | undefined,
): readonly Class[] =>
  (memories?.memories ?? []).flatMap((memory) =>
    memory.mode === CUSTOM_COMPACTION ? [memory.type] : [],
  );
