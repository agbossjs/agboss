import type { RagConnector } from "../rag/types.js";
import type { Class } from "../components/injection.js";
import { componentOf } from "../components/metadata.js";
import type { DtoClass } from "../dto/types.js";
import { ModelFailure } from "../models/model-failure.js";
import { seconds, type Milliseconds } from "../units/index.js";
import { millisecondsOf, type ClockDuration } from "./clock.js";
import { TestSetupError } from "./errors.js";
import { questionRoleOf } from "../channels/discovery.js";
import type { QuestionRoleClass } from "../components/decorators.js";
import type { ChannelQuestionOf, ToolNameOf } from "../flow/generated-types.js";
import type {
  AnswerDetails,
  AnswerTurn,
  DecideDetails,
  DecideTurn,
  DecisionDetails,
  FailureTurn,
  ReplyTurn,
  RouteTurn,
  ScriptedAnswer,
  ToolCallTurn,
  ToolCallsTurn,
  WaitTurn,
} from "./turns.js";

/** How a scripted model call fails — the failures a provider's retry policy knows. */
export { ModelFailure };

/**
 * An agent's model answers: with text — `replyWith("3 jobs found", { cost: usd(0.002) })` — or, for
 * an agent with `output`, through the answer tool of a class (#272 S6) — `replyWith(OfferDraftDto,
 * { text: "…" })`, a list output with an array of values. The class and the fields are checked
 * against the agent's generated output by `mockLlm(Agent).thenReturn(…)` (a class outside its
 * `oneOf` does not compile); `{ cost }` is added to the execution's spend.
 */
export function replyWith(text: string, details?: AnswerDetails): ReplyTurn;
export function replyWith<TDto extends DtoClass>(
  dto: TDto,
  value: NoInfer<InstanceType<TDto>>,
  details?: AnswerDetails,
): AnswerTurn<InstanceType<TDto>, false>;
export function replyWith<TDto extends DtoClass>(
  dto: TDto,
  values: readonly NoInfer<InstanceType<TDto>>[],
  details?: AnswerDetails,
): AnswerTurn<InstanceType<TDto>, true>;
export function replyWith(
  textOrDto: string | DtoClass,
  detailsOrValue?: unknown,
  answerDetails: AnswerDetails = {},
): ReplyTurn | AnswerTurn {
  if (typeof textOrDto === "string") {
    // the text overload's second argument is its details
    const details = (detailsOrValue ?? {}) as AnswerDetails;
    return { kind: "reply", text: textOrDto, details };
  }
  return { kind: "answer", dto: textOrDto, value: detailsOrValue, details: answerDetails };
}

/** A tool class, typed by the input its `run` takes. */
export type ToolClass<TInput extends object> = Class<{
  run(input: TInput): Promise<unknown>;
}>;

/** The input a tool's `run` takes: what `callTool(Tool, args)` checks `args` by. */
export type ToolInputOf<TInstance> = TInstance extends {
  run(input: infer TInput extends object): Promise<unknown>;
}
  ? TInput
  : never;

/**
 * The name an agent's model calls a `@Tool` / `@McpTool` class by — a `@Rag`'s search tool too
 * (#703), a question role's name (#712).
 */
export function toolNameOf(tool: Class): string {
  const role = questionRoleOf(tool);
  if (role !== undefined) return role.name;
  const meta = componentOf(tool);
  if (meta?.kind === "rag") return `search-${meta.meta.name}-tool`;
  if (meta?.kind !== "tool" && meta?.kind !== "mcp-tool") {
    throw new TestSetupError(`${tool.name} is not a @Tool, @McpTool, @Rag or question role`);
  }
  return meta.meta.name;
}

/**
 * An agent's model calls a tool: `callTool(SaveShortlist, { jobs: ["Acme"] })` — the arguments are
 * typed by the tool's input DTO (compile time) and validated by the tool when it runs; the turn
 * carries the tool's name, so a tool the agent does not list does not compile (#679).
 */
