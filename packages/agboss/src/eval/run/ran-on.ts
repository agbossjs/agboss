import { nodesOf } from "../../describe/snapshot-nodes.js";
import { frameworkPackageJson } from "../../package-json.js";
import { piiPolicyMetaOf } from "../../pii/policy-checks.js";
import type { ComponentKind } from "../../flow/runtime/records.js";
import type { AssembledWorkflow } from "../../workflow.js";

/**
 * What a run ran on beyond its workflow's name and `configHash` (#397 PR 3, schemaVersion 3): the
 * profile, every agent's and model router's model and its provider, the AGBoss version, and the
 * PII policies that masked the artifact — what the report's header shows.
 */

/** One model of the workflow: the agent or router that calls it, and who serves it. */
export interface EvalModelUse {
  readonly component: string;
  readonly kind: ComponentKind;
  readonly model: string;
  readonly provider: string;
}

/** The header's facts of a run, read from its workflow as assembled (a profile applied). */
export interface EvalRunRanOn {
  /** `--profile`; absent for the workflow as written. */
  readonly profile?: string;
  readonly agbossVersion: string;
  readonly models: readonly EvalModelUse[];
  /** The application's and the workflow's PII policies: the ones that masked records and traces. */
  readonly piiPolicies: readonly string[];
}

/** The framework's own version, from its package.json. */
function agbossVersionOf(): string {
  const parsed = frameworkPackageJson();
  const version =
    typeof parsed === "object" && parsed !== null && "version" in parsed
      ? parsed.version
      : undefined;
  return typeof version === "string" ? version : "unknown";
}

/** Every agent's and model router's model, in node order. */
function modelUsesOf(bundle: AssembledWorkflow): EvalModelUse[] {
  return nodesOf(bundle).flatMap((node): EvalModelUse[] => {
    const used = node.agent ?? node.router;
    if (used?.model === undefined || used.provider === undefined) return [];
    return [{ component: node.name, kind: node.kind, model: used.model, provider: used.provider }];
  });
}

/** What the run ran on. */
export function ranOnOf(bundle: AssembledWorkflow, profile: string | undefined): EvalRunRanOn {
  return {
    ...(profile === undefined ? {} : { profile }),
    agbossVersion: agbossVersionOf(),
    models: modelUsesOf(bundle),
    piiPolicies: (bundle.pii?.observability ?? []).map(
      (cls) => piiPolicyMetaOf(cls)?.name ?? cls.name,
    ),
  };
}
