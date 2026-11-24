import type { AssembledMemories } from "./assembly.js";
import { CUSTOM_COMPACTION } from "./memory.decorator.js";

/** What a workflow's memories summarise with: their mode and prompt, by name. */
export const memorySnapshot = (memories: AssembledMemories | undefined): object =>
  memories === undefined || memories.memories.length === 0
    ? {}
    : {
        memories: memories.memories.map(({ name, mode, prompt, type }) => ({
          name,
          strategy: mode,
          prompt,
          // a code compaction: the class that compacts — swapping it changes the hash
          ...(mode === CUSTOM_COMPACTION ? { handler: `${type.name}.compact()` } : {}),
        })),
      };
