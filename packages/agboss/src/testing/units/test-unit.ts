import { ComponentKind } from "../../flow/runtime/records.js";
import type { KindLabels } from "../../flow/builder-types.js";
import type { Class } from "../../components/injection.js";
import { componentOf } from "../../components/metadata.js";
import { pauseTargetOf } from "../../channels/pause-targets.js";
import { declarationOf } from "../../flow/decorators/declaration.js";
import { arbiterOf } from "../../flow/decorators/arbiter.js";
import type { ExecutionContext } from "../../flow/context/execution-context.js";
import type { TenantContext } from "../../flow/context/tenant-context.js";
import type { KindOf, MissingGeneratedTypes, RouterAnswerOf } from "../../flow/generated-types.js";
import type { JudgeOutputOf } from "../../components/judge-decorators.js";
import type { RagSource } from "../../rag/rag-source.js";
import type { ToolInputOf, ToolOutputOf } from "../../tools/index.js";
import { TestSetupError } from "../errors.js";
import type { Untracked } from "../../flow/metadata.js";
import type { RecordedInputOf } from "../script-types.js";
import {
  actionUnit,
  type ActionInputOf,
  type ActionOutputOf,
  type ActionRunner,
} from "./test-action.js";
import { arbiterUnit, type ArbiterRunner } from "./test-arbiter.js";
import { compactionUnit, type CompactionRunner } from "./test-compaction.js";
import { guardrailUnit, type GuardrailRunner } from "./test-guardrail.js";
import { judgeUnit, type JudgeRunner } from "./test-judge.js";
import { piiUnit, type PiiRunner } from "./test-pii.js";
import { ragUnit, type RagRunner } from "./test-rag.js";
import { replyInterpreterUnit, type ReplyInterpreterRunner } from "./test-reply-interpreter.js";
import { interceptorUnit, type ToolInterceptorRunner } from "./test-tool-interceptor.js";
import { routerUnit, type RouterRunner } from "./test-router.js";
import { toolUnit, type ToolRunner } from "./test-tool.js";
import type { UnitModelOptions } from "./unit-types.js";

/** Whether a component's brand (`agboss check`) says it is a flow node of this kind. */
export type IsFlowNode<TInstance, TKind extends keyof KindLabels> = [KindOf<TInstance>] extends [
  never,
]
  ? false
  : [KindOf<TInstance>] extends [TKind]
    ? true
    : false;

/**
 * What a class of no handler method of its own is (a model guardrail, a memory, a PII policy, a
 * tool interceptor, an arbiter, a reply interpreter's role) gives: the runners of those kinds in
 * one — their calls take distinct arguments, so each is typed by its own first argument.
 */
export type OtherUnitRunners<TInstance> = GuardrailRunner &
  CompactionRunner &
  ArbiterRunner &
  PiiRunner &
  ToolInterceptorRunner &
  ReplyInterpreterRunner<TInstance>;

/**
 * The runner of a component whose types come from `agboss check` (a router's answer, a judge's
 * output): `MissingGeneratedTypes` while they are not generated — a call is then a compile error,
 * never a runner typed by what is unknown (#1328).
 */
export type FailClosed<TRunner, TGenerated> = [TGenerated] extends [never]
  ? TRunner
  : [TGenerated] extends [MissingGeneratedTypes]
    ? MissingGeneratedTypes
    : TRunner;

/**
 * The runner `testUnit` gives for a class (#1328): a flow node by its brand (an action, a router),
 * a class with a handler method by it (`execute`: a tool or an action, `route`, `judge`, a
 * `RagSource`), every other kind by what its runner is called with.
 */
