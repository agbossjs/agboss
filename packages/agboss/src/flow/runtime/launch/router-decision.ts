import type { RunnableConfig } from "@langchain/core/runnables";
import { RunnableLambda } from "@langchain/core/runnables";
import type { Class } from "../../../components/injection.js";
import type { UsageRecord } from "../../../finops/usage.js";
import { NodeKind } from "../../ast.js";
import { declarationOf } from "../../decorators/declaration.js";
import {
  routesOf,
  spawnPolicyOf,
  SpawnPolicy,
  type RouterOptions,
} from "../../decorators/router.js";
import type { RuntimeNode } from "../graph-model.js";
import { RouterDecisionError, routerFailureOf, type RouterVisit } from "../router-error.js";
import type { LoadedRouter } from "../routers.js";
import type { LaunchDecider } from "./launch-decider.js";

/**
 * A router before a parallel launch (#273, #280 S47 f): it decides only its `OnDemand` routes — the
 * framework launches the `Always` ones. A model router asks its model (S23, `launch-decider.ts`);
 * a code router's `route()` returns the list of `OnDemand` targets to launch. Nothing to launch
 * without an `Always` route is a `RouterDecisionError`, like a target outside its routes.
 */

/** What a router decided for its launch: the `OnDemand` targets to launch, and what it cost. */
export interface RouterLaunch {
  readonly launch: readonly string[];
  readonly reason: string;
  readonly usage: readonly UsageRecord[];
}

const optionsOf = (node: RuntimeNode): RouterOptions => {
  if (node.declaration.kind !== NodeKind.Router) throw new TypeError(`${node.id} is not a router`);
  return node.declaration.options;
};

const nameOf = (target: Class): string => declarationOf(target)?.options.name ?? target.name;

/** The `OnDemand` routes' targets, in the order of `@Router({ routes })`. */
export const onDemandTargetsOf = (node: RuntimeNode): readonly string[] => {
  const options = optionsOf(node);
  return routesOf(options)
    .filter((route) => spawnPolicyOf(options, route) === SpawnPolicy.OnDemand)
    .map((route) => nameOf(route.target));
};

const hasAlwaysRoute = (node: RuntimeNode): boolean => {
  const options = optionsOf(node);
  return routesOf(options).some((route) => spawnPolicyOf(options, route) === SpawnPolicy.Always);
};

/** Nothing would run: every `OnDemand` route out, and no `Always` one. */
function checkLaunches(
  node: RuntimeNode,
  step: RouterVisit,
  launch: readonly string[],
  usage: readonly UsageRecord[],
): void {
  if (launch.length > 0 || hasAlwaysRoute(node)) return;
  const reason =
    "it launched none of its OnDemand routes and has no Always route — nothing would run";
  throw new RouterDecisionError(step, reason, usage);
}

const traceEntry = RunnableLambda.from((trace: object) => trace);

/** Where a model router's launch is decided: its texts, its input, its model. */
export interface ModelLaunchSite {
  readonly node: RuntimeNode;
  readonly router: LoadedRouter;
  readonly step: RouterVisit;
  readonly input: string;
  readonly decider: LaunchDecider | undefined;
  readonly config?: RunnableConfig;
}

/** A model router's launch (S23): one call, a yes/no per `OnDemand` route, P(yes) in the trace. */
export async function modelRouterLaunch(site: ModelLaunchSite): Promise<RouterLaunch> {
  const { node, router, step } = site;
  if (site.decider === undefined)
    throw routerFailureOf(step, {
      kind: "failed",
      reason: "no launch decisions",
      cause: new TypeError(`${node.id}: no launch decider`),
    });
  const questions = onDemandTargetsOf(node).map((target) => ({
    target,
    prompt: router.routes.find((route) => route.option === target)?.condition ?? "",
  }));
  const request = { input: site.input, instructions: router.instructions, questions };
  const outcome = await site.decider.decide(request);
  if (outcome.kind === "failed") throw routerFailureOf(step, outcome);
  const usage = outcome.usage === undefined ? [] : [outcome.usage];
  checkLaunches(node, step, outcome.launched, usage);
  const parent = site.config ?? {};
  const trace = { launched: outcome.launched, probabilities: outcome.probabilities };
  const options = { callbacks: parent.callbacks, tags: parent.tags, metadata: parent.metadata };
  await traceEntry.invoke(trace, { ...options, runName: "launch decision" });
  const said = questions.map(
    ({ target }) => `${target} ${String(outcome.probabilities[target] ?? 0)}`,
  );
  return { launch: outcome.launched, reason: `P(launch): ${said.join(", ")}`, usage };
}

/** A code router's answer before a launch: a list of its `OnDemand` targets, checked (S19). */
export function codeRouterLaunch(
  node: RuntimeNode,
  step: RouterVisit,
  answer: unknown,
): readonly string[] {
  if (!Array.isArray(answer))
    throw new RouterDecisionError(
      step,
      "before .toParallelAgents(…) route() returns a list of its OnDemand targets",
    );
  const allowed = onDemandTargetsOf(node);
  const names = (answer as readonly unknown[]).map((target) =>
    typeof target === "function" ? nameOf(target as Class) : String(target),
  );
  const outside = names.find((name) => !allowed.includes(name));
  if (outside !== undefined)
    throw new RouterDecisionError(
      step,
      `route() returned ${outside}: not one of its OnDemand routes (${allowed.join(", ")})`,
    );
  const launch = allowed.filter((name) => names.includes(name));
  checkLaunches(node, step, launch, []);
  return launch;
}
