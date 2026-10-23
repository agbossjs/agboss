import type { ContractsSnapshot } from "../describe/contracts-types.js";

/** The shapes of `agboss check --federation` (#398 PR 4; `federation.ts`). */

/** One application of the federation: its name, version, contracts and where they came from. */
export interface FederationMember {
  readonly name: string;
  readonly version: string;
  readonly file: string;
  readonly contracts: ContractsSnapshot;
}

/** The stable codes of the federation check. */
export enum FederationProblemCode {
  IncompatibleSchema = "federation.incompatible-schema",
  MissingTarget = "federation.missing-target",
  DuplicateApplication = "federation.duplicate-application",
  SnapshotSchema = "federation.snapshot-schema",
  VersionNotBumped = "federation.version-not-bumped",
}

/** A workflow of an application that a problem touches. */
export interface BlastRadiusEntry {
  readonly application: string;
  readonly workflow: string;
  readonly tool: string;
}

/** One problem: its code, who exports and who consumes, what differs, and who is affected. */
export interface FederationProblem {
  readonly code: FederationProblemCode;
  /** `billing-application › billing-workflow-start`; empty for a problem of one snapshot. */
  readonly producer: string;
  readonly consumer: string;
  readonly message: string;
  /** The file it is reported on. */
  readonly file: string;
  readonly blastRadius: readonly BlastRadiusEntry[];
  /** A warning (an error under `--strict`). */
  readonly isWarning: boolean;
}

/** What the check found. */
export interface FederationReport {
  readonly applications: readonly {
    readonly name: string;
    readonly version: string;
    readonly file: string;
  }[];
  /** How many consumed contracts it compared (their target among the applications). */
  readonly contracts: number;
  readonly problems: readonly FederationProblem[];
}
