import { applicationOf } from "../application/assemble.js";
import type { Class } from "../components/injection.js";
import type { ProfileSelection } from "../config/profile-names.js";
import { childSourcesIn } from "../run/versions.js";
import { describeAssembledApplication as applicationText } from "./describe-application.js";
import { describeWorkflow as workflowText } from "./describe-workflow.js";
import {
  applicationDataOf,
  workflowDataOf,
  type DescribedApplicationData,
} from "./describe-data.js";

/**
 * `@agboss/core/describe` (#268, #1324): what an application is, read from its decorators — no key,
 * no network, nothing started. Each function takes the `@Application` class and assembles it as
 * `createApp` does; the assembly's own structures are not part of the public API.
 */

/** How the application is assembled and labelled. */
export interface DescribeApplicationOptions {
  /** The profiles layered on `base` (`"prod"`, `"prod,economy"`, `["prod", "economy"]`); default `dev`. */
  readonly profile?: ProfileSelection;
  /** Where the `defineEnv` references are read from; default `process.env`. */
  readonly processEnv?: NodeJS.ProcessEnv;
  /** The application's path as the caller gave it, for the text's header. */
  readonly source?: string;
}

const WHERE = "describeApplication";

const profileLabel = (profile: ProfileSelection | undefined): string =>
  profile === undefined ? "base" : typeof profile === "string" ? profile : profile.join(",");

const assemblyOf = (application: Class, options: DescribeApplicationOptions, where: string) =>
  applicationOf(application, { profile: options.profile, processEnv: options.processEnv }, where);

/** The application's description, line by line: its tree, implementations, channels, budgets, then each workflow. */
export async function describeApplication(
  application: Class,
  options: DescribeApplicationOptions = {},
): Promise<readonly string[]> {
  const assembled = await assemblyOf(application, options, WHERE);
  return applicationText(assembled, {
    profile: profileLabel(options.profile),
    ...(options.source === undefined ? {} : { source: options.source }),
  });
}

/** One workflow of the application at a glance, line by line; a workflow the application does not run is an error. */
export async function describeWorkflow(
  application: Class,
  workflow: Class,
  options: DescribeApplicationOptions = {},
): Promise<readonly string[]> {
  const assembled = await assemblyOf(application, options, "describeWorkflow");
  const found = assembled.workflows.find((candidate) => candidate.graph.type === workflow);
  if (found === undefined)
    throw new Error(
      `describeWorkflow: ${workflow.name} is not a workflow of ${assembled.name} — list it in @Application({ workflows }) or launch it as a child`,
    );
  return workflowText(found, profileLabel(options.profile), childSourcesIn(assembled.workflows));
}

/** The application and each of its workflows as typed data — what `agboss describe --json` prints. */
export async function describeApplicationData(
  application: Class,
  options: DescribeApplicationOptions = {},
): Promise<DescribedApplicationData> {
  const assembled = await assemblyOf(application, options, "describeApplicationData");
  const children = childSourcesIn(assembled.workflows);
  return {
    application: applicationDataOf(assembled),
    workflows: assembled.workflows.map((workflow) =>
      workflowDataOf(workflow, profileLabel(options.profile), children),
    ),
  };
}

export type {
  DescribedAgent,
  DescribedApplication,
  DescribedApplicationData,
  DescribedImplementation,
  DescribedRouter,
  DescribedTool,
  DescribedWorkflow,
} from "./describe-data.js";
export type {
  DescribedBudget,
  DescribedExecutionBudget,
  DescribedPauseListener,
} from "./application.js";
export type { ChannelImplementationReason, DescribedChannel } from "./channels.js";
export type { DescribedChild, DescribedLaunch, DescribedWorkflowTree } from "./tree.js";
export type { DescribedModelProvider } from "./model-providers.js";
export type { DescribedStorage } from "../storage/storage-assembly.js";
export type { DescribedLimits } from "./limits.js";
export type { DescribedPiiPolicy, DescribedPiiRule } from "./pii-policies.js";
export type { ImplementationReason } from "../application/implementations.js";
export type { ResolvedModelUse } from "../models/resolution.js";
export type { StepsRange } from "../flow/analyse/steps.js";
export type {
  A2AExportContract,
  A2AForeignImportContract,
  A2AImportBase,
  A2AImportContract,
  ApplicationContracts,
  ContractDto,
  ContractUse,
  McpExportContract,
  McpImportContract,
} from "./contracts-types.js";
export type {
  DtoSchemaSnapshot,
  SchemasSnapshot,
  ToolSchemaSnapshot,
  WorkflowSnapshot,
} from "./snapshot.js";
export type { JsonSchema } from "../dto/schema.js";
export type { WorstCase, WorstCaseChild } from "../flow/analyse/worst-case.js";
export type {
  AgentSnapshot,
  NodeSnapshot,
  RagSnapshot,
  RouteSnapshot,
  RouterSnapshot,
} from "./snapshot-nodes.js";
export type {
  ArbiterSnapshot,
  EdgeSnapshot,
  EdgeValueSnapshot,
  ErrorHandlerSnapshot,
  LaunchSnapshot,
  QuorumSnapshot,
} from "./snapshot-flow.js";
export type { EdgeKind } from "../flow/analyse/flow-graph.js";
export type { DescribedShape } from "../flow/runtime/join-keys.js";
export type { ActionSnapshot } from "./compensation.js";
export type { ElementGuardrailsSnapshot } from "./guardrails.js";
export type { AgentFilesSnapshot } from "./files.js";
