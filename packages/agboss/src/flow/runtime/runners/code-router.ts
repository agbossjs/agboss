import type { Class } from "../../../components/injection.js";
import type { GraphDeps } from "../../../graph/deps.js";
import { NodeKind } from "../../ast.js";
import { declarationOf } from "../../decorators/declaration.js";
import { passesThrough } from "../errors.js";
import type { RuntimeNode } from "../graph-model.js";
import { inputMessageOf } from "../input-message.js";
import type { NodeRunner } from "../node-runner.js";
import { RouterDecisionError, RouterFailedError, type RouterVisit } from "../router-error.js";
import { readInput } from "../scope.js";
import { visitNumberOf } from "../step-frame.js";
import { codeRouterLaunch } from "../launch/router-decision.js";
import { reportNodeEvent } from "../../observers/execution-event.js";
import { unreadyRoutesOf } from "../soft-stop.js";
import { RecursionDecider } from "../../analyse/recursion.js";

/** What a code router's class is: `route(input)` (`implements RouterHandler<Self>`). */
interface CodeRouterInstance {
  route(input: Readonly<Record<string, unknown>>): unknown;
}

const isCodeRouter = (value: unknown): value is CodeRouterInstance =>
  typeof value === "object" &&
  value !== null &&
  "route" in value &&
  typeof value.route === "function";

const isClass = (value: unknown): value is Class => typeof value === "function";

/** What `route()` returned, as text for an error: a class by its `name`, anything else as it is. */
function answerLabel(answer: unknown): string {
  if (Array.isArray(answer)) return `a list of ${String(answer.length)}`;
  if (!isClass(answer))
    return typeof answer === "object" && answer !== null ? JSON.stringify(answer) : String(answer);
  return declarationOf(answer)?.options.name ?? answer.name;
}

/**
 * The node id of the one target `route()` chose after `.chooseOne(…)`; anything else — a list, a
 * class outside its routes (a cast) — is `RouterDecisionError`.
 */
function chosenRoute(
  node: RuntimeNode,
  step: RouterVisit,
  answer: unknown,
  unready: readonly string[],
): string {
  const routes = [...node.exits.routes.keys()];
  const name = isClass(answer) ? declarationOf(answer)?.options.name : undefined;
  if (name !== undefined && unready.includes(name))
    throw new RouterDecisionError(
      step,
      `route() returned ${name}: on the last level (depth = maxDepth) a route that launches ThisWorkflow is not ready`,
    );
  if (name !== undefined && node.exits.routes.has(name)) return name;
  const why = Array.isArray(answer)
    ? "after .chooseOne(…) it returns one target, not a list"
    : `not one of its routes (${routes.join(", ")})`;
  throw new RouterDecisionError(step, `route() returned ${answerLabel(answer)}: ${why}`);
}

/** What `route()` throws fails the step as `RouterFailedError` (its cause); a limit, cancel, pause pass. */
const failure = (step: RouterVisit, error: unknown): unknown =>
  passesThrough(error) ? error : new RouterFailedError(step, error);

/**
 * A code router (`DecidedBy.Code`, #280): its instance from the container runs `route(input)` with
 * its fields from the path scope — no model call, cost 0; the execution comes through
 * `deps: [ExecutionContext]` (the visit's frame). Its answer is checked against its routes (S19).
 */
export function codeRouterRunner(node: RuntimeNode, deps: GraphDeps<string>): NodeRunner {
  if (node.declaration.kind !== NodeKind.Router) throw new TypeError(`${node.id} is not a router`);
  return async (state) => {
    const step = { nodeId: node.id, visitNumber: visitNumberOf(node, state) };
    const instance: unknown = deps.container.get(node.component);
    if (!isCodeRouter(instance)) {
      throw new RouterFailedError(step, new TypeError(`${node.id} has no route(input)`));
    }
    const input = readInput(deps.graph, node, state);
    const name = node.id;
    const message = inputMessageOf(node.fields, state);
    await reportNodeEvent((base) =>
      deps.observer?.onRouterStart({ ...base, name, input: message }),
    );
    const answer: unknown = await Promise.resolve()
      .then(() => instance.route(input.fields))
      .catch((error: unknown) => {
        throw failure(step, error);
      });
    if (node.exits.launches.size > 0) {
      const launch = codeRouterLaunch(node, step, answer);
      const update = { route: launch.join(", "), reason: "decided by code" };
      await reportNodeEvent((base) => deps.observer?.onRouterEnd({ ...base, name, update }));
      return { launch, read: input.read };
    }
    const route = chosenRoute(
      node,
      step,
      answer,
      unreadyRoutesOf(deps.graph, node.id, RecursionDecider.CodeRouter),
    );
    const update = { route, reason: "decided by code" };
    await reportNodeEvent((base) => deps.observer?.onRouterEnd({ ...base, name, update }));
    return { route, read: input.read };
  };
}
