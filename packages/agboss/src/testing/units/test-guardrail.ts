import type { ExecutionContext } from "../../flow/context/execution-context.js";
import type { TenantContext } from "../../flow/context/tenant-context.js";
import type { Class } from "../../components/injection.js";
import { guardrailMetaOf, type GuardrailMeta } from "../../components/policy-decorators.js";
import { PromptLoader } from "../../components/prompt-render.js";
import { routerModelOf } from "../../graph/router-model.js";
import { throwIfViolated } from "../../graph/rule-error.js";
import type { LoadedGuardrail } from "../../guardrails/assembly.js";
import { guardrailViolations } from "../../guardrails/checks.js";
import { checkGuardrail, runtimeGuardrailOf } from "../../guardrails/runtime.js";
import type { UsageRecord } from "../../finops/usage.js";
import { TestSetupError } from "../errors.js";
import { guardrailKeyOf } from "../scripted-gateway.js";
import { callTimeoutOf, UnitSite } from "./unit-site.js";
import { UNIT_DECISION_MODEL, unitRouterDeps } from "./unit-models.js";
import type { UnitCallOptions, UnitClock, UnitModelOptions, UnitRun } from "./unit-types.js";

/** What a guardrail decided on a text: whether it blocks, how sure its model was, the refusal. */
export interface GuardrailCheck {
  readonly isBlocked: boolean;
  /** P(yes) of its question. */
  readonly probability: number;
  /** The text sent instead — only when it blocks: the decorator's, or the class's `refusal()`. */
  readonly refusal?: string;
}

/** What one check takes besides the text: the agent or router whose model it guards. */
export interface GuardrailCallOptions extends UnitCallOptions {
  /** The element's name in its heading (`### message (to support-agent)`); default `test-agent`. */
  readonly element?: string;
}

/** One guardrail on one text: `await check("Can I sue my landlord?")` → `{ output, spend }`. */
export interface GuardrailRunner extends UnitClock {
  (text: string, options?: GuardrailCallOptions): Promise<UnitRun<GuardrailCheck>>;
}

/** The guardrail's record, its rules checked (`-guardrail`, one refusal, a question, a threshold). */
function checkedMetaOf(guardrail: Class): GuardrailMeta {
  const meta = guardrailMetaOf(guardrail);
  if (meta === undefined)
    throw new TestSetupError(
      `testGuardrail(${guardrail.name}): not an @InputGuardrail / @OutputGuardrail`,
    );
  throwIfViolated(guardrailViolations([guardrail], UNIT_DECISION_MODEL));
  return meta;
}

/** The guardrail as an element that lists it runs it: its question read, its model resolved. */
async function loadedOf(guardrail: Class, meta: GuardrailMeta): Promise<LoadedGuardrail> {
  // a guardrail without its own model decides on a decision model, as defaults.guardrail.model does
  const model = meta.model ?? UNIT_DECISION_MODEL;
  const loader = new PromptLoader();
  const prompt = await loader.load({ label: meta.name, options: meta, source: meta.source });
  loader.throwIfAny();
  return {
    type: guardrail,
    name: meta.name,
    description: meta.description,
    side: meta.side,
    prompt,
    threshold: meta.threshold,
    model,
    isOwnModel: meta.model !== undefined,
    ...(meta.refusal === undefined ? {} : { refusal: meta.refusal }),
  };
}

/**
 * A guardrail on its own (#262 S89, #120): its rules checked first (`-guardrail`, one refusal, a
 * question, a threshold), created by its own container (its `deps`, `overrides`, the `environment`),
 * its model answering from `model` — `decideWith({ blocks: 0.9 })` (`{ cost }` for its spend,
 * `guardrail:<name>`); unscripted, it passes. Each check runs in the frame of a step, so a
 * computed `refusal()` reads the execution (`execution`, `tenant`) as in an application; it gives
 * the verdict — a block is `isBlocked` with its refusal, never a thrown `GuardrailBlockedError`.
 * A model that does not answer rejects with `GuardFailedError`.
 */
export function testGuardrail<
  TExecution extends ExecutionContext = ExecutionContext,
  TTenant extends TenantContext = TenantContext,
>(guardrail: Class, options: UnitModelOptions<unknown, TExecution, TTenant> = {}): GuardrailRunner {
  const meta = checkedMetaOf(guardrail);
  const { name } = meta;
  const site = new UnitSite(options);
  site.scriptModel(guardrailKeyOf(name), guardrail.name, options.model);
  const run = async (
    text: string,
    call: GuardrailCallOptions = {},
  ): Promise<UnitRun<GuardrailCheck>> => {
    const loaded = await loadedOf(guardrail, meta);
    const deps = unitRouterDeps(site.gateway);
    const runtime = runtimeGuardrailOf(loaded, {
      resolve: (cls) => site.instanceOf(cls),
      modelOf: (model) => routerModelOf(model, deps),
      deciderDeps: { gateway: deps.gateway, chatDefaults: deps.chatDefaults },
    });
    const frame = {
      component: guardrail,
      caller: guardrailKeyOf(name),
      ...callTimeoutOf(call.timeout),
    };
    return site.run(frame, async ({ spent }) => {
      const element = call.element ?? "test-agent";
      const checked = { text, element, side: loaded.side };
      const used: UsageRecord[] = [];
      const outcome = await checkGuardrail(runtime, checked, used, undefined);
      spent.push(...used);
      if (!outcome.isBlocked) return { isBlocked: false, probability: outcome.probability };
      return {
        isBlocked: true,
        probability: outcome.probability,
        refusal: await runtime.refusal(),
      };
    });
  };
  return Object.assign(run, { clock: site.clock });
}
