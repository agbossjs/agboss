import { NO_BUDGET_CHECK } from "../budgets/execution-budgets.js";
import type { BuiltApp } from "../app/create-app.js";
import type { Class } from "../components/injection.js";
import { agentDefinitions } from "../graph/agent-definitions.js";
import { agentLoopGraph, loopInputOf, noJudges } from "../graph/agent-loop/index.js";
import { RouterDecisionError, routerFailureOf } from "../flow/runtime/router-error.js";
import type { ExecutionStateType } from "../flow/runtime/state.js";
import type { ToolOutput } from "../tools/index.js";
import { TestSetupError } from "./errors.js";
import { nodeNameOf } from "./failure-facts.js";
import { toolNameOf } from "./script.js";
import { standaloneCallFrameOf } from "../flow/context/call-frame.js";
import { runInFrame } from "../flow/context/frame.js";
import { DEFAULT_CONTEXT_VALUES } from "../flow/context/context-values.js";
import { defaultTenantOf, standaloneContexts } from "../flow/context/runtime-contexts.js";

/** One tool of the app, as the agents get it (validation, timeout, errors as results). */
export interface ToolSlice<TInput, TOutput> {
  invoke(input: TInput): Promise<ToolOutput<TOutput>>;
}

/** One router of the app on its own: an input message in, the component it chooses out. */
export interface RouterSlice {
  routeTo(input: string): Promise<Class>;
}

/**
 * One agent of the app on its own: an input message in, its reply out — its text, or its answer's
 * JSON (no flow, no approval pause).
 */
export interface AgentSlice {
  replyWith(input: string): Promise<string>;
}

/** A tool class, typed by its `run`. */
export type ToolClassOf<TInput, TOutput> = Class<{
  run(input: TInput): Promise<TOutput>;
}>;

export function toolSlice<TInput, TOutput>(
  built: BuiltApp,
  cls: ToolClassOf<TInput, TOutput>,
): ToolSlice<TInput, TOutput> {
  const name = toolNameOf(cls);
  const tool = built.deps.tools(name);
  const { type } = built.bundle.graph;
  const workflow = { type, name: built.deps.config.name, version: built.deps.config.version };
  const signal = new AbortController().signal;
  const call = {
    workflow,
    type: cls,
    name,
    executionId: "tool-slice",
    callId: "tool-slice",
    signal,
    tenant: defaultTenantOf(built.deps.contexts ?? standaloneContexts(built.deps.config)),
  };
  return {
    // the tool validates its result against the output DTO that `run` returns
    // one call is an execution of its own — what its injected `ExecutionContext` reads (#280)
    invoke: (input) =>
      runInFrame(
        standaloneCallFrameOf(call),
        async () => (await tool.invoke(input)) as ToolOutput<TOutput>,
      ),
  };
}

export function routerSlice(built: BuiltApp, target: Class): RouterSlice {
  const name = nodeNameOf(target);
  const loaded = built.deps.routers.find((router) => router.name === name);
  if (loaded === undefined) {
    throw new TestSetupError(`app.router(${target.name}): not a router of this application`);
  }
  const router = built.deps.routerFor(loaded);
  return {
    routeTo: async (input) => {
      const options = loaded.routes.map((item) => ({
        name: item.option,
        description: item.condition,
      }));
      const outcome = await router.route({ input, options, instructions: loaded.instructions });
      const step = { nodeId: name, visitNumber: 1 };
      if (outcome.kind === "failed") throw routerFailureOf(step, outcome);
      const chosen = built.bundle.graph.nodes.get(outcome.decision.next);
      if (chosen === undefined) {
        const reason = `"${outcome.decision.next}" is not one of its routes`;
        throw new RouterDecisionError(step, reason);
      }
      return chosen.component;
    },
  };
}

/** A loop's input before anything ran: the input message, nothing spent yet. */
const freshState = (runId: string): ExecutionStateType => ({
  runId,
  start: "",
  startInput: {},
  startedVersion: "",
  contexts: DEFAULT_CONTEXT_VALUES,
  scope: {},
  outdatedValues: [],
  path: [],
  visits: {},
  steps: 0,
  lastError: null,
  next: "",
  finish: "",
  output: undefined,
  budgetUsd: Number.POSITIVE_INFINITY,
  usage: [],
  budgets: [],
  history: [],
  summaries: [],
  approvals: [],
  launch: null,
  branchRecords: [],
  launches: [],
});

export function agentSlice(built: BuiltApp, target: Class): AgentSlice {
  const name = nodeNameOf(target);
  const agent = agentDefinitions(built.deps).get(name);
  if (agent === undefined) {
    throw new TestSetupError(`app.agent(${target.name}): not an agent of this application`);
  }
  const loop = agentLoopGraph({
    agent,
    bundle: built.deps.config.name,
    budgets: NO_BUDGET_CHECK,
    judges: noJudges,
  });
  return {
    replyWith: async (input) => {
      const after = await loop.invoke(loopInputOf(freshState("agent-slice"), name, input));
      return after.reply ?? "";
    },
  };
}
