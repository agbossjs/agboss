import { planAgent, planRouter, planWorkflowFinish, planWorkflowStart } from "./generate-flow.js";
import { planArbiter } from "./generate-arbiter.js";
import { ScaffoldUsageError } from "./errors.js";
import { planMcp, planRag, planTool } from "./generate-parts.js";
import { planOpenApi } from "./openapi.js";
import { planNewWorkflow } from "./generate-workflow.js";
import { placeTests } from "./test-location.js";
import type { Changes } from "./write.js";

export const KINDS = [
  "workflow",
  "workflow-start",
  "workflow-finish",
  "agent",
  "router",
  "arbiter",
  "tool",
  "mcp",
  "rag",
  "openapi",
] as const;
export type Kind = (typeof KINDS)[number];

/** Single-letter / short aliases for `agboss generate <kind>` (`agboss g a`, `agboss g t`, …). */
export const KIND_ALIASES: Readonly<Record<string, Kind>> = {
  w: "workflow",
  ws: "workflow-start",
  wf: "workflow-finish",
  a: "agent",
  r: "router",
  ar: "arbiter",
  t: "tool",
  m: "mcp",
  oa: "openapi",
};

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
  "workflow-start": planWorkflowStart,
  "workflow-finish": planWorkflowFinish,
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
  const resolved = KIND_ALIASES[kind] ?? kind;
  if (!(KINDS as readonly string[]).includes(resolved))
    throw new ScaffoldUsageError(`Unknown kind "${kind}" — one of: ${KINDS.join(", ")}`);
  const plan = await PLANS[resolved as Kind](root, name, options);
  return { create: placeTests(root, plan.create), modify: plan.modify };
}
