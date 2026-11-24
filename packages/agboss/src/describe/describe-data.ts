import type { AssembledApplication } from "../application/assemble.js";
import type { ImplementationReason } from "../application/implementations.js";
import type { DescribedEnvironment } from "../environments/resolve.js";
import type { ResolvedModelUse } from "../models/resolution.js";
import { resolvedModelUsesOf } from "../models/resolution.js";
import type { StepsRange } from "../flow/analyse/steps.js";
import { stepsRangeOf } from "../flow/analyse/steps.js";
import { flowLines } from "../flow/print.js";
import { configSnapshot, type ChildSnapshotSources } from "../run/versions.js";
import { shortVersion, versionOf } from "../turns/index.js";
import { isMcpFacade } from "../tools/index.js";
import { resolveTools, type AssembledWorkflow } from "../workflow.js";
import {
  describedApplicationOf,
  type DescribedBudget,
  type DescribedExecutionBudget,
  type DescribedPauseListener,
} from "./application.js";
import { type DescribedModelProvider } from "./model-providers.js";
import type { DescribedStorage } from "../storage/storage-assembly.js";
import { describedChannelsOf, type DescribedChannel } from "./channels.js";
import { contractsOf } from "./contracts.js";
import type { ApplicationContracts } from "./contracts-types.js";
import { describeServicesWith } from "./describe-workflow.js";
import { childLines, inputLines } from "./inputs.js";
import { describedLimitsOf, type DescribedLimits } from "./limits.js";
import { describedPiiPoliciesOf, type DescribedPiiPolicy } from "./pii-policies.js";
import { workflowSnapshotOf, type WorkflowSnapshot } from "./snapshot.js";
import { describedTreeOf, type DescribedWorkflowTree } from "./tree.js";

/**
 * `agboss describe --json` as typed data (#268 AC4, #1324): the application and each of its
 * workflows, read from the decorators only — no key, no network. The CLI prints them; code reads
 * them through `describeApplicationData` of `@agboss/core/describe`.
 */

/** A contract and the class that implements it in the application, and why. */
export interface DescribedImplementation {
  readonly contract: string;
  readonly implementation: string;
  readonly reason: ImplementationReason;
}

/** The application as data: its infrastructure, model providers, budgets, tree, channels, contracts and environment. */
export interface DescribedApplication {
  readonly name: string;
  readonly version: string;
  /** Every workflow it runs: the listed ones, then the children they launch. */
  readonly workflows: readonly string[];
  readonly implementations: readonly DescribedImplementation[];
  /** `@Application({ storage })`: each storage component with its driver; absent = none declared. */
  readonly storage?: readonly DescribedStorage[];
  readonly modelProviders: readonly DescribedModelProvider[];
  readonly budgets: readonly DescribedBudget[];
  readonly executionBudgets: readonly DescribedExecutionBudget[];
  readonly observers: readonly string[];
  readonly pauseListeners: readonly DescribedPauseListener[];
  readonly warnings: readonly string[];
  /** The name of its default calendar for working time; absent = none. */
  readonly workingCalendar?: string;
  /** The instance's cap on steps (#332); `null` when the application sets none. */
  readonly maxConcurrentSteps: number | null;
  /** The workflows it lists, each with its children. */
  readonly tree: readonly DescribedWorkflowTree[];
  readonly channels: readonly DescribedChannel[];
  /** What it exports and consumes, each DTO with its `schemaHash` (#398: `check --federation`). */
  readonly contracts: ApplicationContracts;
  /** The environment the tools are built with, its fields shown (secrets masked). */
  readonly environment?: {
    readonly name: string;
    readonly fields: Readonly<Record<string, string>>;
  };
}

/** A tool of a described workflow: a local one, or one of an MCP server. */
export interface DescribedTool {
  readonly name: string;
  readonly description: string;
  readonly kind: "local" | "mcp";
  /** The MCP server it belongs to (`kind: "mcp"`). */
  readonly server?: string;
  /** The channel it pauses on. */
  readonly channel?: string;
}

/** A router of a described workflow. */
export interface DescribedRouter {
  readonly name: string;
  readonly model: string;
  readonly description: string;
  readonly maxVisits?: number;
}