export function callTool<TTool extends ToolClass<never>>(
  tool: TTool,
  args: NoInfer<ToolInputOf<InstanceType<TTool>>>,
): ToolCallTurn<ToolNameOf<InstanceType<TTool>>>;
/** A knowledge base's search (#703): `callTool(HandbookRag, { query: "on-call" })` — its tool mode. */
export function callTool<TRag extends Class<RagConnector>>(
  rag: TRag,
  args: { readonly query: string },
): ToolCallTurn<SearchToolNameOf<InstanceType<TRag>>>;
/**
 * A question role the agent asks (#712): `callTool(SpendingLimitQuestion, { item, priceUsd })` —
 * the arguments typed by the role's `ask` (the generated `ChannelRoles`), the turn by its name.
 */
export function callTool<TRole extends QuestionRoleClass>(
  role: TRole,
  args: NoInfer<ChannelQuestionOf<InstanceType<TRole>>>,
): ToolCallTurn<ToolNameOf<InstanceType<TRole>>>;
export function callTool(tool: Class, args: object): ToolCallTurn {
  return {
    kind: "tool-call",
    tool: toolNameOf(tool),
    args: Object.fromEntries(Object.entries(args)),
  };
}

/** The search tool a knowledge base gives its agents (#703, #679): `search-<rag>-tool`. */
type SearchToolNameOf<TRag> =
  string extends ToolNameOf<TRag> ? string : `search-${ToolNameOf<TRag>}-tool`;

/**
 * An agent's model calls several tools in one move (#508): `callTools(callTool(ChargeTool, a),
 * callTool(ChargeTool, b))` — each call its own task, at once under `TestConcurrency.Real`; an
 * agent's turn like one call (#679), each of its tools one the agent lists.
 */
export function callTools<const TCalls extends readonly [ToolCallTurn, ...ToolCallTurn[]]>(
  ...calls: TCalls
): ToolCallsTurn<TCalls[number]["tool"]> {
  return { kind: "tool-calls", calls };
}

/**
 * What a model router chose (Q55), checked against the router `mockLlm(R)` scripts: after
 * `.chooseOne(…)` exactly one target — `routeTo(ProfilerAgent)`, `routeTo(ChatWorkflowFinish, {
 * cost })`; before `.toParallelAgents(…)` the `OnDemand` targets it launches — `routeTo()` (only
 * with an `Always` route), `routeTo(CultureScoreAgent)`. A target outside the router's routes, an
 * `Always` target or a wrong count does not compile.
 */
export function routeTo<const TTargets extends readonly Class[]>(
  ...targets: TTargets
): RouteTurn<TTargets>;
export function routeTo<const TTarget extends Class>(
  target: TTarget,
  details: DecisionDetails,
): RouteTurn<readonly [TTarget]>;
export function routeTo(...args: readonly (Class | DecisionDetails)[]): RouteTurn {
  const targets = args.filter((arg): arg is Class => typeof arg === "function");
  const details = args.find((arg): arg is DecisionDetails => typeof arg !== "function") ?? {};
  return { kind: "route", targets, details };
}

/**
 * A decision model answers, by question id — a judge's `judgeModel.decide`, a model arbiter, a
 * router before a launch: `decideWith({ grounded: 0.9, tone: "neutral", quality: 2 }, { cost })`.
 */
export const decideWith = (
  answers: Readonly<Record<string, ScriptedAnswer>>,
  details: DecideDetails = {},
): DecideTurn => ({ kind: "decide", answers, details });

/** The model call fails: `failWith(ModelFailure.Timeout)`. */
export const failWith = (failure: ModelFailure): FailureTurn => ({ kind: "failure", failure });

/**
 * The next turn answers only after this long on the test's clock:
 * `thenReturn(waitFor(seconds(31)), replyWith("late"))` — moved by `clock.advance(…)`, so a
 * deadline or a timeout is reached without real waiting. The execution holds its lease meanwhile:
 * let time pass in steps shorter than the lease (`seconds(10)`) — one advance of 30 s or more is
 * its holder frozen that long, and its lease is over (#534).
 */
export const waitFor = (duration: ClockDuration | Milliseconds): WaitTurn => ({
  kind: "wait",
  delay: seconds(millisecondsOf(duration) / 1000),
});

/** A scripted model failure, as an agent's loop sees it. */
export class ModelCallFailedError extends Error {
  override name = "ModelCallFailedError";
  readonly failure: ModelFailure;

  constructor(failure: ModelFailure, component: string) {
    super(`scripted model failure for ${component}: ${failure}`);
    this.failure = failure;
  }
}