export type UnitRunnerOf<TClass extends Class> =
  IsFlowNode<InstanceType<TClass>, ComponentKind.Router> extends true
    ? FailClosed<
        RouterRunner<
          Untracked<RecordedInputOf<InstanceType<TClass>>>,
          RouterAnswerOf<InstanceType<TClass>>
        >,
        RouterAnswerOf<InstanceType<TClass>>
      >
    : IsFlowNode<InstanceType<TClass>, ComponentKind.Action> extends true
      ? ActionRunner<
          Untracked<ActionInputOf<InstanceType<TClass>>>,
          ActionOutputOf<InstanceType<TClass>>
        >
      : InstanceType<TClass> extends { execute(input: never): unknown }
        ? ToolRunner<
            Untracked<ToolInputOf<InstanceType<TClass>>>,
            ToolOutputOf<InstanceType<TClass>>
          >
        : InstanceType<TClass> extends { route(input: never): unknown }
          ? FailClosed<
              RouterRunner<
                RecordedInputOf<InstanceType<TClass>>,
                RouterAnswerOf<InstanceType<TClass>>
              >,
              RouterAnswerOf<InstanceType<TClass>>
            >
          : InstanceType<TClass> extends { judge(input: never): unknown }
            ? TClass extends Class<object>
              ? FailClosed<JudgeRunner<JudgeOutputOf<TClass>>, JudgeOutputOf<TClass>>
              : never
            : InstanceType<TClass> extends RagSource
              ? RagRunner
              : OtherUnitRunners<InstanceType<TClass>>;

type UnitFactory = (component: never, options: never) => unknown;

/** The runner of each `@…` component kind (a flow node's, an arbiter's and a role's are found apart). */
const FACTORIES: Readonly<Record<string, UnitFactory>> = {
  tool: toolUnit,
  judge: judgeUnit,
  rag: ragUnit,
  guardrail: guardrailUnit,
  memory: compactionUnit,
  "tool-interceptor": interceptorUnit,
  "pii-policy": (one: Class, options: never) => piiUnit([one], options),
};

/** The runner factory of a class: by its decorator's record; `undefined` for a class that is none of them. */
function factoryOf(component: Class): UnitFactory | undefined {
  const declaration = declarationOf(component);
  if (declaration?.kind === ComponentKind.Action) return actionUnit;
  if (declaration?.kind === ComponentKind.Router) return routerUnit;
  if (arbiterOf(component) !== undefined) return arbiterUnit;
  if (pauseTargetOf(component) !== undefined) return replyInterpreterUnit;
  const kind = componentOf(component)?.kind;
  return kind === undefined ? undefined : FACTORIES[kind];
}

const SUPPORTED =
  "@Action, @Router, @Arbiter, @Tool, @Judge, @Rag, @InputGuardrail / @OutputGuardrail, @PiiPolicy, @Memory, @ToolInterceptor, a pause target's channel interpreter";

/**
 * One component on its own (#1328): `testUnit(SearchTool)`, `testUnit(RiskRouter, { model: routeTo(…) })`.
 * The runner is the kind's — a tool, an action, a router, an arbiter, a judge, a knowledge base, a
 * guardrail, a memory's compaction, a tool interceptor, a role's reply interpreter — created by a
 * container of its own (its `deps`, the `services` in place of the real ones, the `environment`),
 * its model scripted by `model`. A list of `@PiiPolicy` classes is the policies one element lists:
 * `testUnit([EmailPolicy, CardPolicy])`. A class of no such kind is a `TestSetupError`.
 */
export function testUnit<
  TTarget extends Class | readonly Class[],
  TExecution extends ExecutionContext = ExecutionContext,
  TTenant extends TenantContext = TenantContext,
>(
  component: TTarget,
  options?: UnitModelOptions<
    TTarget extends Class ? InstanceType<TTarget> : unknown,
    TExecution,
    TTenant
  >,
): TTarget extends readonly Class[]
  ? PiiRunner
  : TTarget extends Class
    ? UnitRunnerOf<TTarget>
    : never;
export function testUnit(component: Class | readonly Class[], options: object = {}): unknown {
  if (Array.isArray(component)) return piiUnit(component as readonly Class[], options);
  const one = component as Class;
  const factory = factoryOf(one);
  if (factory === undefined) {
    throw new TestSetupError({
      message: `testUnit(${one.name || "(anonymous class)"}): not a component it runs — ${SUPPORTED}`,
    });
  }
  return factory(one as never, options as never);
}
