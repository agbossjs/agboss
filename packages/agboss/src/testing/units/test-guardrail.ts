import type { Guardrail, GuardrailContext } from "../../components/policy-decorators.js";
import type { Class } from "../../components/injection.js";
import { requireComponent } from "../../components/metadata.js";
import { TestSetupError } from "../errors.js";
import { callTimeoutOf, UnitSite } from "./unit-site.js";
import type { UnitCallOptions, UnitClock, UnitOptions, UnitRun } from "./unit-types.js";

/** What a guardrail's hook resolves to (`beforeToolCall`: `{ overrideArguments }` or nothing). */
export type GuardrailHookResult<THook extends keyof Guardrail> = Awaited<
  ReturnType<NonNullable<Guardrail[THook]>>
>;

/** The decision `onChannelDecision` is shown: the channel's answer to the tool call. */
export type GuardrailDecision = Parameters<NonNullable<Guardrail["onChannelDecision"]>>[0];

/**
 * One guardrail's hooks, each run as its point of an agent's loop runs it:
 * `await guard.beforeToolCall({ agent: "refund-agent", call })` → `{ output, spend }`.
 */
export interface GuardrailRunner extends UnitClock {
  beforeToolCall(
    context: GuardrailContext,
    options?: UnitCallOptions,
  ): Promise<UnitRun<GuardrailHookResult<"beforeToolCall">>>;
  afterToolCall(
    context: GuardrailContext,
    options?: UnitCallOptions,
  ): Promise<UnitRun<GuardrailHookResult<"afterToolCall">>>;
  beforeAgentAnswer(
    context: GuardrailContext,
    options?: UnitCallOptions,
  ): Promise<UnitRun<GuardrailHookResult<"beforeAgentAnswer">>>;
  onChannelDecision(
    decision: GuardrailDecision,
    context: GuardrailContext,
    options?: UnitCallOptions,
  ): Promise<UnitRun<GuardrailHookResult<"onChannelDecision">>>;
}

/**
 * A `@Guardrail` on its own (#262 S89): created by its own container (its `deps`, `overrides`, the
 * `environment`); each hook runs in the frame of a step — `executionContext.signal` aborts after
 * `timeout` on the runner's clock — and gives what it returned (an `overrideArguments`, nothing)
 * as `output`. What it throws (a block) rejects as it was thrown; a hook the class does not have
 * is a setup error.
 */
export function testGuardrail(
  guardrail: Class<Guardrail>,
  options: UnitOptions = {},
): GuardrailRunner {
  const { meta } = requireComponent(guardrail, "guardrail", "testGuardrail");
  const site = new UnitSite(options);
  const caller = `guardrail:${meta.name}`;
  const hook = <TResult>(
    name: keyof Guardrail,
    call: UnitCallOptions | undefined,
    invoke: (instance: Guardrail) => Promise<TResult> | undefined,
  ): Promise<UnitRun<TResult>> => {
    const frame = { component: guardrail, caller, ...callTimeoutOf(call?.timeout) };
    return site.run(frame, async () => {
      // the container creates the class itself: an instance of the guardrail
      const ran = invoke(site.instanceOf(guardrail) as Guardrail);
      if (ran === undefined)
        throw new TestSetupError(`testGuardrail(${guardrail.name}): it has no ${name}()`);
      return ran;
    });
  };
  return {
    clock: site.clock,
    beforeToolCall: (context, call) =>
      hook("beforeToolCall", call, (instance) => instance.beforeToolCall?.(context)),
    afterToolCall: (context, call) =>
      hook("afterToolCall", call, (instance) => instance.afterToolCall?.(context)),
    beforeAgentAnswer: (context, call) =>
      hook("beforeAgentAnswer", call, (instance) => instance.beforeAgentAnswer?.(context)),
    onChannelDecision: (decision, context, call) =>
      hook("onChannelDecision", call, (instance) =>
        instance.onChannelDecision?.(decision, context),
      ),
  };
}
