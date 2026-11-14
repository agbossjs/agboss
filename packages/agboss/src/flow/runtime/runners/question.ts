import { redactedDto } from "../../../dto/redact.js";
import { DtoValidationError } from "../../../dto/errors.js";
import { validate } from "../../../dto/schema.js";
import type { GraphDeps } from "../../../graph/deps.js";
import { systemClock } from "../../../infrastructure/clock.js";
import { PauseKind, questionAskOf } from "../../../infrastructure/pause-record.js";
import { NodeKind } from "../../ast.js";
import { currentFrame } from "../../context/frame.js";
import { reportNodeEvent } from "../../observers/execution-event.js";
import { QuestionFailedError } from "../errors.js";
import type { RuntimeNode } from "../graph-model.js";
import type { NodeRunner } from "../node-runner.js";
import { ChannelSendError, pauseStep, type PauseStepSite } from "../pause.js";
import { readInput } from "../scope.js";
import type { BudgetMeter } from "../../../budgets/execution-budgets.js";
import { expiryFailureOf, PauseExpirySignal } from "../pause-expiry-failure.js";
import { ComponentKind } from "../records.js";
import type { ExecutionStateType } from "../state.js";

/** The question's value: the field reads it as `{ producer, value }`, like every input field. */
const questionOf = (field: unknown): unknown =>
  typeof field === "object" && field !== null && "value" in field ? field.value : field;

/** How a question step fails: its channel's `send`, an invalid decision, an expired pause (#941). */
async function failedAsking(
  error: unknown,
  node: RuntimeNode,
  at: { readonly state: ExecutionStateType; readonly budgets: BudgetMeter },
): Promise<never> {
  const question = node.id;
  if (error instanceof ChannelSendError)
    throw new QuestionFailedError({ question, cause: error.cause });
  if (error instanceof DtoValidationError)
    throw new QuestionFailedError({ question, cause: error });
  if (!(error instanceof PauseExpirySignal)) throw error;
  // the run's deadline may have bound it: the budgets' counters read first, as at any visit
  await at.budgets.refresh();
  throw expiryFailureOf(error.pause, {
    step: question,
    stepKind: ComponentKind.Question,
    state: at.state.usage,
    usage: [],
    path: [...at.state.path, question],
    budgets: at.budgets,
  });
}

/**
 * A question role's step (#659): it reads the role's `ask` from the path, asks the role's channel
 * through the pause seam — one pause per visit, recorded by the step's key in its tree before
 * `send` — and gives the role's `answer` as its value. `ChannelOutcome.decided(answer)` goes on at
 * once; `awaitReply()` stops the step at LangGraph's `interrupt()` until `app.resume` records an
 * answer, validated as the `answer` DTO (a reply read by the role's interpreter). On resume the
 * step runs again, finds its record answered and goes on with it — its channel is never asked
 * twice. Its holder's fence is checked before its channel is asked: a holder past its lease asks
 * nothing (a hand-over). A `send` that throws, or a `decided(…)` answer that is not valid, fails
 * the step as `QuestionFailedError`.
 */
export function questionRunner(
  node: RuntimeNode,
  deps: GraphDeps<string>,
  budgets: BudgetMeter,
): NodeRunner {
  const { declaration } = node;
  if (declaration.kind !== NodeKind.Question) throw new TypeError(`${node.id} is not a question`);
  const { output: answer, role } = declaration.options;
  const answered = (decision: unknown): unknown => validate(answer, decision);
  return async (state, config) => {
    const input = readInput(deps.graph, node, state);
    const frame = currentFrame();
    const { pause, channelOf } = deps;
    if (pause === undefined || channelOf === undefined || frame === undefined)
      throw new TypeError(`${node.id}: a question is asked only inside its application`);
    // the question as the channel, the records and the events see it: `sensitive` fields masked
    const ask = questionAskOf(redactedDto(role.ask, questionOf(input.fields.ask)));
    const onSend = (): Promise<void> =>
      reportNodeEvent((base) =>
        deps.observer?.onChannelStart({ ...base, name: role.name, input: ask }),
      );
    const site: PauseStepSite = {
      pauses: pause.pauses,
      answers: pause.answers,
      channel: channelOf(role.name),
      frame,
      signal: config?.signal,
      clock: deps.clock ?? systemClock,
      validate: answered,
      onSend,
      notices: pause.notices,
    };
    frame.execution.lease?.assertHeld();
    const asked = {
      kind: PauseKind.Question,
      step: node.id,
      ask,
      ...(node.expiresIn === undefined ? {} : { expiresIn: node.expiresIn }),
    };
    const reply = await pauseStep(site, asked).catch((error: unknown) =>
      failedAsking(error, node, { state, budgets }),
    );
    await reportNodeEvent((base) =>
      deps.observer?.onChannelEnd({ ...base, name: role.name, update: reply.decision }),
    );
    return { value: { value: answered(reply.decision) }, read: input.read, usage: reply.usage };
  };
}
