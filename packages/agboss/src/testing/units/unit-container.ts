import {
  createContainer,
  DependantValue,
  UnavailableValue,
  type Container,
} from "../../components/container/container.js";
import { contextValuesOf } from "../../components/context-tokens.js";
import type { Token } from "../../components/injection.js";
import { JudgeModel } from "../../components/judge-decorators.js";
import { LiveJudgeModel } from "../../components/judge-call.js";
import { ArbiterModel } from "../../flow/decorators/arbiter.js";
import { LiveArbiterModel } from "../../flow/runtime/launch/arbiter-live.js";
import { DecisionModel } from "../../components/decision-model.js";
import { ROUTER_FACTORY } from "../../components/runtime.js";
import { LiveSpendRecorder, SpendRecorder } from "../../components/spend-recorder.js";
import type { RuntimeContexts } from "../../flow/context/runtime-contexts.js";
import { Clock, StoreClock, StoreTimeSource } from "../../infrastructure/clock.js";
import type { ModelGateway } from "../../llm/gateway.js";
import { bindingsOf } from "../services.js";
import { bindUnitRag } from "./unit-rag.js";
import type { UnitFencedEffects } from "./unit-fenced-effects.js";
import type { UnitOptions } from "./unit-types.js";

/** What a unit runner's container is made of: the core values a component may depend on, the test's `services`. */
const noRouterFactory = new UnavailableValue(
  (dependant) =>
    `${dependant} injects ROUTER_FACTORY, which a unit runner does not have — override the class that uses it`,
);

const noDecisionModel = new UnavailableValue(
  (dependant) =>
    `${dependant} injects DecisionModel, which a unit runner does not have — override the class that uses it`,
);

/** What a runner adds to its container: values in place of classes (mocks), a list of what it created. */
export interface UnitContainerExtras {
  readonly values?: ReadonlyMap<Token, unknown>;
  readonly created?: unknown[];
}

export function unitContainer(
  clock: Clock,
  contexts: RuntimeContexts,
  options: UnitOptions,
  fencedEffects: UnitFencedEffects,
  gateway: () => ModelGateway,
  extra: UnitContainerExtras = {},
): Container {
  const core = new Map<Token, unknown>([
    ...fencedEffects.core,
    [ROUTER_FACTORY, noRouterFactory],
    [DecisionModel, noDecisionModel],
    ...contextValuesOf(contexts),
    [JudgeModel, new DependantValue((dependant) => new LiveJudgeModel(dependant))],
    [ArbiterModel, new DependantValue((dependant) => new LiveArbiterModel(dependant))],
    [SpendRecorder, new DependantValue((dependant) => new LiveSpendRecorder(dependant))],
    [Clock, clock],
    // the runner's stores decide by its clock (#533)
    [StoreClock, new StoreClock(StoreTimeSource.Test, clock)],
  ]);
  const { replacements, values } = bindingsOf(options.services);
  const container: Container = createContainer(
    { modules: [], core, defaults: fencedEffects.defaults },
    {
      replacements,
      overrides: new Map([...values, ...(extra.values ?? [])]),
      onCreate: (instance) => {
        extra.created?.push(instance);
        fencedEffects.onCreate(instance);
        // a `@Rag` source gets its pipeline: the scope, the reranker and the spend of an application
        bindUnitRag(instance, contexts, container, gateway);
      },
    },
  );
  return container;
}
