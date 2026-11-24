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
import { ROUTER_FACTORY } from "../../components/runtime.js";
import { LiveSpendRecorder, SpendRecorder } from "../../components/spend-recorder.js";
import type { RuntimeContexts } from "../../flow/context/runtime-contexts.js";
import { Clock, StoreClock, StoreTimeSource } from "../../infrastructure/clock.js";
import type { ModelGateway } from "../../llm/gateway.js";
import { replacementsOf } from "./override.js";
import { bindUnitRag } from "./unit-rag.js";
import type { UnitFencedEffects } from "./unit-fenced-effects.js";
import type { UnitOptions } from "./unit-types.js";

/** What a unit runner's container is made of: the core values a component may depend on, the overrides. */
const noRouterFactory = new UnavailableValue(
  (dependant) =>
    `${dependant} injects ROUTER_FACTORY, which a unit runner does not have — override the class that uses it`,
);

export function unitContainer(
  clock: Clock,
  contexts: RuntimeContexts,
  options: UnitOptions,
  fencedEffects: UnitFencedEffects,
  gateway: () => ModelGateway,
): Container {
  const core = new Map<Token, unknown>([
    ...fencedEffects.core,
    [ROUTER_FACTORY, noRouterFactory],
    ...contextValuesOf(contexts),
    [JudgeModel, new DependantValue((dependant) => new LiveJudgeModel(dependant))],
    [SpendRecorder, new DependantValue((dependant) => new LiveSpendRecorder(dependant))],
    [Clock, clock],
    // the runner's stores decide by its clock (#533)
    [StoreClock, new StoreClock(StoreTimeSource.Test, clock)],
  ]);
  const container: Container = createContainer(
    { modules: [], core, defaults: fencedEffects.defaults },
    {
      replacements: replacementsOf(options.overrides),
      onCreate: (instance) => {
        fencedEffects.onCreate(instance);
        // a `@Rag` source gets its pipeline: the scope, the reranker and the spend of an application
        bindUnitRag(instance, contexts, container, gateway);
      },
    },
  );
  return container;
}
