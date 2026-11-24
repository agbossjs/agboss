import { cycleText, dtoCycleOf } from "../../../dto/cycles.js";
import type { DtoClass } from "../../../dto/types.js";
import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import type { AnalysisContext } from "./context.js";
import { declaredDtos } from "./names.js";

/**
 * A DTO that holds itself through `@Nested` or `@List`, directly or via other DTOs, has no finite
 * JSON Schema for a model and no finite value of its own: `[dto.cyclic]` names the component and
 * the cycle (`A → B → A`) at start, instead of a stack overflow while a schema is built (#1080).
 * A DTO used twice (a diamond) is not a cycle.
 */

const advice = "a DTO cannot reference itself — break the cycle (an id field, or a flat list)";

const message = (subject: string, cycle: readonly DtoClass[]): string =>
  `${subject}: ${cycleText(cycle)} — ${advice}`;

/** The cycles below some DTOs, one per cycle (the same loop met from two DTOs counts once). */
function cyclesOf(dtos: readonly DtoClass[]): (readonly DtoClass[])[] {
  const found = new Map<string, readonly DtoClass[]>();
  for (const dto of dtos) {
    const cycle = dtoCycleOf(dto);
    if (cycle === undefined) continue;
    const members = cycle.slice(1);
    const key = members
      .map((member) => member.name)
      .sort()
      .join(",");
    if (!found.has(key)) found.set(key, cycle);
  }
  return [...found.values()];
}

export function dtoCycleRules(context: AnalysisContext): readonly RuleViolation[] {
  // an output or `caseOf(…)` DTO must be some node's output, so the nodes cover every DTO
  return [...context.graph.nodes.values()].flatMap((node) =>
    cyclesOf(declaredDtos(node.declaration)).map((cycle) =>
      violation("dto.cyclic", message(node.name, cycle), [node.name]),
    ),
  );
}
