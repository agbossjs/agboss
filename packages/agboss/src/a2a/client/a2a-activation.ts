import { skillOf } from "./a2a-card.js";
import type { Wire } from "./a2a-card-cache.js";
import type { A2AClientContract } from "./a2a-client-options.js";
import { A2AMesh } from "./a2a-guard-errors.js";
import { AGBOSS_MESH, type A2AMeshActivation, type A2AMeshSeam } from "./a2a-mesh-seam.js";

/** What a client's call to a card's agent is activated with. */
export interface ActivationSource {
  readonly agent: string;
  readonly contract: A2AClientContract | undefined;
  /** The seam of the calling application; none → the AGBoss mesh. */
  readonly seam: A2AMeshSeam | undefined;
}

/**
 * The mesh of a call to the card's agent, and the skill the call names (#809, #810): the contract's
 * `mesh`, else `Required` toward an AGBoss application and `IfSupported` toward any other.
 */
export function activatedMeshOf(
  wire: Wire,
  source: ActivationSource,
): { readonly activation: A2AMeshActivation; readonly skill?: string } {
  const { card, peer } = wire.checked;
  const { agent, contract } = source;
  const application = contract?.application;
  const skill = skillOf(card, {
    agent,
    skill: contract?.skill,
    input: undefined,
    output: undefined,
  });
  const mesh =
    contract?.mesh ?? (application === undefined ? A2AMesh.IfSupported : A2AMesh.Required);
  const seam = source.seam ?? AGBOSS_MESH;
  const activation = seam.activate(card, peer, { agent, application, skill, mesh });
  return skill === undefined ? { activation } : { activation, skill };
}
