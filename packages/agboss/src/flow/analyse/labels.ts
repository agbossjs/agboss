import type { Class } from "../../components/injection.js";
import type { DtoClass } from "../../dto/types.js";
import { NodeKind, type PathSource } from "../ast.js";
import {
  Wrapper,
  type HistoryWrapper,
  type OneOfWrapper,
  type OutputShape,
  type ValueShape,
} from "../dto-wrappers.js";

/** How shapes, classes and paths are written in rule messages — the flow's own spelling. */

/** The name of a DTO class: `OfferDraftDto`. */
export const dtoLabel = (dto: DtoClass): string => dto.name || "(anonymous class)";

/** The name of a component class: `ReviewerAgent`. */
export const classLabel = (component: Class): string => component.name || "(anonymous class)";

/** The variant classes of a `oneOf(…)`, sorted by name (the set is what matters). */
export const sortedVariants = (wrapper: OneOfWrapper): readonly DtoClass[] =>
  [...wrapper.variants].sort((first, second) => dtoLabel(first).localeCompare(dtoLabel(second)));

/** A shape as it is written: `XDto`, `listOf(XDto)`, `optional(…)`, `oneOf(A, B)`, `historyOf(X)`. */
export function shapeLabel(shape: ValueShape | OutputShape | HistoryWrapper): string {
  if (typeof shape === "function") return dtoLabel(shape);
  switch (shape.kind) {
    case Wrapper.List:
      return `listOf(${shapeLabel(shape.element)})`;
    case Wrapper.Optional:
      return `optional(${shapeLabel(shape.inner)})`;
    case Wrapper.OneOf:
      return `oneOf(${sortedVariants(shape).map(dtoLabel).join(", ")})`;
    case Wrapper.History:
      return shape.limit === undefined
        ? `historyOf(${dtoLabel(shape.dto)})`
        : `historyOf(${dtoLabel(shape.dto)}, { limit: ${String(shape.limit)} })`;
  }
}

/** The builder call each kind is entered with: `toAgent`, `toRouter`, `toAction`, `toFinish`. */
const TO_CALLS: Readonly<Record<NodeKind, string>> = {
  [NodeKind.Agent]: "toAgent",
  [NodeKind.Router]: "toRouter",
  [NodeKind.Action]: "toAction",
  [NodeKind.Finish]: "toFinish",
  [NodeKind.Workflow]: "toWorkflow",
  [NodeKind.Start]: "start",
};

export const toCallOf = (kind: NodeKind): string => TO_CALLS[kind];

/** The builder call an own path of a kind starts with: `agent`, `router`, `action`, `start`. */
export function sourceCallOf(kind: NodeKind): string {
  return kind === NodeKind.Start ? "start" : kind;
}

/** A path as a message names it: `start(OfferWorkflowStart)`, `agent(ReviewerAgent)`. */
/** `{ about: PlanDto }`, `{ about: [PlanDto, BudgetDto] }` — as the flow writes it (#299). */
export function aboutLabel(about: readonly DtoClass[]): string {
  const [one] = about;
  const targets =
    about.length === 1 && one !== undefined ? dtoLabel(one) : `[${about.map(dtoLabel).join(", ")}]`;
  return `{ about: ${targets} }`;
}

export const pathLabel = (source: PathSource): string =>
  `${sourceCallOf(source.kind)}(${classLabel(source.node)})`;
