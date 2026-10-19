import type { ExecutionContext } from "../../flow/context/execution-context.js";
import type { TenantContext } from "../../flow/context/tenant-context.js";
import { runJudgeCall } from "../../components/judge-call.js";
import type {
  JudgeHandler,
  JudgeHandlerClass,
  JudgeInput,
  JudgeReplyOf,
  JudgeVerdict,
} from "../../components/judge-decorators.js";
import { requireComponent } from "../../components/metadata.js";
import type { UsageRecord } from "../../finops/usage.js";
import { meteredModel } from "../../graph/agent-loop/judge-model.js";
import { ModelKind } from "../../llm/decision-errors.js";
import type { JudgeBinding } from "../../llm/registry.js";
import { isDecisionModel } from "../../models/decision-models.js";
import { judgeKeyOf } from "../scripted-gateway.js";
import { callTimeoutOf, UnitSite } from "./unit-site.js";
import { unitChatSettings } from "./unit-models.js";
import type { UnitCallOptions, UnitClock, UnitModelOptions, UnitRun } from "./unit-types.js";

/**
 * One judge on an agent's reply: `await runJudge({ reply, task, attempt })` → `{ output, spend }` —
 * `reply` a plain object of the judge's `reply` (`JudgeHandler<TReply>`), passed to it as given.
 */
export interface JudgeRunner<TReply> extends UnitClock {
  (input: JudgeInput<TReply>, options?: UnitCallOptions): Promise<UnitRun<JudgeVerdict>>;
}

/** The judge's own model on the runner's scripts: a decision model decides, a chat model replies. */
function bindingOf(site: UnitSite, name: string, model: string): JudgeBinding {
  if (isDecisionModel(model)) {
    const decide = site.gateway.decide;
    return {
      kind: ModelKind.Decisions,
      model,
      decide: (request) =>
        decide === undefined
          ? Promise.reject(new TypeError("the scripted gateway decides"))
          : decide({ caller: judgeKeyOf(name), model, request }),
    };
  }
  const settings = unitChatSettings(model);
  const chat = site.gateway.chatModel({ user: { kind: "judge", judge: name }, settings });
  return { kind: ModelKind.Chat, model, chat: { model: chat, settings } };
}

/**
 * A `@Judge` on its own (#262 S55, S62): created by its own container (its `deps`, `overrides`,
 * the `environment`); its injected `JudgeModel` is its own `@Judge({ model })` answering from
 * `model` — `decideWith(…)` on a decision model, `replyWith(…)` on a chat model (`ModelKindError`
 * for the wrong call, as at run time). Each call runs `judge(input)` in a step's frame; the
 * verdict is `output`, the model calls `spend` (`judge:<name>`).
 */
export function testJudge<
  TJudge extends JudgeHandlerClass,
  TExecution extends ExecutionContext = ExecutionContext,
  TTenant extends TenantContext = TenantContext,
>(
  judge: TJudge,
  options: UnitModelOptions<unknown, TExecution, TTenant> = {},
): JudgeRunner<JudgeReplyOf<TJudge>> {
  const { meta } = requireComponent(judge, "judge", "testJudge");
  const site = new UnitSite(options);
  site.scriptModel(judgeKeyOf(meta.name), judge.name, options.model);
  const binding = bindingOf(site, meta.name, meta.model);
  const run = async (input: JudgeInput<JudgeReplyOf<TJudge>>, call: UnitCallOptions = {}) => {
    // the container creates the class itself: an instance of the judge, `judge` included
    const handler = site.instanceOf(judge) as JudgeHandler<JudgeReplyOf<TJudge>>;
    const frame = {
      component: judge,
      caller: judgeKeyOf(meta.name),
      ...callTimeoutOf(call.timeout),
    };
    return site.run(frame, ({ spent }: { readonly spent: UsageRecord[] }) => {
      const model = meteredModel({ name: meta.name, binding }, spent);
      return runJudgeCall(model, () => handler.judge(input));
    });
  };
  return Object.assign(run, { clock: site.clock });
}
