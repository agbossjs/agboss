import type { RunnableConfig } from "@langchain/core/runnables";
import {
  extractRunContext,
  throwIfCancelled,
  type NodeRunContext,
} from "../../core/run-context.js";
import { errorRecordOf } from "../../core/error-record.js";
import { callerOfSpend } from "../../finops/explicit-caller.js";
import { type UsageRecord } from "../../finops/usage.js";
import { inToolCallFrame } from "../../flow/context/frame.js";
import type { PiiPolicySet } from "../../pii/policy-set.js";
import type { PiiTokenMap } from "../../pii/tokens.js";
import type { AnyTool } from "../../tools/index.js";
import type { AsyncNode } from "../types.js";
import { unpreparedCalls } from "./boundary.js";
import { callSignalOf } from "./call-signal.js";
import { toolNamed, type AgentLoopDeps, type ToolCallRequest } from "./deps.js";
import { toolMeshCallOf } from "./mesh-call.js";
import { argsDigestOf, unknownToolPrepared, withoutOverride } from "./move-entries.js";
import { askOf } from "./question-ask.js";
import {
  PreparedFrom,
  type AgentLoopStateType,
  type AgentLoopUpdate,
  type PreparedCall,
  type PreparedCallEnd,
  type QuestionCallAnswer,
} from "./state.js";
import { loopPoliciesOf } from "./model-pii.js";
import { beforeCall, interceptorsOf } from "./tool-interception.js";
import { argumentsRefusalOf, screenedArguments, type ScreenedArguments } from "./tool-pii.js";
import { keepStopCause } from "./tool-stops.js";
import type { ToolCallRemote } from "../../mesh/mesh-call.js";

/**
 * Prepares the calls of a move before any is asked about or run (#1295c): each call's arguments
 * are checked against its tool's input, then searched by the PII policies (a block rule's kind
 * refuses the call, everything else is masked for whoever is asked), then given to the tool
 * interceptors' `before` hooks (`beforeAnyTool`, then the tool's `@BeforeTool`; a `reply` or
 * `block` ends the call, an `allow({ input })` replaces the arguments, validated again and searched
 * once more). A call that does not pass never waits for an approval and never runs its tool.
 * What became of each call is kept by its call id in the loop's `prepared`: a pause at an approval
 * and its resume — or a restart — take it as it is, nothing is checked, masked or asked of an
 * interceptor twice. An approver's `overrideInput` are arguments nobody checked: the call is
 * prepared once more on them, after the decision.
 */
export function makePrepareNode(
  deps: AgentLoopDeps,
): AsyncNode<AgentLoopStateType, AgentLoopUpdate> {
  return async (state, config) => {
    const runCtx = extractRunContext(config, state.runId);
    const ended: Record<string, PreparedCall> = {};
    const asked: Record<string, QuestionCallAnswer> = {};
    const decisions: Record<string, NonNullable<ReturnType<typeof withoutOverride>>> = {};
    const usage: UsageRecord[] = [];
    let tokens: PiiTokenMap = {};
    // one after the other, in the move's order: the tokens of one call are known to the next
    for (const call of unpreparedCalls(state)) {
      const tool = toolNamed(deps.agent, call.tool);
      if (tool === undefined) {
        ended[call.callId] = unknownToolPrepared(call);
        continue;
      }
      throwIfCancelled(runCtx.run);
      const known = { ...state.piiTokens, ...tokens };
      const prepared = await preparedCallOf({ state, deps, config, runCtx }, { call, tool, known });
      ended[call.callId] = prepared.call;
      const kept = withoutOverride(state.decisions[call.callId]);
      if (kept !== undefined) decisions[call.callId] = kept;
      usage.push(...prepared.usage);
      tokens = { ...tokens, ...prepared.tokens };
      if (prepared.asked !== undefined) asked[call.callId] = prepared.asked;
    }
    return { prepared: ended, decisions, questionAnswers: asked, usage, piiTokens: tokens };
  };
}

/** What a prepared call is of: its tool and the arguments the model gave (#1295c). */
const identityOf = (call: ToolCallRequest): Pick<PreparedCall, "tool" | "argsDigest"> => ({
  tool: call.tool,
  argsDigest: argsDigestOf(call.args),
});

/** Where the preparing runs. */
interface PrepareSite {
  readonly state: AgentLoopStateType;
  readonly deps: AgentLoopDeps;
  readonly config: RunnableConfig | undefined;
  readonly runCtx: NodeRunContext;
}

/** The call to prepare and the tokens its move knows. */
interface PrepareTarget {
  readonly call: ToolCallRequest;
  readonly tool: AnyTool;
  readonly known: PiiTokenMap;
}

/** What preparing one call gave: how it ended, what it spent, the tokens it made. */
interface PreparedResult {
  readonly call: PreparedCall;
  readonly usage: readonly UsageRecord[];
  readonly tokens: PiiTokenMap;
  /** A question call whose arguments are no valid ask (#712): the model reads why, nobody is asked. */
  readonly asked?: QuestionCallAnswer;
}

/** The arguments of a call and whose they are: an approver's override, else the model's. */
function argumentsOf(
  state: AgentLoopStateType,
  call: ToolCallRequest,
): { readonly args: Record<string, unknown>; readonly from: PreparedFrom } {
  const override = state.decisions[call.callId]?.overrideInput;
  return override === undefined
    ? { args: call.args, from: PreparedFrom.Model }
    : { args: { ...override }, from: PreparedFrom.Approver };
}

