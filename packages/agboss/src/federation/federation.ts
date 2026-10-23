import type { JsonSchema } from "../dto/schema.js";
import type {
  A2AExportContract,
  A2AImportContract,
  ContractDto,
  McpExportContract,
  McpImportContract,
} from "../describe/contracts-types.js";
import {
  FederationProblemCode,
  type BlastRadiusEntry,
  type FederationMember,
  type FederationProblem,
  type FederationReport,
} from "./federation-types.js";
import { byName, versionProblems } from "./federation-members.js";
import { incompatibilitiesOf } from "./schema-compat.js";

export * from "./federation-types.js";

/**
 * `agboss check --federation` (#398 PR 4): the declared contracts of several applications — their
 * `describe --json` snapshots and the current project — compared without running anything. Every
 * consumed contract whose target is among them is checked against its export: the export must
 * exist (`[federation.missing-target]`), its input must accept every value the consumer sends and
 * the consumer's output every value the export gives over each of its finishes
 * (`[federation.incompatible-schema]`, structural — an equal `schemaHash` is only the fast path).
 * Each problem names its blast radius: the consumer's workflows that use the contract. An export
 * whose schema changed since the project's own earlier snapshot without a new version warns
 * `[federation.version-not-bumped]`.
 */

type Import = A2AImportContract | McpImportContract;
type Export = A2AExportContract | McpExportContract;

const nameOfImport = (contract: Import): string =>
  contract.kind === "a2a" ? contract.client : `${contract.server}.${contract.tool}`;

const targetName = (contract: Import): string =>
  contract.kind === "a2a"
    ? `${contract.target.application} › ${contract.target.start}`
    : `${contract.target?.application ?? ""} › ${contract.target?.expose ?? ""} ${contract.tool}`;

/** The export a consumed contract names, in its target application. */
function exportOf(target: FederationMember, contract: Import): Export | undefined {
  return target.contracts.exports.find((exported) => {
    if (contract.kind === "a2a")
      return exported.kind === "a2a" && exported.start === contract.target.start;
    return (
      exported.kind === "mcp" &&
      exported.expose === contract.target?.expose &&
      exported.tool === contract.tool
    );
  });
}

/** The JSON Schema of a DTO in a member's snapshot. */
const schemaOf = (member: FederationMember, dto: ContractDto): JsonSchema | undefined =>
  member.contracts.schemas[dto.dto]?.jsonSchema;

/** Why `receiver` (of `accepting`) does not accept `sent` (of `sending`); empty when it does. */
function differences(
  accepting: { readonly member: FederationMember; readonly dto: ContractDto },
  sending: { readonly member: FederationMember; readonly dto: ContractDto },
): readonly string[] {
  if (accepting.dto.schemaHash === sending.dto.schemaHash) return [];
  const receiver = schemaOf(accepting.member, accepting.dto);
  const sender = schemaOf(sending.member, sending.dto);
  if (receiver === undefined || sender === undefined)
    return ["no schema to compare (its snapshot lists none)"];
  return incompatibilitiesOf(receiver, sender);
}

/** The pair a problem is about, and its blast radius. */
interface Pairing {
  readonly consumer: FederationMember;
  readonly contract: Import;
}

const blastRadiusOf = ({ consumer, contract }: Pairing): readonly BlastRadiusEntry[] =>
  contract.usedBy.map((use) => ({ application: consumer.name, ...use }));

function problemOf(
  pairing: Pairing,
  code: FederationProblemCode,
  producer: string,
  message: string,
): FederationProblem {
  return {
    code,
    producer,
    consumer: `${pairing.consumer.name} › ${nameOfImport(pairing.contract)}`,
    message,
    file: pairing.consumer.file,
    blastRadius: blastRadiusOf(pairing),
    isWarning: false,
  };
}

/** The schema problems of one consumed contract against its export. */
function schemaProblems(
  pairing: Pairing,
  producer: FederationMember,
  exported: Export,
): FederationProblem[] {
  const { consumer, contract } = pairing;
  const where = `${producer.name} › ${exported.kind === "a2a" ? exported.start : exported.tool}`;
  const problems: FederationProblem[] = [];
  if (exported.input !== null) {
    const reasons = differences(
      { member: producer, dto: exported.input },
      { member: consumer, dto: contract.input },
    );
    if (reasons.length > 0)
      problems.push(
        problemOf(
          pairing,
          FederationProblemCode.IncompatibleSchema,
          where,
          `input ${exported.input.dto}: ${reasons.join("; ")}`,
        ),
      );
  }
  if (exported.kind !== "a2a") return problems;
  for (const output of exported.outputs) {
    const reasons = differences(
      { member: consumer, dto: contract.output },
      { member: producer, dto: output },
    );
    if (reasons.length > 0)
      problems.push(
        problemOf(
          pairing,
          FederationProblemCode.IncompatibleSchema,
          where,
          `output of ${output.finish} (${output.dto}) for ${contract.output.dto}: ${reasons.join("; ")}`,
        ),
      );
  }
  return problems;
}

/**
 * Checks the federation of `current` (the project) and `others` (its neighbours' snapshots); an
 * earlier snapshot of the project itself among them is only compared for its versions.
 */
export function checkFederation(
  current: FederationMember,
  others: readonly FederationMember[],
): FederationReport {
  const earlier = others.find((member) => member.name === current.name);
  const { named, problems: duplicates } = byName([
    current,
    ...others.filter((member) => member !== earlier),
  ]);
  const problems: FederationProblem[] = [...duplicates];
  let compared = 0;
  for (const consumer of named.values()) {
    for (const contract of consumer.contracts.imports) {
      const targetApplication =
        contract.kind === "a2a" ? contract.target.application : contract.target?.application;
      const producer = targetApplication === undefined ? undefined : named.get(targetApplication);
      if (producer === undefined) continue;
      compared += 1;
      const pairing = { consumer, contract };
      const exported = exportOf(producer, contract);
      if (exported === undefined) {
        problems.push(
          problemOf(
            pairing,
            FederationProblemCode.MissingTarget,
            targetName(contract),
            `${targetName(contract)}: no such export`,
          ),
        );
        continue;
      }
      problems.push(...schemaProblems(pairing, producer, exported));
    }
  }
  return {
    applications: [...named.values()].map(({ name, version, file }) => ({ name, version, file })),
    contracts: compared,
    problems: [...problems, ...versionProblems(current, earlier)],
  };
}
