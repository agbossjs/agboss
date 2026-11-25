import type { ErrorDetails } from "../core/error-options.js";
import { currentFrame } from "../flow/context/frame.js";
import { ComponentKind, type ComponentRecord } from "../flow/runtime/records.js";
import { bareRecordOf, plainRecordOf } from "../flow/runtime/records.js";

/** Which step an error belongs to (#273 S22): its component, node id, visit and item. */
export interface StepCoordinates {
  /** The step's component, by `name`. */
  readonly component: ComponentRecord;
  /** The node id in `result.path`: the component's `name` (`critic-agent#2` for a copy, #273). */
  readonly nodeId: string;
  /** The pass through the node in the execution, from 1; `0` for an error made outside any step. */
  readonly visitNumber: number;
  /** The item's index in a per-item launch (#273), from 0. */
  readonly itemIndex?: number;
}

/**
 * The coordinates of the step running now (its frame, #280); outside any step — a unit run on its
 * own — those of `name` (a `kind`) at visit 0.
 */
export function stepCoordinatesOf(name: string, kind: ComponentKind): StepCoordinates {
  const frame = currentFrame();
  if (frame === undefined || frame.isClosed())
    return { component: bareRecordOf(name, kind), nodeId: name, visitNumber: 0 };
  const { step } = frame;
  return {
    component: plainRecordOf(step.component),
    nodeId: step.nodeId,
    visitNumber: step.visitNumber,
    ...(step.itemIndex === undefined ? {} : { itemIndex: step.itemIndex }),
  };
}

/** The step's own facts a step error's record keeps in its `details`. */
export const detailsOfStep = (step: StepCoordinates): ErrorDetails => ({
  component: plainRecordOf(step.component),
  nodeId: step.nodeId,
  visitNumber: step.visitNumber,
  ...(step.itemIndex === undefined ? {} : { itemIndex: step.itemIndex }),
});

/** One judge's rejection of an agent's reply: the judge and its verdict's `reason`. */
export interface JudgeRejection {
  readonly judge: string;
  readonly reason: string;
}
