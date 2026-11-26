import { ComponentKind } from "../flow/runtime/records.js";
import { ComponentOptions, type OptionSlots } from "../components/component-options.js";
import type { Class } from "../components/injection.js";
import { componentOf } from "../components/metadata.js";
import { skillMapOf } from "../a2a/a2a-endpoint.decorator.js";
import type { FoldedConfig } from "../config/fold-config.js";
import { ProfileError, ProfileErrorReason } from "../config/profile-error.js";
import { placementOf } from "../config/placement-overlay.js";
import {
  executionLimitsOverlayOf,
  historyTtlOverlayOf,
} from "../config/workflow-limits-overlay.js";
import { slotsOf } from "../config/workflow-overlay.js";
import type { ChildPlacement } from "../flow/child-placement.js";
import {
  filePolicyMetaOf,
  overlaidFilePolicyMeta,
  filePolicyProblemsOf,
} from "../files/file-policy.js";
import { declaredFilePolicyOf } from "../files/workflow-file-policy.js";
import { withChildWorkflows } from "../flow/analyse/child-workflow.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import type { WorkflowExecutionLimits } from "../flow/decorators/workflow.js";
import type { Milliseconds, Ttl } from "../units/index.js";
import type { ApplicationOptions } from "./application.js";
import { checkAgentUrls, checkChannels, checkListed } from "./option-checks.js";

/**
 * The carrier of the component options (`ComponentOptions`) the selected profiles leave, built once per
 * assembly from the folded profiles and the application's options (#1318c); and the checks that every
 * name a shelf holds is a component the application has, with options that are valid.
 */

const failure = (reason: ProfileErrorReason, message: string): ProfileError =>
  new ProfileError({ reason, message });

/** The workflows of the application, the children they launch included, with their names. */
function workflowsOf(
  options: ApplicationOptions,
): readonly { readonly cls: Class; readonly name: string }[] {
  return withChildWorkflows(options.workflows).flatMap((cls) => {
    const declaration = declarationOf(cls);
    return declaration?.kind === ComponentKind.Workflow
      ? [{ cls, name: declaration.options.name }]
      : [];
  });
}

/** Where each child workflow runs under the profiles, by workflow class; only the workflows a profile places. */
export function placementOverridesOf(
  folded: FoldedConfig,
  workflows: readonly Class[],
): ReadonlyMap<Class, ChildPlacement> {
  const placements = new Map<Class, ChildPlacement>();
  for (const cls of withChildWorkflows(workflows)) {
    const declaration = declarationOf(cls);
    const placement =
      declaration?.kind === ComponentKind.Workflow
        ? placementOf(folded, declaration.options.name)
        : undefined;
    if (placement !== undefined) placements.set(cls, placement);
  }
  return placements;
}

/** What the profiles change of each workflow's `executionLimits` and `historyTtl`, by workflow class; only the workflows they touch. */
function limitOverridesOf(
  folded: FoldedConfig,
  workflows: readonly Class[],
): Pick<OptionSlots, "executionLimits" | "historyTtl"> {
  const executionLimits = new Map<Class, WorkflowExecutionLimits>();
  const historyTtl = new Map<Class, Milliseconds | Ttl>();
  for (const cls of withChildWorkflows(workflows)) {
    const declaration = declarationOf(cls);
    if (declaration?.kind !== ComponentKind.Workflow) continue;
    const { name } = declaration.options;
    const limits = executionLimitsOverlayOf(folded, name);
    if (limits !== undefined) executionLimits.set(cls, limits);
    const ttl = historyTtlOverlayOf(folded, name);
    if (ttl !== undefined) historyTtl.set(cls, ttl);
  }
  return { executionLimits, historyTtl };
}

/** The `@FilePolicy` each workflow gets from a profile in place of its own, by workflow class. */
function filePolicySlotsOf(folded: FoldedConfig, options: ApplicationOptions): Map<Class, Class> {
  const slots = new Map<Class, Class>();
  for (const { cls, name } of workflowsOf(options)) {
    const { filePolicy } = slotsOf(folded, name);
    if (filePolicy !== undefined) slots.set(cls, filePolicy);
  }
  return slots;
}

/** Every file policy the application's files are read under: its workflows' (a slot over the declared) and its skills'. */
function filePoliciesInUse(
  options: ApplicationOptions,
  slots: ReadonlyMap<Class, Class>,
): readonly Class[] {
  const ofWorkflows = workflowsOf(options).flatMap(({ cls }) => {
    const policy = slots.get(cls) ?? declaredFilePolicyOf(cls);
    return policy === undefined ? [] : [policy];
  });
  const ofSkills = (options.endpoints ?? []).flatMap((endpoint) => {
    const meta = componentOf(endpoint);
    return meta?.kind === "a2a-endpoint"
      ? Object.values(skillMapOf(meta.meta)).flatMap((skill) =>
          skill.filePolicy === undefined ? [] : [skill.filePolicy],
        )
      : [];
  });
  return [...new Set([...ofWorkflows, ...ofSkills])];
}

/** A shelf name is a policy of the application, and its overlay leaves a valid policy. */
function checkFilePolicies(folded: FoldedConfig, policies: readonly Class[]): void {
  const metas = policies.flatMap((policy) => filePolicyMetaOf(policy) ?? []);
  const profiles = folded.profiles.join(",");
  for (const [name, overlay] of Object.entries(folded.filePolicies)) {
    const meta = metas.find((one) => one.name === name);
    if (meta === undefined)
      throw failure(
        ProfileErrorReason.Unknown,
        `profile ${profiles}: filePolicies.${name}: no such @FilePolicy in use in the application — it has: ${
          metas.map((one) => one.name).join(", ") || "none"
        }`,
      );
    const [problem] = filePolicyProblemsOf(overlaidFilePolicyMeta(meta, overlay));
    if (problem !== undefined)
      throw failure(
        ProfileErrorReason.Invalid,
        `profile ${profiles}: filePolicies.${name}: ${problem}`,
      );
  }
}

/**
 * The options of the components under the selected profiles, one carrier for the assembly. Every name
 * a shelf holds is checked against the application here, so a typo is a `ProfileError` at assembly;
 * `ComponentOptions.none` when no profile changes a component.
 */
export function optionCarrierOf(
  folded: FoldedConfig,
  options: ApplicationOptions,
): ComponentOptions {
  const filePolicySlots = filePolicySlotsOf(folded, options);
  const placements = placementOverridesOf(folded, options.workflows);
  const limits = limitOverridesOf(folded, options.workflows);
  const shelves = [
    folded.filePolicies,
    folded.channels,
    folded.a2aEndpoints,
    folded.a2aAgents,
    folded.mcpServers,
  ];
  if (
    shelves.every((shelf) => Object.keys(shelf).length === 0) &&
    filePolicySlots.size === 0 &&
    placements.size === 0 &&
    limits.executionLimits?.size === 0 &&
    limits.historyTtl?.size === 0
  )
    return ComponentOptions.none;
  checkFilePolicies(folded, filePoliciesInUse(options, filePolicySlots));
  checkChannels(folded, options);
  checkListed(folded, options);
  checkAgentUrls(folded);
  return new ComponentOptions(
    {
      filePolicies: folded.filePolicies,
      channels: folded.channels,
      a2aEndpoints: folded.a2aEndpoints,
      a2aAgents: folded.a2aAgents,
      mcpServers: folded.mcpServers,
    },
    { filePolicy: filePolicySlots, placement: placements, ...limits },
  );
}
