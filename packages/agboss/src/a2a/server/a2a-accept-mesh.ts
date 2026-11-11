import type { NewA2ATask } from "../../infrastructure/a2a-task.repository.js";
import { meshRefusalOf } from "../../mesh/mesh-admission.js";
import type { MeshLimitError } from "../../mesh/mesh-errors.js";
import type { A2ARequestCaller, A2AServerParts } from "./a2a-server-parts.js";
import type { ServedSkill } from "./a2a-skills.js";

/** What an accepted task takes of the request's mesh (#810): its chain's limit, its caller. */

/**
 * The chain limit the message meets at this skill: checked on every envelope, trusted or not — a
 * caller only makes its own request fail with it.
 */
export function meshLimitOf(
  parts: A2AServerParts,
  caller: A2ARequestCaller,
  skill: ServedSkill,
): MeshLimitError | undefined {
  const { application, maxMeshHops } = parts.mesh;
  const receiver = { entry: { application, start: skill.id }, maxMeshHops };
  return meshRefusalOf(receiver, caller.mesh.envelope);
}

/** What a task keeps of its caller: the peer the resolver named, a trusted message's body hash. */
export function meshFieldsOf(
  caller: A2ARequestCaller,
): Pick<NewA2ATask, "callerPeer" | "meshBodyHash"> {
  const { trusted } = caller.mesh;
  const { peer } = caller.caller;
  return {
    ...(peer === undefined ? {} : { callerPeer: peer }),
    ...(trusted === undefined ? {} : { meshBodyHash: trusted.bodyHash }),
  };
}
