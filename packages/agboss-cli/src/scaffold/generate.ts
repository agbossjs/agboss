import { planAgent, planRouter } from "./generate-flow.js";
import { planArbiter } from "./generate-arbiter.js";
import { ScaffoldUsageError } from "./errors.js";
import { planMcp, planRag, planTool } from "./generate-parts.js";
import { planOpenApi } from "./openapi.js";
import { planNewWorkflow } from "./generate-workflow.js";
import { placeTests } from "./test-location.js";
import type { Changes } from "./write.js";

export const KINDS = [
  "workflow",
  "agent",
  "router",
  "arbiter",
  "tool",
  "mcp",
  "rag",
  "openapi",
] as const;
export type Kind = (typeof KINDS)[number];

export interface GenerateOptions {
  /** The workflow a part goes into, by its full name (`desk-workflow`). */
  readonly workflow?: string | undefined;
  /** The application module; default `"agboss": { "application" }` of package.json. */
  readonly application?: string | undefined;
  readonly agent?: string | undefined;
  readonly description?: string | undefined;
  readonly dir?: string | undefined;
  readonly command?: string | undefined;
  readonly tool?: string | undefined;
  readonly folder?: string | undefined;
  readonly url?: string | undefined;
  readonly operations?: string | undefined;
}

const PLANS: Readonly<
  Record<Kind, (root: string, name: string, o: GenerateOptions) => Changes | Promise<Changes>>
> = {
  workflow: planNewWorkflow,
  agent: planAgent,
  router: planRouter,
  arbiter: planArbiter,
  tool: planTool,
  mcp: planMcp,
  rag: planRag,
  openapi: (root, name, o) => planOpenApi(root, name, o),
};

/**
 * `agboss generate <kind> <name>`: what to create and which existing files to rewire — `<name>` is
 * the full name (`billing-agent`, #268 AC8), the workflow named by `--workflow <full name>` found in
 * the application, tests placed where the project's vitest config looks (#197).
 */
export async function planGenerate(
  kind: string,
  name: string,
  options: GenerateOptions,
  root: string,
): Promise<Changes> {
  if (!(KINDS as readonly string[]).includes(kind))
    throw new ScaffoldUsageError(`Unknown kind "${kind}" — one of: ${KINDS.join(", ")}`);
  const plan = await PLANS[kind as Kind](root, name, options);
  return { create: placeTests(root, plan.create), modify: plan.modify };
}
