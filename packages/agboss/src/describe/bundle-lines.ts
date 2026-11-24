import type { AssembledWorkflow } from "../workflow.js";
import { filesLines } from "./files.js";
import { guardrailLines } from "./guardrails.js";
import { piiPolicyLines } from "./pii-policies.js";
import { toolInterceptorLines } from "./tool-interceptors.js";
import { memoryLines } from "./defaults.js";

/** The lines about a workflow's guardrails, interceptors, PII policies, files, memory and pauses. */
export function bundleLines(bundle: AssembledWorkflow): string[] {
  return [
    ...guardrailLines(bundle),
    ...toolInterceptorLines(bundle),
    ...piiPolicyLines(bundle),
    ...filesLines(bundle),
    ...memoryLines(bundle),
    `pause     on — tools with an approval wait for external signal`,
  ];
}
