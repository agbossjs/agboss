import type { ExecutionContext } from "../../flow/context/execution-context.js";
import type { TenantContext } from "../../flow/context/tenant-context.js";
import type { Class } from "../../components/injection.js";
import { NodeKind } from "../../flow/ast.js";
import { declarationOf } from "../../flow/decorators/declaration.js";
import {
  isCodeRouter,
  type CodeRouterOptions,
  type ModelRouterOptions,
} from "../../flow/decorators/router.js";
import type { RouterAnswerOf } from "../../flow/generated-types.js";
import type { ModelRouterDeclaration } from "../../flow/runtime/routers.js";
import { TestSetupError } from "../errors.js";
import type { RecordedInputOf } from "../script-types.js";
import { routerKeyOf } from "../scripted-gateway.js";
import { checkedCodeAnswer, modelDecision } from "./router-unit.js";
import { callTimeoutOf, UnitSite } from "./unit-site.js";
import type { UnitCallOptions, UnitClock, UnitModelOptions, UnitRun } from "./unit-types.js";

/** One router deciding: `await runRouter({ message })` → `{ output: SupportAgent, spend }`. */
export interface RouterRunner<TInput, TOutput> extends UnitClock {
  (input: TInput, options?: UnitCallOptions): Promise<UnitRun<TOutput>>;
}

/** A code router's instance as the runner calls it. */
interface RoutingInstance {
  route(input: unknown): unknown;
}

/** A router of either kind, as the runner decides with it. */
type UnitRouter =
  | { readonly options: CodeRouterOptions; readonly model?: never }
  | { readonly options: ModelRouterOptions; readonly model: ModelRouterDeclaration };

function routerOf(router: Class): UnitRouter {
  const declaration = declarationOf(router);
  if (declaration?.kind !== NodeKind.Router)
    throw new TestSetupError(`testRouter(${router.name}): not a @Router`);
  const { options } = declaration;
  return isCodeRouter(options) ? { options } : { options, model: { ...declaration, options } };
}

/**
 * A `@Router` on its own (#262 S89): its input is what its step reads — its fields as plain
 * `{ producer, value }` objects — and its output what it chose, checked as its step checks it (a
 * target outside its routes is `RouterDecisionError`). A code router (`DecidedBy.Code`) is created
 * by its own container (`deps`, `overrides`, the `environment`) and its `route(input)` runs in the
 * frame of its step, at no cost; a model router's texts are loaded and its model answers from
 * `model` — `routeTo(X)` after `.chooseOne(…)`, `decideWith(…)` / `routeTo(…)` for the `OnDemand`
 * routes of a launch — its spend as `router:<name>`.
 */
export function testRouter<
  TRouter extends Class,
  TExecution extends ExecutionContext = ExecutionContext,
  TTenant extends TenantContext = TenantContext,
>(
  router: TRouter,
  options: UnitModelOptions<InstanceType<TRouter>, TExecution, TTenant> = {},
): RouterRunner<RecordedInputOf<InstanceType<TRouter>>, RouterAnswerOf<InstanceType<TRouter>>> {
  const unit = routerOf(router);
  const declared = unit.options;
  const site = new UnitSite(options);
  if (unit.model !== undefined)
    site.scriptModel(routerKeyOf(declared.name), router.name, options.model);
  const run = (
    input: RecordedInputOf<InstanceType<TRouter>>,
    call: UnitCallOptions = {},
  ): Promise<UnitRun<RouterAnswerOf<InstanceType<TRouter>>>> => {
    const caller = routerKeyOf(declared.name);
    const frame = { component: router, caller, ...callTimeoutOf(call.timeout) };
    return site.run(frame, async ({ spent }) => {
      if (unit.model === undefined) {
        // the container creates the class itself: a code router, `route` included
        const instance = site.instanceOf(router) as RoutingInstance;
        const answer: unknown = await instance.route(input);
        return checkedCodeAnswer(declared, answer) as RouterAnswerOf<InstanceType<TRouter>>;
      }
      const decided = await modelDecision(site, unit.model, input);
      spent.push(...decided.usage);
      // the answer checked against its routes: what the generated `RouterAnswerOf<R>` names
      const answer: unknown = decided.answer;
      return answer as RouterAnswerOf<InstanceType<TRouter>>;
    });
  };
  return Object.assign(run, { clock: site.clock });
}
