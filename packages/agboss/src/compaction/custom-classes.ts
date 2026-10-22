import type { Class } from "../components/injection.js";
import type { AssembledCompactions } from "./assembly.js";
import { CompactionStrategy } from "./compaction.decorator.js";

/** The custom compactions in use (#382): the classes the container creates, at start. */
export const customCompactionClassesOf = (
  compactions: AssembledCompactions | undefined,
): readonly Class[] =>
  (compactions?.compactions ?? []).flatMap((compaction) =>
    compaction.strategy === CompactionStrategy.Custom ? [compaction.type] : [],
  );