/** An agent of a described workflow. */
export interface DescribedAgent {
  readonly name: string;
  readonly model: string;
  readonly description: string;
  readonly tools: readonly string[];
  /** The names of its knowledge bases. */
  readonly rag: readonly string[];
}

/** One workflow at a glance as data, with its declarative snapshot (#268 S93). */
export interface DescribedWorkflow extends WorkflowSnapshot {
  readonly name: string;
  readonly version: string;
  /** The profile it is assembled with (`base` = none). */
  readonly profile: string;
  /** The short form of `configHash`. */
  readonly config: string;
  readonly piiPolicies: readonly DescribedPiiPolicy[];
  readonly flow: readonly string[];
  readonly inputs: readonly string[];
  /** The start each edge into a child workflow enters through (#263). */
  readonly children: readonly string[];
  readonly routers: readonly DescribedRouter[];
  readonly agents: readonly DescribedAgent[];
  /** The provider each model resolves to. */
  readonly models: readonly ResolvedModelUse[];
  readonly tools: readonly DescribedTool[];
  readonly unassignedTools: readonly string[];
  readonly limits: DescribedLimits;
  readonly steps: StepsRange;
}

/** The application and every workflow in the order it runs them. */
export interface DescribedApplicationData {
  readonly application: DescribedApplication;
  readonly workflows: readonly DescribedWorkflow[];
}

/** The application as data (`describe --json`'s `application`). */
export function applicationDataOf(
  assembled: AssembledApplication,
  environment: DescribedEnvironment | undefined,
): DescribedApplication {
  const described = describedApplicationOf(assembled);
  return {
    ...described,
    maxConcurrentSteps: described.maxConcurrentSteps ?? null,
    implementations: described.implementations.map((choice) => ({
      contract: choice.contract.name,
      implementation: choice.implementation.name,
      reason: choice.reason,
    })),
    tree: describedTreeOf(assembled).workflows,
    channels: describedChannelsOf(assembled),
    contracts: contractsOf(assembled),
    ...(environment === undefined
      ? {}
      : { environment: { name: environment.name, fields: environment.fields } }),
  };
}

/** One workflow at a glance, as data (the same facts as its text). */
export function workflowDataOf(
  bundle: AssembledWorkflow,
  profile = "base",
  environment?: DescribedEnvironment,
  children?: ChildSnapshotSources,
): DescribedWorkflow {
  const c = bundle.config;
  const services = describeServicesWith(environment);
  const tools = resolveTools(bundle, services).map((tool): DescribedTool => ({
    name: tool.name,
    description: tool.description,
    kind: isMcpFacade(tool) ? "mcp" : "local",
    ...(isMcpFacade(tool) ? { server: tool.mcp.server } : {}),
    ...(tool.channel === undefined ? {} : { channel: tool.channel }),
  }));
  const assigned = new Set(Object.values(c.agents).flatMap((agent) => agent.tools ?? []));
  return {
    name: c.name,
    version: c.version,
    profile,
    config: shortVersion(versionOf(configSnapshot(bundle, children))),
    piiPolicies: describedPiiPoliciesOf(bundle),
    flow: flowLines(bundle.graph.flow),
    inputs: inputLines(bundle.graph.analysis),
    children: childLines(bundle.graph.analysis),
    routers: bundle.routers.map((router) => ({
      name: router.name,
      model: router.model,
      description: router.description,
      ...(router.maxVisits === undefined ? {} : { maxVisits: router.maxVisits }),
    })),
    agents: Object.entries(c.agents).map(([name, agent]) => ({
      name,
      model: agent.model,
      description: agent.description,
      tools: agent.tools ?? [],
      rag: (agent.rag ?? []).map((kb) => kb.name),
    })),
    models: resolvedModelUsesOf(bundle),
    tools,
    unassignedTools: tools.map((tool) => tool.name).filter((name) => !assigned.has(name)),
    limits: describedLimitsOf(bundle),
    steps: stepsRangeOf(bundle.graph.analysis.graph),
    ...workflowSnapshotOf(bundle, services, children),
  };
}
