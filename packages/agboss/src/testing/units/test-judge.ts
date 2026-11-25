import type { ExecutionContext } from "../../flow/context/execution-context.js";
import type { TenantContext } from "../../flow/context/tenant-context.js";
import { verdictOfJudge } from "../../judges/declarative-judge.js";
import type {
  JudgedOutput,
  JudgeOutputOf,
  JudgeVerdict,
  RunnableJudge,
} from "../../components/judge-decorators.js";
import { isCodeJudge } from "../../components/judge-decorators.js";
import { checkedJudgeOf, loadedCriterionOf } from "../../components/judge-parts.js";
import type { Class } from "../../components/injection.js";
import { hydrated } from "../../dto/hydrate.js";
import { strictMatchOf } from "../../dto/schema.js";
import type { DtoClass } from "../../dto/types.js";
import { isDtoClass } from "../../dto/metadata.js";
import { hydratedForShape } from "../../flow/runtime/shape-hydration.js";
import { Wrapper } from "../../flow/dto-wrappers.js";
import { DEFAULT_MODEL_ALIAS } from "../../models/model-cascade.js";
import { requireComponent } from "../../components/metadata.js";
import { TestSetupError } from "../errors.js";
import type { ToolCallRecord } from "../../flow/runtime/tool-calls.js";
import type { UsageRecord } from "../../finops/usage.js";
import { meteredModel } from "../../graph/agent-loop/judge-model.js";
import { ModelKind } from "../../llm/decision-errors.js";
import type { JudgeBinding } from "../../llm/registry.js";
import { providerKindsOf } from "../../models/resolution.js";
import { isModelProviderClass, modelProviderOf } from "../../models/model-provider.decorator.js";
import { judgeKeyOf } from "../scripted-gateway.js";
import { callTimeoutOf, UnitSite } from "./unit-site.js";
import { unitChatSettings } from "./unit-models.js";
import type { FileContent } from "../../files/file-bytes.js";
import type { UnitCallOptions, UnitClock, UnitModelOptions, UnitRun } from "./unit-types.js";

/** A judge's input with `toolCalls` (#395) and `files` (#899) optional: `[]` when not given. */
export type JudgeRunnerInput<TOutput> =
  JudgedOutput<TOutput> extends infer TInput
    ? TInput extends unknown
      ? Omit<TInput, "toolCalls" | "files"> & {
          readonly toolCalls?: readonly ToolCallRecord[];
          readonly files?: readonly FileContent[];
        }
      : never
    : never;

/**
 * One judge on an agent's output: `await runJudge({ output, task, attempt })` → `{ output, spend }` —
 * the input's `output` a plain object of the judge's `output`, passed to it as an instance of its class;
 * `toolCalls` the visit's tool calls it reads (#395), `[]` when not given.
 */
export interface JudgeRunner<TOutput> extends UnitClock {
  (input: JudgeRunnerInput<TOutput>, options?: UnitCallOptions): Promise<UnitRun<JudgeVerdict>>;
}

/**
 * The output a unit test gives, as the flow hands it to a judge: instances of their classes — by the
 * `variant` the input names, else (a polymorphic list) by each item's strict schema.
 */
function hydratedOutput(
  shape: unknown,
  given: { readonly variant?: unknown; readonly output?: unknown },
) {
  const { variant, output } = given;
  // a value that does not fit the class the input names stays as given (the judge reads what it was told)
  const asClass = (dto: DtoClass, value: unknown): unknown =>
    strictMatchOf([dto], value) === dto ? hydrated(dto, value) : value;
  if (isDtoClass(variant))
    return Array.isArray(output)
      ? (output as readonly unknown[]).map((item) => asClass(variant, item))
      : asClass(variant, output);
  const isList =
    typeof shape === "object" && shape !== null && "kind" in shape && shape.kind === Wrapper.List;
  return isList ? hydratedForShape(shape as never, output) : output;
}

/** Whether the judge's own provider is a decisions one: its driver says it, no model name does. */
const decidesThrough = (modelProvider: Class | undefined): boolean => {
  if (modelProvider === undefined || !isModelProviderClass(modelProvider)) return false;
  return (
    providerKindsOf([modelProvider]).get(modelProviderOf(modelProvider).name) ===
    ModelKind.Decisions
  );
};

/** The judge's own model on the runner's scripts: a decision model decides, a chat model replies. */
function bindingOf(
  site: UnitSite,
  name: string,
  model: string,
  modelProvider: Class | undefined,
): JudgeBinding {
  if (decidesThrough(modelProvider)) {
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
 * `model` — `decideWith(…)` on a decision model, `replyWith(…)` on a chat model (`ConfigError.ModelKind`
 * for the wrong call, as at run time). Each call runs `judge(input)` in a step's frame; the
 * verdict is `output`, the model calls `spend` (`judge:<name>`). A declarative judge (#1290) has its model answer the verdict: script it with `replyWith('{"passed":true,"reason":""}')`, or `decideWith({ verdict: 0.9 })` on a decision model; unscripted it passes. A code judge (no `JudgeModel` in its `deps`)
 * runs its `judge(input)` alone — no `model` script (one is a `TestSetupError`), no spend.
 */
export function judgeUnit<
  TJudge extends Class<object>,
  TExecution extends ExecutionContext = ExecutionContext,
  TTenant extends TenantContext = TenantContext,
>(
  judge: TJudge,
  options: UnitModelOptions<unknown, TExecution, TTenant> = {},
): JudgeRunner<JudgeOutputOf<TJudge>> {
  requireComponent(judge, "judge", "testUnit");
  const { meta } = checkedJudgeOf(`testUnit(${judge.name})`, judge);
  if (isCodeJudge(meta) && options.model !== undefined)
    throw new TestSetupError({
      message: `testUnit(${judge.name}): ${meta.name} injects no JudgeModel (it is decided by code) — it calls no model; leave out model`,
    });
  const site = new UnitSite(options);
  site.scriptModel(judgeKeyOf(meta.name), judge.name, options.model);
  const binding = isCodeJudge(meta)
    ? undefined
    : bindingOf(site, meta.name, meta.model ?? DEFAULT_MODEL_ALIAS, meta.modelProvider);
  const run = async (
    given: JudgeRunnerInput<JudgeOutputOf<TJudge>>,
    call: UnitCallOptions = {},
  ) => {
    // the judge reads the trajectory it would read at run time: none given → none (#395)
    const input = {
      ...given,
      output: hydratedOutput(
        meta.output,
        given as { readonly variant?: unknown; readonly output?: unknown },
      ),
      toolCalls: given.toolCalls ?? [],
      files: given.files ?? [],
    } as never;
    // the container creates the class itself: an instance of the judge, `judge` included
    const handler = site.instanceOf(judge) as RunnableJudge;
    const frame = {
      component: judge,
      caller: judgeKeyOf(meta.name),
      ...callTimeoutOf(call.timeout),
    };
    // a declarative judge's criterion, read as at assembly (#1290)
    const declared = await loadedCriterionOf(meta);
    return site.run(frame, ({ spent }: { readonly spent: UsageRecord[] }) => {
      const model = meteredModel({ name: meta.name, binding }, spent);
      return verdictOfJudge({ name: meta.name, handler, declared, binding }, input, model);
    });
  };
  return Object.assign(run, { clock: site.clock });
}
