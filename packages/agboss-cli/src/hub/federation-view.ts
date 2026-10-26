import {
  checkFederation,
  federationMemberOf,
  type FederationMember,
  type FederationProblem,
} from "@agboss/core/internal";
import type { SuiteHealth } from "./derived-health.js";
import type { DescribedApplication } from "./hub-inputs.js";
import type { ObservedEdge } from "./observed-calls.js";

/**
 * Declared edges and the Blast Radius & Federation view (#401 PR 7, on #398 PR 3–4): the contracts
 * each snapshot declares (`application.contracts`) drawn as edges from consumer to producer, and
 * the problems `agboss check --federation` reports — the same function, `checkFederation`, over the
 * newest snapshot of every application — each with the consumers' workflows and tools it touches.
 * Beside them, who an application with a failing pass^k reaches: its declared and observed callers.
 */

/** One consumed contract: from the consumer's application to the producer's. */
export interface DeclaredEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: "a2a" | "mcp";
  /** The consumer's client (`desk-a2a-agent`) or MCP server and tool (`tickets-server.search`), as `check --federation` names it. */
  readonly contract: string;
  /** What it calls on the producer: a start, or an exposed MCP tool set. */
  readonly target: string;
  readonly usedBy: readonly { readonly workflow: string; readonly tool: string }[];
  /** No snapshot among the inputs describes the producer. */
  readonly isDangling: boolean;
  /** The codes of the federation problems reported on this contract. */
  readonly problems: readonly string[];
}

/** One caller of an application, by a declared contract or an observed call. */
export interface ReachedConsumer {
  readonly application: string;
  readonly workflows: readonly string[];
  readonly tools: readonly string[];
  readonly via: "declared" | "observed";
}

/** An application whose latest eval run lost pass^k on a case, and who calls it. */
export interface UnstableReach {
  readonly application: string;
  readonly suites: readonly string[];
  readonly consumers: readonly ReachedConsumer[];
}

/** What the view shows. */
export interface FederationView {
  readonly declaredEdges: readonly DeclaredEdge[];
  readonly problems: readonly FederationProblem[];
  /** Applications whose snapshot declares no contracts this agboss reads (an older describe). */
  readonly undeclared: readonly string[];
  readonly unstableReach: readonly UnstableReach[];
}

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();

function edgesOf(
  member: FederationMember,
  described: ReadonlySet<string>,
  problems: readonly FederationProblem[],
): DeclaredEdge[] {
  return member.contracts.imports.flatMap((contract): DeclaredEdge[] => {
    const to = contract.kind === "a2a" ? contract.target.application : contract.target?.application;
    if (to === undefined) return []; // a third-party MCP server: no application behind it
    const target =
      contract.kind === "a2a" ? contract.target.start : (contract.target?.expose ?? contract.tool);
    const name = contract.kind === "a2a" ? contract.client : `${contract.server}.${contract.tool}`;
    const consumer = `${member.name} › ${name}`;
    return [
      {
        from: member.name,
        to,
        kind: contract.kind,
        contract: name,
        target,
        usedBy: contract.usedBy,
        isDangling: !described.has(to),
        problems: sorted(
          problems
            .filter((problem) => problem.consumer === consumer)
            .map((problem) => problem.code),
        ),
      },
    ];
  });
}

function consumersOf(
  application: string,
  declared: readonly DeclaredEdge[],
  observed: readonly ObservedEdge[],
): ReachedConsumer[] {
  const byDeclaration = declared
    .filter((edge) => edge.to === application)
    .map((edge) => ({
      application: edge.from,
      workflows: sorted(edge.usedBy.map((use) => use.workflow)),
      tools: sorted(edge.usedBy.map((use) => use.tool)),
      via: "declared" as const,
    }));
  const byCall = observed
    .filter((edge) => edge.to === application && edge.from !== application)
    .map((edge) => ({
      application: edge.from,
      workflows: edge.workflows,
      tools: edge.tools,
      via: "observed" as const,
    }));
  return [...byDeclaration, ...byCall];
}

/** Who the applications with a failing pass^k reach. */
export function unstableReachOf(
  suitesOf: (application: string) => readonly SuiteHealth[],
  names: readonly string[],
  declared: readonly DeclaredEdge[],
  observed: readonly ObservedEdge[],
): UnstableReach[] {
  return names.flatMap((application) => {
    const failing = suitesOf(application).filter((suite) => suite.passHatK < suite.cases);
    if (failing.length === 0) return [];
    const consumers = consumersOf(application, declared, observed);
    return [{ application, suites: failing.map((suite) => suite.suite), consumers }];
  });
}

/** What the snapshots declare and what `check --federation` finds between them. */
export type DeclaredFederation = Omit<FederationView, "unstableReach">;

/** The declared side of the newest snapshot of every application. */
export function declaredFederationOf(
  snapshots: readonly DescribedApplication[],
): DeclaredFederation {
  const members: FederationMember[] = [];
  const undeclared: string[] = [];
  for (const snapshot of snapshots) {
    const read = federationMemberOf(snapshot.text, snapshot.file);
    if (read.kind === "member") members.push(read.member);
    else undeclared.push(snapshot.name);
  }
  const described = new Set(snapshots.map((snapshot) => snapshot.name));
  const [first, ...rest] = members;
  // one call compares every consumer with every producer among them — `check --federation`'s own
  const problems = first === undefined ? [] : checkFederation(first, rest).problems;
  const declaredEdges = members.flatMap((member) => edgesOf(member, described, problems));
  return { declaredEdges, problems, undeclared };
}
