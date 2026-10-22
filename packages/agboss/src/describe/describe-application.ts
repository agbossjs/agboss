import type { AssembledApplication } from "../application/assemble.js";
import type { DescribedEnvironment } from "../environments/resolve.js";
import { applicationLines, describedApplicationOf } from "./application.js";
import { channelLines } from "./channels.js";
import { describeWorkflow } from "./describe-workflow.js";
import { childSourcesIn } from "../run/versions.js";
import { treeLines } from "./tree.js";

/**
 * `agboss describe` of a whole application (#268 AC4): the tree — the workflows it lists, their
 * starts and child workflows —, each contract's implementation and why, its model providers, its
 * channels (each role's question → answer with its implementation), its budgets by scope and the
 * execution budget of each workflow, its observers and warnings, the environment, then every
 * workflow at a glance (`describeWorkflow`). No API key, no network, no project code but the
 * decorators.
 */

/** What the text is made for. */
export interface ApplicationDescription {
  /** The application's path as the caller gave it, for the header. */
  readonly source?: string;
  /** The profile every workflow is assembled with (`base` = none). */
  readonly profile?: string;
  /** The environment the tools are built with, its fields shown (secrets masked). */
  readonly environment?: DescribedEnvironment;
}

const environmentLines = (environment: DescribedEnvironment | undefined): string[] =>
  environment === undefined
    ? []
    : [
        `environment ${environment.name}`,
        ...Object.entries(environment.fields).map(([key, value]) => `  ${key} = ${value}`),
      ];

/** The application's description, line by line. */
export function describeApplication(
  assembled: AssembledApplication,
  description: ApplicationDescription = {},
): string[] {
  const described = describedApplicationOf(assembled);
  const source = description.source === undefined ? "" : ` (${description.source})`;
  return [
    `${assembled.name} ${assembled.version}${source}`,
    ...treeLines(assembled),
    ...applicationLines(described),
    ...channelLines(assembled),
    ...environmentLines(description.environment),
    ...assembled.workflows.flatMap((workflow) => [
      "",
      ...describeWorkflow(
        workflow,
        description.profile ?? "base",
        description.environment,
        childSourcesIn(assembled.workflows),
      ),
    ]),
  ];
}
