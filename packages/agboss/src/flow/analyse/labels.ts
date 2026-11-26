import type { FlowNodeKind, PathSource } from "../ast.js";
import { ComponentKind } from "../runtime/records.js";
import type { Class } from "../../components/injection.js";
import type { DtoClass } from "../../dto/types.js";
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
      return shape.maxPrevious === undefined
        ? `historyOf(${dtoLabel(shape.dto)})`
        : `historyOf(${dtoLabel(shape.dto)}, { maxPrevious: ${String(shape.maxPrevious)} })`;
  }
}

/** The builder call each kind is entered with: `toAgent`, `toRouter`, `toAction`, `toFinish`. */
const TO_CALLS: Readonly<Record<FlowNodeKind, string>> = {
  [ComponentKind.Agent]: "toAgent",
  [ComponentKind.Router]: "toRouter",
  [ComponentKind.Action]: "toAction",
  [ComponentKind.WorkflowFinish]: "toFinish",
  [ComponentKind.Workflow]: "toWorkflow",
  [ComponentKind.ExternalTask]: "toExternalTask",
  [ComponentKind.WorkflowStart]: "onStart",
};

export const toCallOf = (kind: FlowNodeKind): string => TO_CALLS[kind];

/** The builder call an own path of a kind starts with: `onAgent`, `onRouter`, `onAction`, `onStart`. */
const SOURCE_CALLS: Readonly<Record<FlowNodeKind, string>> = {
  [ComponentKind.Agent]: "onAgent",
  [ComponentKind.Router]: "onRouter",
  [ComponentKind.Action]: "onAction",
  [ComponentKind.WorkflowFinish]: "toFinish",
  [ComponentKind.Workflow]: "onWorkflow",
  [ComponentKind.ExternalTask]: "onExternalTask",
  [ComponentKind.WorkflowStart]: "onStart",
};

export const sourceCallOf = (kind: FlowNodeKind): string => SOURCE_CALLS[kind];

/** A path as a message names it: `onStart(OfferWorkflowStart)`, `onAgent(ReviewerAgent)`. */
export const pathLabel = (source: PathSource): string =>
  `${sourceCallOf(source.kind)}(${classLabel(source.node)})`;
