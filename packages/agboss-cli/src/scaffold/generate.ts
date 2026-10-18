import { namesOf } from "./names.js";
import { planWorkflow } from "./plan.js";
import { planAgent, planRouter } from "./generate-flow.js";
import { planArbiter } from "./generate-arbiter.js";
import { ScaffoldUsageError } from "./errors.js";
import { planMcp, planRag, planTool, withScripts } from "./generate-parts.js";
import { planOpenApi } from "./openapi.js";
import { workflowScripts } from "./project.js";
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
  readonly workflow?: string | undefined;
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
  workflow: (root, name) => {
    const n = namesOf(name);
    const spec = {
      name,
      agents: [{ name: "assistant", description: `Helps with ${n.title}`, tools: [] }],
      mcp: { kind: "none" } as const,
    };
    return {
      create: planWorkflow(spec),
      modify: [withScripts(root, workflowScripts(n, `:${n.kebab}`))],
    };
  },
  agent: planAgent,
  router: planRouter,
  arbiter: planArbiter,
  tool: planTool,
  mcp: planMcp,
  rag: planRag,
  openapi: (root, name, o) => planOpenApi(root, name, o),
};

/**
 * `agboss generate <kind> <name>`: what to create and which existing files to rewire — targets resolved
 * from the workflow module, tests placed where the project's vitest config looks (#197).
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
