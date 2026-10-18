import type { ChatModelUser, DecisionSpec, ModelGateway } from "../llm/gateway.js";
import { componentOf } from "../components/metadata.js";
import type { Class } from "../components/injection.js";
import { routerCaller, type RouteOutcome } from "../routers/index.js";
import type { UsageRecord } from "../finops/usage.js";
import { asError, TestFailure } from "./errors.js";
import { nodeNameOf } from "./failure-facts.js";
import {
  ModelCallFailedError,
  replyWith,
  type DecisionDetails,
  type ScriptedTurn,
} from "./script.js";
import type { ComponentScript, ScriptBook, ModelRequest } from "./script-book.js";
import { ScriptedChatModel } from "./scripted-chat-model.js";
import { scriptedDecide } from "./scripted-decisions.js";

/** The script key of a chat model's user and of a router. */
export function chatKeyOf(user: ChatModelUser): string {
  switch (user.kind) {
    case "compaction":
      return "compaction";
    case "agent":
      return `agent:${user.agent}`;
    case "judge":
      return judgeKeyOf(user.judge);
    case "router":
      return `router:${user.router}`;
    case "arbiter":
      return arbiterKeyOf(user.arbiter);
  }
}
export const judgeKeyOf = (judge: string): string => `judge:${judge}`;
/** The script key of a model arbiter (#279): its cost caller. */
export const arbiterKeyOf = (arbiter: string): string => `arbiter:${arbiter}`;

/** What `mockLlm` scripts: an agent or a router (by class), or a `@Judge`. */
export type ModelTarget = Class;

/** The script key of a `@Judge` class among the workflow's judges (by name); else none. */

export function judgeScriptKeyOf(
  target: ModelTarget,
  judges: ReadonlySet<string>,
): string | undefined {
  const component = componentOf(target);
  if (component?.kind !== "judge" || !judges.has(component.meta.name)) return undefined;
  return judgeKeyOf(component.meta.name);
}
export const routerKeyOf = (router: string): string => `router:${router}`;

/** The option a router sees for a target: the target's node id (its `name`). */
export const optionOf = (target: Class): string => nodeNameOf(target);

const failed = (reason: string): RouteOutcome => ({ kind: "failed", reason });

/** Guards nobody scripted pass: content checks are not what most tests are about. */
const GUARD_PASSES: RouteOutcome = {
  kind: "decided",
  decision: { next: "pass", reason: "unscripted guard", confidence: 1 },
};

/** Conversation compaction nobody scripted writes this summary. */
export const UNSCRIPTED_SUMMARY = "(summary of the earlier turns)";

function usageOf(spec: DecisionSpec, details: DecisionDetails): UsageRecord | undefined {
  if (details.cost === undefined) return undefined;
  const model = spec.model.kind === "jev" ? spec.model.model : spec.model.settings.model;
  return {
    caller: routerCaller(spec.router),
    model,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: details.cost,
    costSource: "api",
  };
}

/** A scripted turn as the router's outcome; a target outside its routes fails the test. */
function outcomeOf(turn: ScriptedTurn, spec: DecisionSpec, script: ComponentScript): RouteOutcome {
  if (turn.kind === "failure") {
    // the model call failed: a router fails with RouterFailedError, this error as its cause (#280 S19)
    const cause = new ModelCallFailedError(turn.failure, script.label);
    return { kind: "failed", reason: cause.message, cause };
  }
  if (turn.kind !== "decision") {
    throw new TestFailure(
      "test.wrong-script",
      `${script.label} is a router: script it with routeTo(…), not replyWith(…) / callTool(…)`,
    );
  }
  const next = optionOf(turn.target);
  const options = spec.request.options.map((option) => option.name);
  if (!options.includes(next)) {
    throw new TestFailure(
      "test.not-a-route",
      `routeTo(${next}) for ${script.label}: not one of its routes (${options.join(", ")})`,
    );
  }
  const decision = {
    next,
    reason: turn.details.reason ?? "scripted",
    confidence: turn.details.confidence ?? 1,
  };
  const usage = usageOf(spec, turn.details);
  return usage === undefined ? { kind: "decided", decision } : { kind: "decided", decision, usage };
}

/**
 * The model gateway of a test: every chat model and every decision answers by script. A failure
 * that must fail the test (no script, script exhausted, not a route) is reported to the book and
 * returned as a failed outcome — the run fails, the test sees the reported failure.
 */
export function createScriptedGateway(book: ScriptBook): ModelGateway {
  const compaction = book.scriptOf("compaction");
  if (!compaction.isScripted) compaction.thenReturnAlways(replyWith(UNSCRIPTED_SUMMARY));
  return {
    chatModel: ({ user, settings }) => new ScriptedChatModel(book, chatKeyOf(user), settings),
    routeTo: (spec) => {
      const script = book.scriptOf(routerKeyOf(spec.router));
      const req: ModelRequest = {
        kind: "decision",
        input: spec.request.input,
        options: spec.request.options.map((option) => option.name),
        routes: Object.fromEntries(spec.request.options.map((o) => [o.name, o.description])),
        instructions: spec.request.instructions ?? "",
      };
      script.requests.push(req);
      if (!script.isScripted && spec.router.startsWith("guard:")) {
        return Promise.resolve(GUARD_PASSES);
      }
      try {
        return Promise.resolve(outcomeOf(script.next(req), spec, script));
      } catch (error) {
        return Promise.resolve(failed(book.report(asError(error)).message));
      }
    },
    decide: (spec) => scriptedDecide(book, spec),
  };
}
