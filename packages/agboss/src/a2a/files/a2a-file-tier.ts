import type { Class } from "../../components/injection.js";
import { componentOf } from "../../components/metadata.js";
import { workflowPartsOf } from "../../describe/contracts-parts.js";
import type { DtoClass } from "../../dto/types.js";
import { NodeKind } from "../../flow/ast.js";
import { declarationOf } from "../../flow/decorators/declaration.js";
import { fileFieldsOf } from "./a2a-file.dto.js";
import { fileLimitsOf, type A2AFileOptions } from "./a2a-file-options.js";

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
  const entries = (part?.nodes ?? []).flatMap((node): [string, DtoClass][] => {
    const finish = declarationOf(node);
    if (finish?.kind !== NodeKind.Finish || typeof finish.options.output !== "function") return [];
    return [[finish.options.name, finish.options.output]];
  });
  return new Map(entries);
}

/** The bytes one exported start may keep as files; 0 for a start without. */
function startSizeOf(
  start: Class,
  workflows: readonly Class[],
  limits: ReturnType<typeof fileLimitsOf>,
): number {
  const declaration = declarationOf(start);
  if (declaration?.kind !== NodeKind.Start) return 0;
  const { input } = declaration.options;
  const takes = typeof input === "function" && fileFieldsOf(input).length > 0;
  const gives = [...finishDtosOf(start, workflows).values()].some(
    (dto) => fileFieldsOf(dto).length > 0,
  );
  return Math.max(takes ? limits.maxTotalFileSize : 0, gives ? limits.maxFileSize : 0);
}

/** The most bytes of files any exported skill keeps: what the storage tier is chosen by. */
export function fileTierSizeOf(
  exposes: readonly Class[],
  workflows: readonly Class[],
  application: A2AFileOptions | undefined,
): number {
  const sizes = exposes.flatMap((expose) => {
    const meta = componentOf(expose);
    if (meta?.kind !== "a2a-expose") return [];
    return meta.meta.exports.map((start) => {
      const name = declarationOf(start)?.options.name ?? "";
      const limits = fileLimitsOf(application, meta.meta.skills?.[name]?.files);
      return startSizeOf(start, workflows, limits);
    });
  });
  return Math.max(0, ...sizes);
}
