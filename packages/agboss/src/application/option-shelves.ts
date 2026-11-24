import { ComponentOptions } from "../components/component-options.js";
import type { Class } from "../components/injection.js";
import { componentOf } from "../components/metadata.js";
import { skillMapOf } from "../a2a/a2a-endpoint.decorator.js";
import type { FoldedConfig } from "../config/fold-config.js";
import { ProfileError, ProfileErrorReason } from "../config/profile-error.js";
import { slotsOf } from "../config/workflow-overlay.js";
import {
  filePolicyMetaOf,
  overlaidFilePolicyMeta,
  filePolicyProblemsOf,
} from "../files/file-policy.js";
import { declaredFilePolicyOf } from "../files/workflow-file-policy.js";
import { withChildWorkflows } from "../flow/analyse/child-workflow.js";
import { NodeKind } from "../flow/ast.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import type { ApplicationOptions } from "./application.js";

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
    return declaration?.kind === NodeKind.Workflow ? [{ cls, name: declaration.options.name }] : [];
  });
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
        `profile ${profiles}: filePolicies.${name}: no such @FilePolicy in use in the application — it has: ${metas.map((one) => one.name).join(", ") || "none"}`,
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
  const hasShelves = Object.keys(folded.filePolicies).length > 0;
  if (!hasShelves && filePolicySlots.size === 0) return ComponentOptions.none;
  checkFilePolicies(folded, filePoliciesInUse(options, filePolicySlots));
  return new ComponentOptions(
    { filePolicies: folded.filePolicies },
    { filePolicy: filePolicySlots },
  );
}
