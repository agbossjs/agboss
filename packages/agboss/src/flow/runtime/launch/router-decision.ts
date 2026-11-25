import type { RunnableConfig } from "@langchain/core/runnables";
import { RunnableLambda } from "@langchain/core/runnables";
import type { Class } from "../../../components/injection.js";
import type { UsageRecord } from "../../../finops/usage.js";
import { declarationOf } from "../../decorators/declaration.js";
import type { FlowLaunch } from "../../analyse/flow-graph.js";
import type { RuntimeNode } from "../graph-model.js";
import { RouterDecisionError, routerFailureOf, type RouterVisit } from "../router-error.js";
import type { LoadedRouter } from "../routers.js";
import type { LaunchDecider } from "./launch-decider.js";

/**
 * A router in a parallel launch (`toRouter(R).chooseMany([…])`, #1279b): it decides which of its
 * routes run — the siblings of the router in `.inParallel([…])` run anyway. A model router asks its
 * model (S23, `launch-decider.ts`); a code router's `route()` returns the list of targets to launch,
 * `[]` included. A target outside its routes is a `RouterDecisionError`.
 */

/** What a router decided for its launch: the routes to launch, and what it cost. */
export interface RouterLaunch {
  readonly launch: readonly string[];
  readonly reason: string;
  readonly usage: readonly UsageRecord[];
}

const isClass = (value: unknown): value is Class => typeof value === "function";

const nameOf = (target: Class): string => declarationOf(target)?.options.name ?? target.name;

/** The routes a `chooseMany([…])` launch of this router picks among (#1279b). */
const chooserOf = (node: RuntimeNode): FlowLaunch["chooser"] =>
  [...node.exits.launches.values()].find((runtime) => runtime.launch.chooser !== undefined)?.launch
    .chooser;

/** The routes a `chooseMany([…])` of this router picks among (#1279b), in the order of its flow. */
export const onDemandTargetsOf = (node: RuntimeNode): readonly string[] =>
  chooserOf(node)?.routes ?? [];

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

/** A model router's launch (S23): one call, a yes/no per route, P(yes) in the trace. */
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
  const parent = site.config ?? {};
  const trace = { launched: outcome.launched, probabilities: outcome.probabilities };
  const options = { callbacks: parent.callbacks, tags: parent.tags, metadata: parent.metadata };
  await traceEntry.invoke(trace, { ...options, runName: "launch decision" });
  const said = questions.map(
    ({ target }) => `${target} ${String(outcome.probabilities[target] ?? 0)}`,
  );
  return { launch: outcome.launched, reason: `P(launch): ${said.join(", ")}`, usage };
}

/** A code router's answer in a launch: a list of its routes' targets, checked (S19). */
export function codeRouterLaunch(
  node: RuntimeNode,
  step: RouterVisit,
  answer: unknown,
): readonly string[] {
  if (!Array.isArray(answer))
    throw new RouterDecisionError({
      ...step,
      reason: "in toRouter(R).chooseMany([…]) route() returns a list of its routes' targets",
    });
  const allowed = onDemandTargetsOf(node);
  const names = (answer as readonly unknown[]).map((target) =>
    isClass(target) ? nameOf(target) : String(target),
  );
  const outside = names.find((name) => !allowed.includes(name));
  if (outside !== undefined)
    throw new RouterDecisionError({
      ...step,
      reason: `route() returned ${outside}: not one of its routes (${allowed.join(", ")})`,
    });
  const launch = allowed.filter((name) => names.includes(name));
  return launch;
}
