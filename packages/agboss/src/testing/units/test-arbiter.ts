import type { ExecutionContext } from "../../flow/context/execution-context.js";
import type { TenantContext } from "../../flow/context/tenant-context.js";
import type { Class } from "../../components/injection.js";
import { arbiterOf, hasArbiterModel, type ArbiterAnswerOf } from "../../flow/decorators/arbiter.js";
import { declarationOf } from "../../flow/decorators/declaration.js";
import { judgeAnswer } from "../../flow/runtime/launch/arbiters.js";
import { unitArbiterUsesOf } from "../../flow/runtime/launch/arbiter-prompts.js";
import { flowArbiterModelFactory } from "../../graph/router-model.js";
import type { UsageRecord } from "../../finops/usage.js";
import { TestSetupError } from "../errors.js";
import { arbiterKeyOf } from "../scripted-gateway.js";
import { callTimeoutOf, UnitSite } from "./unit-site.js";
import { unitRouterDeps } from "./unit-models.js";
import type { UnitCallOptions, UnitClock, UnitModelOptions, UnitRun } from "./unit-types.js";

/**
 * One arbiter on one answer: `await runArbiter(SkillsScoreAgent, { score: 8 })` →
 * `{ output: true, spend }` — whether the answer counts.
 */
export interface ArbiterRunner extends UnitClock {
  <TAgent extends Class>(
    agent: TAgent,
    answer: ArbiterAnswerOf<TAgent>,
    options?: UnitCallOptions,
  ): Promise<UnitRun<boolean>>;
}

const nameOfTarget = (target: Class): string => declarationOf(target)?.options.name ?? target.name;

/**
 * An `@Arbiter` on its own (#262 S89, #279): a code arbiter created by its own container (its
 * `deps`, `overrides`, the `environment`) — its `@Arbitrate(Target)` method gets the answer, tracked
 * as given by the target; one that injects `ArbiterModel` asks its model, answering from `model`
 * like a declarative arbiter, which asks its own model with the target's criterion
 * (`decideWith({ counts: 0.9 })`, `{ cost }` for its spend, `arbiter:<name>`). An arbiter that
 * throws, returns no boolean or whose model does not answer rejects with `ArbiterError` (the
 * original as its cause) — never a rejection, as in a quorum.
 */
export function arbiterUnit<
  TExecution extends ExecutionContext = ExecutionContext,
  TTenant extends TenantContext = TenantContext,
>(arbiter: Class, options: UnitModelOptions<unknown, TExecution, TTenant> = {}): ArbiterRunner {
  const declaration = arbiterOf(arbiter);
  if (declaration === undefined)
    throw new TestSetupError({ message: `testUnit(${arbiter.name}): not an @Arbiter` });
  const { name } = declaration.options;
  const site = new UnitSite(options);
  if (hasArbiterModel(declaration.options))
    site.scriptModel(arbiterKeyOf(name), arbiter.name, options.model);
  const routerDeps = unitRouterDeps(site.gateway);
  const run = <TTarget extends Class>(
    target: TTarget,
    answer: ArbiterAnswerOf<TTarget>,
    call: UnitCallOptions = {},
  ): Promise<UnitRun<boolean>> => {
    const frame = {
      component: arbiter,
      caller: arbiterKeyOf(name),
      ...callTimeoutOf(call.timeout),
    };
    return site.run(frame, async ({ signal, spent }) => {
      // a declarative arbiter's prompt, read as at assembly (#1347)
      const modelOf = flowArbiterModelFactory(routerDeps, await unitArbiterUsesOf(arbiter));
      const deps = {
        instanceOf: (cls: Class): unknown => site.instanceOf(cls),
        modelOf,
        beforeModelCall: (): Promise<void> => Promise.resolve(),
        keepSpend: (usage: readonly UsageRecord[]): void => {
          spent.push(...usage);
        },
        signal,
      };
      const judged = { node: nameOfTarget(target), answer };
      const verdict = await judgeAnswer(arbiter, judged, deps);
      spent.push(...verdict.usage);
      return verdict.isAccepted;
    });
  };
  return Object.assign(run, { clock: site.clock });
}
