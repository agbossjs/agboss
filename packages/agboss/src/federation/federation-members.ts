import type { A2AExportContract } from "../describe/contracts-types.js";
import {
  FederationProblemCode,
  type FederationMember,
  type FederationProblem,
} from "./federation-types.js";

/** The members of a federation (#398 PR 4): one per application, and the project's own versions. */

/** The members by name; two of one name are a problem, the first kept. */
export function byName(members: readonly FederationMember[]): {
  readonly named: ReadonlyMap<string, FederationMember>;
  readonly problems: readonly FederationProblem[];
} {
  const named = new Map<string, FederationMember>();
  const problems: FederationProblem[] = [];
  for (const member of members) {
    const known = named.get(member.name);
    if (known === undefined) {
      named.set(member.name, member);
      continue;
    }
    problems.push({
      code: FederationProblemCode.DuplicateApplication,
      producer: member.name,
      consumer: "",
      message: `${member.name} is given twice (${known.file}, ${member.file}) — one snapshot per application`,
      file: member.file,
      blastRadius: [],
      isWarning: false,
    });
  }
  return { named, problems };
}

/** The current project's exports whose schema changed since its earlier snapshot, same version. */
export function versionProblems(
  current: FederationMember,
  earlier: FederationMember | undefined,
): FederationProblem[] {
  if (earlier === undefined) return [];
  return current.contracts.exports.flatMap((exported): FederationProblem[] => {
    if (exported.kind !== "a2a") return [];
    const before = earlier.contracts.exports.find(
      (old) => old.kind === "a2a" && old.expose === exported.expose && old.start === exported.start,
    );
    if (before?.kind !== "a2a" || before.version !== exported.version) return [];
    const hashes = (contract: A2AExportContract): string =>
      JSON.stringify([
        contract.input?.schemaHash,
        contract.outputs.map((output) => output.schemaHash),
      ]);
    if (hashes(before) === hashes(exported)) return [];
    return [
      {
        code: FederationProblemCode.VersionNotBumped,
        producer: `${current.name} › ${exported.start}`,
        consumer: "",
        message: `${exported.expose} ${exported.version}: its schema changed since ${earlier.file} — raise its version`,
        file: current.file,
        blastRadius: [],
        isWarning: true,
      },
    ];
  });
}
