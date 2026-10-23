import type { Class } from "../components/injection.js";
import { declaredFieldsOf } from "../environments/contract.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import type { MeshOptions } from "./mesh-options.js";

/**
 * `@Application({ mesh })` at assembly (#398 PR 2): the fields its keys name are declared by the
 * environment contract — `[mesh.signing-key-missing]` for `signingKey`, `[mesh.unknown-peer-key]`
 * for a peer's `verifyKey` — and no peer is listed twice.
 */
export function meshRuleViolations(
  application: string,
  mesh: MeshOptions | undefined,
  contract: Class | undefined,
): RuleViolation[] {
  if (mesh === undefined) return [];
  const fields = contract === undefined ? [] : declaredFieldsOf(contract);
  const where = contract?.name ?? "the environment contract";
  const problems: RuleViolation[] = [];
  const { signingKey } = mesh;
  if (signingKey !== undefined && !fields.includes(signingKey)) {
    const message = `@Application mesh.signingKey needs ${signingKey}: Secret in ${where} (an Ed25519 private key, PKCS #8 PEM)`;
    problems.push(violation("mesh.signing-key-missing", message, [application]));
  }
  return [...problems, ...peerViolations(application, mesh, fields, where)];
}

/** The peers' keys are declared, each peer once. */
function peerViolations(
  application: string,
  mesh: MeshOptions,
  fields: readonly string[],
  where: string,
): RuleViolation[] {
  const problems: RuleViolation[] = [];
  const seen = new Set<string>();
  for (const peer of mesh.peers ?? []) {
    if (!fields.includes(peer.verifyKey)) {
      const message = `@Application mesh.peers ${peer.application} needs ${peer.verifyKey}: string in ${where} (an Ed25519 public key, SPKI PEM)`;
      problems.push(violation("mesh.unknown-peer-key", message, [application]));
    }
    if (seen.has(peer.application)) {
      const message = `@Application mesh.peers lists ${peer.application} twice — one verifyKey per peer`;
      problems.push(violation("mesh.duplicate-peer", message, [application]));
    }
    seen.add(peer.application);
  }
  return problems;
}
