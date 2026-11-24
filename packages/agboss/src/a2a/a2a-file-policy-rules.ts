import type { ApplicationOptions } from "../application/application.js";
import type { ComponentOptions } from "../components/component-options.js";
import type { Class } from "../components/injection.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import { NodeKind } from "../flow/ast.js";
import { flowClassesOf, withChildWorkflows } from "../flow/analyse/child-workflow.js";
import { listItemClassesOf, plainOutputClassOf } from "../flow/finish-output.js";
import { fileFieldsOf, inputClassOf } from "../dto/standard/file.js";
import { filePolicyExcesses, filePolicyViolations } from "../files/file-policy.js";
import { workflowOfStart } from "../files/workflow-file-policy.js";

/**
 * The file policy rules of an application (#1316), read through the carrier of the components' options
 * so a profile's policy is the one checked: a skill's `filePolicy` only tightens its workflow's
 * (`[a2a.skill-file-policy-exceeds-workflow]`), and a workflow that handles files names one
 * (`[workflow.file-policy-required]`).
 */

/** A skill's `filePolicy`, checked, and `[a2a.skill-file-policy-exceeds-workflow]`: it only tightens its workflow's. */
export function skillPolicyViolations(
  expose: string,
  skill: string,
  policy: Class | undefined,
  start: Class | undefined,
  workflows: readonly Class[],
  options: ComponentOptions,
): RuleViolation[] {
  if (policy === undefined) return [];
  const own = filePolicyViolations(
    `${expose}'s skill ${skill} filePolicy`,
    policy,
    [expose],
    options.filePolicyMetaOf,
  );
  if (own.length > 0) return own;
  // a skill whose start is not among the exports cannot be compared: said, never skipped
  if (start === undefined)
    return [
      violation(
        "a2a.skill-file-policy-exceeds-workflow",
        `${expose}'s skill ${skill} sets a filePolicy, but no exported start is named ${skill}: it cannot be checked against its workflow's`,
        [expose],
      ),
    ];
  const excesses = filePolicyExcesses(
    options.workflowFilePolicy(workflowOfStart(start, workflows)),
    policy,
    options.filePolicyMetaOf,
  );
  return excesses.map((excess) =>
    violation(
      "a2a.skill-file-policy-exceeds-workflow",
      `${expose}'s skill ${skill} filePolicy sets more than its workflow's: ${excess}`,
      [expose],
    ),
  );
}

/** Whether a node of a flow takes or gives files: a start's input or a finish's output with a `FileDto` field, an agent with `files`. */
function nodeUsesFiles(node: Class): boolean {
  const declaration = declarationOf(node);
  if (declaration?.kind === NodeKind.Agent) return declaration.options.files !== undefined;
  if (declaration?.kind === NodeKind.Start) {
    const input = inputClassOf(declaration.options.input);
    return input !== undefined && fileFieldsOf(input).length > 0;
  }
  if (declaration?.kind === NodeKind.Finish) {
    const output = plainOutputClassOf(declaration.options.output);
    const items = listItemClassesOf(declaration.options.output);
    return [...(output === undefined ? [] : [output]), ...items].some(
      (dto) => fileFieldsOf(dto).length > 0,
    );
  }
  return false;
}

/** `[workflow.file-policy-required]`: a workflow that takes, gives or reads files names its `filePolicy`. */
export function policyRequiredViolations(
  options: ApplicationOptions,
  carrier: ComponentOptions,
): RuleViolation[] {
  return withChildWorkflows(options.workflows).flatMap((workflow) => {
    const declaration = declarationOf(workflow);
    if (
      declaration?.kind !== NodeKind.Workflow ||
      carrier.workflowFilePolicy(workflow) !== undefined
    )
      return [];
    if (!flowClassesOf(declaration.options.flow).some(nodeUsesFiles)) return [];
    return [
      violation(
        "workflow.file-policy-required",
        `${declaration.options.name} takes, gives or reads files (a FileDto field, an agent's files) but names no filePolicy — add @FilePolicy({ … }) and filePolicy: X to @Workflow`,
        [options.name],
      ),
    ];
  });
}

/** `[file-policy.invalid]` and `[file-policy.ttl-required-on-workflow]` of every workflow's policy, as the profiles leave it. */
export function workflowPolicyViolations(
  options: ApplicationOptions,
  carrier: ComponentOptions,
): RuleViolation[] {
  return options.workflows.flatMap((workflow) => {
    const policy = carrier.workflowFilePolicy(workflow);
    const name = declarationOf(workflow)?.options.name ?? workflow.name;
    const meta = policy === undefined ? undefined : carrier.filePolicyMetaOf(policy);
    // a workflow's files are kept for as long as its policy says: no default to forget (#1316)
    const unset =
      meta !== undefined && meta.ttl === undefined
        ? [
            violation(
              "file-policy.ttl-required-on-workflow",
              `${name}'s filePolicy ${meta.name} sets no ttl — a workflow says how long its files are kept: ttl: hours(24), or Ttl.Forever`,
              [options.name],
            ),
          ]
        : [];
    return [
      ...filePolicyViolations(
        `${name}'s filePolicy`,
        policy,
        [options.name],
        carrier.filePolicyMetaOf,
      ),
      ...unset,
    ];
  });
}
