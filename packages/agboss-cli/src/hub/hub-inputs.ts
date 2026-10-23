import type { ExecutionHistoryRecord } from "agboss";
import type { EvalRunReport } from "agboss/eval";

/**
 * What `agboss hub` reads (#401 S2, the report's architecture 3): files and folders only, each file
 * saying what it is by its own marker — a `describe --json` envelope (`command: "describe"`), a run
 * artifact (`kind: "agboss.eval-run"`), an export of kept executions (JSON Lines of
 * `kind: "agboss.execution-record"`). No manifest, no path convention, no network.
 */

/** The three kinds of input, by their marker. */
export enum HubInputKind {
  Describe = "describe",
  EvalRun = "agboss.eval-run",
  ExecutionRecord = "agboss.execution-record",
}

/** A tool of a described workflow: a local one, or one of an MCP server. */
export interface DescribedTool {
  readonly name: string;
  readonly kind: string;
  /** The MCP server it belongs to (`kind: "mcp"`). */
  readonly server?: string;
  /** The channel it pauses on. */
  readonly channel?: string;
}

/** A node of a described workflow: its name and kind (`agent`, `router`, `action`, `workflow`, …). */
export interface DescribedNode {
  readonly name: string;
  readonly kind: string;
}

/** One workflow of a snapshot, as the Hub draws it. */
export interface DescribedWorkflow {
  readonly name: string;
  readonly version: string;
  readonly configHash: string;
  readonly nodes: readonly DescribedNode[];
  readonly tools: readonly DescribedTool[];
}

/** A channel of a snapshot: a role (answered through a project's implementation) or a concrete one. */
export interface DescribedChannel {
  readonly name: string;
  readonly isRole: boolean;
}

/** One application's `describe --json` snapshot. */
export interface DescribedApplication {
  readonly name: string;
  readonly version: string;
  /** The file it was read from, as given (relative to the working directory). */
  readonly file: string;
  readonly workflows: readonly DescribedWorkflow[];
  readonly channels: readonly DescribedChannel[];
  /** The file's text, for the readers that compare snapshots (`check --federation`'s, #398). */
  readonly text: string;
}

/** A run artifact and its file. */
export interface HubEvalRun {
  readonly file: string;
  readonly report: EvalRunReport;
}

/** A kept execution and the file it was exported to. */
export interface HubRecord {
  readonly file: string;
  readonly record: ExecutionHistoryRecord;
}

/** One file read, and what it held. */
export interface HubInputFile {
  readonly file: string;
  readonly kind: HubInputKind;
  /** Records in an export; 1 for a snapshot or a run artifact. */
  readonly count: number;
}

/** Everything the paths held. */
export interface HubInputs {
  readonly files: readonly HubInputFile[];
  readonly applications: readonly DescribedApplication[];
  readonly evalRuns: readonly HubEvalRun[];
  readonly records: readonly HubRecord[];
}
