import type { WorkflowServices } from "../workflow.js";
import { ArbiterModel } from "../flow/decorators/arbiter.js";
import { LiveArbiterModel } from "../flow/runtime/launch/arbiter-live.js";
import { DependantValue } from "./container/container.js";
import { DecisionModel, LiveDecisionModel } from "./decision-model.js";
import { LiveJudgeModel } from "./judge-call.js";
import { JudgeModel } from "./judge-decorators.js";
import type { Token } from "./injection.js";
import { LiveSpendRecorder, SpendRecorder } from "./spend-recorder.js";

/**
 * The core services a component asks for by class, each made for its consumer (`DependantValue`):
 * `deps: [JudgeModel]` the model of the judge that is judging (#280), `[ArbiterModel]` of the arbiter
 * (#1283), `[SpendRecorder]` what a tool or an action paid a service (S43), `[DecisionModel]` a
 * decision of a decisions model, charged to the step (#1313).
 */
export const liveCoreValuesOf = (
  services: Pick<WorkflowServices, "decide">,
): [Token, unknown][] => [
  [JudgeModel, new DependantValue((dependant) => new LiveJudgeModel(dependant))],
  [ArbiterModel, new DependantValue((dependant) => new LiveArbiterModel(dependant))],
  [SpendRecorder, new DependantValue((dependant) => new LiveSpendRecorder(dependant))],
  [
    DecisionModel,
    new DependantValue((dependant) => new LiveDecisionModel(dependant, services.decide)),
  ],
];
