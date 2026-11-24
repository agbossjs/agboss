import type { ExecutionFacts } from "../context/frame.js";
import type { RuntimeContexts } from "../context/runtime-contexts.js";
import { outboundChainOf, type InboundMesh } from "../../mesh/inbound-mesh.js";
import type { ExecutionStateType } from "./state.js";

/** The origin and deadline an execution's contexts keep (#398 PR 2), as its frames' facts. */
export const meshFactsOf = (
  contexts: ExecutionStateType["contexts"],
): Pick<ExecutionFacts, "origin" | "deadline" | "quorumDeadlineAt"> => ({
  ...(contexts.mesh?.trusted === undefined ? {} : { origin: contexts.mesh.trusted.origin }),
  ...(contexts.deadline === undefined ? {} : { deadline: contexts.deadline }),
  ...(contexts.quorumDeadlineAt === undefined
    ? {}
    : { quorumDeadlineAt: contexts.quorumDeadlineAt }),
});

/** A root's call chain for its mesh calls (#398): what reached it, then its own hop. */
export const rootMeshOf = (
  contexts: RuntimeContexts,
  state: ExecutionStateType,
  executionId: string,
): InboundMesh => {
  const entry = { application: contexts.application.name, start: state.start };
  return outboundChainOf(entry, executionId, state.contexts.mesh);
};
