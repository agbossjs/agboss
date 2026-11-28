import { ComponentKind } from "../../flow/runtime/records.js";
import type { Class } from "../../components/injection.js";
import { componentOf } from "../../components/metadata.js";
import { workflowPartsOf } from "../../describe/contracts-parts.js";
import type { DtoClass } from "../../dto/types.js";
import { declarationOf } from "../../flow/decorators/declaration.js";
import { listItemClassesOf, plainOutputClassOf } from "../../flow/finish-output.js";
import { fileFieldsOf, inputClassOf } from "../../dto/standard/file.js";
import { workflowOfStart } from "../../files/workflow-file-policy.js";
import type { ComponentOptions } from "../../components/component-options.js";
import { skillOptionsOf, startsOfEndpoint } from "../a2a-endpoint.decorator.js";

/**
 * How many bytes of files an application's A2A skills may keep at once (#859), read from the
 * declarations: of each exported start whose input holds files, its `maxTotalFileSize`; of each
 * whose finish holds files, its `maxFileSize` (what a step saves). What the storage tiers are
 * decided by: up to 64 KB inline in the task's records, up to 256 KB inline with a warning, above
 * it a file store.
 */

/** The output DTO of each finish of the workflow a start opens, by the finish's name. */
export function finishDtosOf(
  start: Class,
  workflows: readonly Class[],
): ReadonlyMap<string, DtoClass> {
  const part = workflowPartsOf(workflows).find((each) => each.nodes.includes(start));
  // Stryker disable next-line ArrayDeclaration: equivalent: the start is one of the nodes of the part found for it
  const entries = (part?.nodes ?? []).flatMap((node): [string, DtoClass][] => {
    const finish = declarationOf(node);
    // Stryker disable next-line OptionalChaining: equivalent: every node of a flow has a declaration
    if (finish?.kind !== ComponentKind.WorkflowFinish) return [];
    // a list output has no top-level fields of its own: its item classes are `listFinishItemsOf`
    const dto = plainOutputClassOf(finish.options.output);
    return dto === undefined ? [] : [[finish.options.name, dto]];
  });
  return new Map(entries);
}

/** The item classes of each list-output finish of the workflow a start opens, by the finish's name. */
export function listFinishItemsOf(
  start: Class,
  workflows: readonly Class[],
): ReadonlyMap<string, readonly DtoClass[]> {
  const part = workflowPartsOf(workflows).find((each) => each.nodes.includes(start));
  // Stryker disable next-line ArrayDeclaration: equivalent: the start is one of the nodes of the part found for it
  const entries = (part?.nodes ?? []).flatMap((node): [string, readonly DtoClass[]][] => {
    const finish = declarationOf(node);
    // Stryker disable next-line OptionalChaining: equivalent: every node of a flow has a declaration
    if (finish?.kind !== ComponentKind.WorkflowFinish) return [];
    const items = listItemClassesOf(finish.options.output);
    return items.length === 0 ? [] : [[finish.options.name, items]];
  });
  return new Map(entries);
}

/** The bytes one exported start may keep as files; 0 for a start without. */
function startSizeOf(
  declaration: NonNullable<ReturnType<typeof declarationOf>>,
  start: Class,
  workflows: readonly Class[],
  limits: ReturnType<ComponentOptions["fileLimits"]>,
): number {
  if (declaration.kind !== ComponentKind.WorkflowStart) return 0;
  const input = inputClassOf(declaration.options.input);
  const takes = input !== undefined && fileFieldsOf(input).length > 0;
  const gives = [...finishDtosOf(start, workflows).values()].some(
    (dto) => fileFieldsOf(dto).length > 0,
  );
  return Math.max(takes ? limits.maxTotalFileSize : 0, gives ? limits.maxFileSize : 0);
}

/** The most bytes of files any exported skill keeps: what the storage tier is chosen by. */
export function fileTierSizeOf(
  endpoints: readonly Class[],
  workflows: readonly Class[],
  options: ComponentOptions,
): number {
  const sizes = endpoints.flatMap((expose) => {
    const meta = componentOf(expose);
    if (meta?.kind !== "a2a-endpoint") return [];
    return startsOfEndpoint(meta.meta).map((start) => {
      const declaration = declarationOf(start);
      if (declaration === undefined) return 0;
      const limits = options.workflowFileLimits(
        workflowOfStart(start, workflows),
        skillOptionsOf(meta.meta, declaration.options.name)?.filePolicy,
      );
      return startSizeOf(declaration, start, workflows, limits);
    });
  });
  return Math.max(0, ...sizes);
}
