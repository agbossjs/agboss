import type { AssembledApplication } from "../application/assemble.js";
import type { AssembledReplyInterpreter } from "../channels/discovery.js";
import type { Class } from "../components/injection.js";
import { NodeKind } from "../flow/ast.js";
import { arbiterOf, isCodeArbiter } from "../flow/decorators/arbiter.js";
import { isCodeRouterNode, type RuntimeNode } from "../flow/runtime/graph-model.js";
import { arbiterClassesOf } from "../flow/runtime/launch/runtime-launch.js";
import { piiScriptKeyOf } from "./pii-parts.js";
import {
  arbiterKeyOf,
  judgeScriptKeyOf,
  replyInterpreterKeyOf,
  routerKeyOf,
  type ModelTarget,
} from "./scripted-gateway.js";

/**
 * What `mockLlm(X)` scripts in one application (#262): an agent or a model router (a node), a
 * `@Judge`, a model arbiter (#279), a PII policy's model detection (#120) or a model reply
 * interpreter (#267) — each by its script key; a component that calls no model is named with why.
 */

/** The script key of a node that calls a model (an agent or a model router; a code router calls none). */
export function scriptKeyOf(node: RuntimeNode): string | undefined {
  if (node.kind === NodeKind.Agent) return `agent:${node.id}`;
  if (node.kind === NodeKind.Router && !isCodeRouterNode(node)) return routerKeyOf(node.id);
  return undefined;
}

/** The model-calling components of an application, by class. */
export class ModelTargets {
  readonly #judges: ReadonlySet<string>;
  /** The arbiters of the application's quorums (#279). */
  readonly #arbiters: ReadonlySet<Class>;
  /** The reply interpreters of the application's channel roles (#267 PR 3), by class. */
  readonly #interpreters: ReadonlyMap<Class, AssembledReplyInterpreter>;

  constructor(
    private readonly assembled: AssembledApplication,
    private readonly nodes: readonly RuntimeNode[],
  ) {
    const { workflows } = assembled;
    this.#judges = new Set(
      workflows.flatMap((workflow) => Object.keys(workflow.config.judges ?? {})),
    );
    this.#arbiters = new Set(
      workflows.flatMap((workflow) => arbiterClassesOf(workflow.graph.launches)),
    );
    this.#interpreters = new Map(
      workflows.flatMap((workflow) =>
        (workflow.replyInterpreters ?? []).map((found) => [found.interpreter, found] as const),
      ),
    );
  }

  /** The script key of a judge, a model arbiter, a PII detection or a model interpreter; else none. */
  componentKeyOf(target: ModelTarget): string | undefined {
    const judge = judgeScriptKeyOf(target, this.#judges);
    if (judge !== undefined) return judge;
    const interpreter = this.#interpreters.get(target);
    if (interpreter !== undefined)
      return interpreter.model === undefined ? undefined : replyInterpreterKeyOf(interpreter.name);
    const options = this.#arbiters.has(target) ? arbiterOf(target)?.options : undefined;
    return options === undefined || isCodeArbiter(options)
      ? piiScriptKeyOf(target, this.assembled)
      : arbiterKeyOf(options.name);
  }

  /** Why a class has no script: it calls no model, or it is not of this application. */
  whyNoScript(target: ModelTarget): string {
    const node = this.nodes.find((item) => item.component === target);
    if (node !== undefined && isCodeRouterNode(node))
      return "a code router calls no model — mockOf() the services its route() uses";
    if (this.#arbiters.has(target))
      return "a code arbiter calls no model — mockOf() it, or the services its methods use";
    if (this.#interpreters.has(target))
      return "a code reply interpreter calls no model — mockOf() it, or the services its interpret() uses";
    return "not an agent, router, judge, model arbiter or model reply interpreter of this application";
  }
}