/** The first of the arguments' searches that a block rule refused, as the call's end. */
async function refusedBy(
  set: PiiPolicySet | undefined,
  screened: ScreenedArguments,
): Promise<PreparedCallEnd | undefined> {
  const refused = await argumentsRefusalOf(set, screened);
  return refused === undefined
    ? undefined
    : { kind: "refused", content: refused.content, refusal: errorRecordOf(refused.refusal) };
}

/** The call's end that needs no hook, or what the hooks are given: its arguments checked and searched. */
type Started =
  | { readonly end: PreparedResult }
  | { readonly checked: Record<string, unknown>; readonly screened: ScreenedArguments };

/** The input check, then the PII search, of one call (#1295c). */
async function startedOf(site: PrepareSite, target: PrepareTarget, own: Own): Promise<Started> {
  const { state, deps } = site;
  const { tool, known } = target;
  const args = own.args;
  // a question role's arguments are its ask: strict, and no tool runs (#712)
  const parsed = askOf(tool, args);
  if (parsed.kind === "invalid") {
    const asked = { tool: tool.name, problem: parsed.problem };
    return { end: own.end({ kind: "invalid" }, tool.question === undefined ? {} : { asked }) };
  }
  const checked = tool.question === undefined ? args : { ...parsed.value };
  const set = loopPoliciesOf(state, deps);
  const screened = await screenedArguments(set, checked, known);
  const refused = await refusedBy(set, screened);
  if (refused === undefined) return { checked, screened };
  return { end: own.end(refused, { usage: screened.usage }) };
}

/** How a call's results are made: its arguments and a result of the end it came to. */
interface Own {
  readonly args: Record<string, unknown>;
  readonly end: (end: PreparedCallEnd, spent?: Partial<PreparedResult>) => PreparedResult;
}

/** One call prepared: input check, PII, then the interceptors' `before` hooks. */
async function preparedCallOf(site: PrepareSite, target: PrepareTarget): Promise<PreparedResult> {
  const { state, deps } = site;
  const { args, from } = argumentsOf(state, target.call);
  const own: Own = {
    args,
    end: (end, spent = {}) => ({
      call: { ...identityOf(target.call), args, from, ...end },
      usage: [],
      tokens: {},
      ...spent,
    }),
  };
  const started = await startedOf(site, target, own);
  if ("end" in started) return started.end;
  const { checked, screened } = started;
  const searched = { usage: screened.usage, tokens: screened.tokens };
  if (interceptorsOf(deps, target.tool).length === 0)
    return own.end({ kind: "ready", shown: screened.masked }, searched);
  const hooked = await hooksOf(site, target, checked);
  const remote = hooked.remote === undefined ? {} : { remote: hooked.remote };
  const { end } = hooked;
  const spent = [...screened.usage, ...hooked.usage];
  if (end.kind !== "proceed")
    return withRemote(own.end(end, { usage: spent, tokens: searched.tokens }), remote);
  // what an `allow({ input })` gave is searched again: it is what an approver sees and the tool gets
  const input = end.input as Record<string, unknown>;
  const final =
    input === checked
      ? screened
      : await screenedArguments(loopPoliciesOf(site.state, deps), input, target.known);
  const refusedFinal =
    input === checked ? undefined : await refusedBy(loopPoliciesOf(state, deps), final);
  const ready: PreparedCallEnd = refusedFinal ?? { kind: "ready", shown: final.masked };
  const usage = input === checked ? spent : [...spent, ...final.usage];
  const result = own.end(ready, { usage, tokens: { ...screened.tokens, ...final.tokens } });
  return withRemote({ ...result, call: { ...result.call, args: input } }, remote);
}

const withRemote = (
  result: PreparedResult,
  remote: { readonly remote?: ToolCallRemote },
): PreparedResult => ({ ...result, call: { ...result.call, ...remote } });

type HookEnd = Awaited<ReturnType<typeof beforeCall>>;

/** The `before` hooks of the call's chain, in its frame with its signal and its spend. */
async function hooksOf(
  site: PrepareSite,
  { call, tool }: PrepareTarget,
  args: Record<string, unknown>,
): Promise<{
  readonly end: HookEnd;
  readonly usage: UsageRecord[];
  readonly remote: ToolCallRemote | undefined;
}> {
  const { state, deps, config, runCtx } = site;
  const usage: UsageRecord[] = [];
  const caller = tool.costCaller ?? `tool:${tool.name}`;
  const signal = callSignalOf(tool, config, runCtx, deps.budgets.exhausted);
  // a service's spend counted the moment it is reported (#338), as the tool's own is
  const reportUsage = (spent: UsageRecord): void => {
    usage.push(...deps.budgets.tally([{ ...spent, caller: callerOfSpend(spent, caller) }]));
  };
  const mesh = toolMeshCallOf(tool, deps.budgets, runCtx.clock.now());
  const keep = (error: unknown): void => {
    keepStopCause(state.runId, call.callId, error);
  };
  const scope = { agent: deps.agent.name, callId: call.callId };
  const end = await inToolCallFrame(
    call.callId,
    { reportUsage, meshCall: mesh.services },
    () => beforeCall(interceptorsOf(deps, tool), tool, args, keep, scope),
    signal.signal,
  ).finally(signal.release);
  return { end, usage, remote: mesh.remote() };
}
