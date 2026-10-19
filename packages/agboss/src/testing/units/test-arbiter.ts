import type { Class } from "../../components/injection.js";
import { arbiterOf, isCodeArbiter, type ArbiterAnswerOf } from "../../flow/decorators/arbiter.js";
import { declarationOf } from "../../flow/decorators/declaration.js";
import { judgeAnswer } from "../../flow/runtime/launch/arbiters.js";
import { flowArbiterModelFactory } from "../../graph/router-model.js";
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

const nameOfAgent = (agent: Class): string => declarationOf(agent)?.options.name ?? agent.name;

/**
 * An `@Arbiter` on its own (#262 S89, #279): a code arbiter created by its own container (its
 * `deps`, `overrides`, the `environment`) — its `@OnAnswer(Agent)` method gets the answer; a model
 * arbiter asks its own model with the agent's criterion, answering from `model`
 * (`decideWith({ counts: 0.9 })`, `{ cost }` for its spend, `arbiter:<name>`). An arbiter that
 * throws, returns no boolean or whose model does not answer rejects with `ArbiterError` (the
 * original as its cause) — never a rejection, as in a quorum.
 */
export function testArbiter(arbiter: Class, options: UnitModelOptions = {}): ArbiterRunner {
  const declaration = arbiterOf(arbiter);
  if (declaration === undefined)
    throw new TestSetupError(`testArbiter(${arbiter.name}): not an @Arbiter`);
  const { name } = declaration.options;
  const site = new UnitSite(options);
  if (!isCodeArbiter(declaration.options))
    site.scriptModel(arbiterKeyOf(name), arbiter.name, options.model);
  const modelOf = flowArbiterModelFactory(unitRouterDeps(site.gateway));
  const run = <TAgent extends Class>(
    agent: TAgent,
    answer: ArbiterAnswerOf<TAgent>,
    call: UnitCallOptions = {},
  ): Promise<UnitRun<boolean>> => {
    const frame = {
      component: arbiter,
      caller: arbiterKeyOf(name),
      ...callTimeoutOf(call.timeout),
    };
    return site.run(frame, async ({ signal, spent }) => {
      const deps = {
        instanceOf: (cls: Class): unknown => site.instanceOf(cls),
        modelOf,
        beforeModelCall: (): Promise<void> => Promise.resolve(),
        signal,
      };
      const judged = { node: nameOfAgent(agent), answer };
      const verdict = await judgeAnswer([{ arbiters: [arbiter] }], judged, deps);
      spent.push(...verdict.usage);
      return verdict.isAccepted;
    });
  };
  return Object.assign(run, { clock: site.clock });
}
