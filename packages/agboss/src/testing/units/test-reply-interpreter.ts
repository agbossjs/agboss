import type { Class } from "../../components/injection.js";
import { PromptLoader } from "../../components/prompt-render.js";
import {
  channelRoleOf,
  isQuestionRole,
  type FoundChannelRole,
} from "../../channels/channel-role.decorator.js";
import { validDecisionOf } from "../../channels/decision.js";
import type { AssembledReplyInterpreter } from "../../channels/discovery.js";
import { roleInterpreterOf } from "../../channels/role-interpreter.js";
import { readReplyBy } from "../../channels/reply-reader.js";
import { schemaOf, validate } from "../../dto/schema.js";
import type { ExecutionContext } from "../../flow/context/execution-context.js";
import { currentFrame } from "../../flow/context/frame.js";
import type { ChannelAnswerOf, ChannelQuestionOf } from "../../flow/generated-types.js";
import type { TenantContext } from "../../flow/context/tenant-context.js";
import { throwIfViolated } from "../../graph/rule-error.js";
import { PiiPolicySet } from "../../pii/policy-set.js";
import { TestSetupError } from "../errors.js";
import { replyInterpreterKeyOf } from "../scripted-gateway.js";
import { callTimeoutOf, UnitSite } from "./unit-site.js";
import { unitRouterDeps } from "./unit-models.js";
import type { UnitCallOptions, UnitClock, UnitModelOptions, UnitRun } from "./unit-types.js";

/**
 * A role's `@ReplyInterpreter` on its own (#644), as `app.resume({ pauseId, reply })` runs it: the
 * question and the reply in, the role's answer — validated as the role validates a decision — or
 * why the reply is not understood out, never a paused execution.
 */

/** What one reading gave: the role's answer, or — the pause would stay pending — why there is none. */
export type ReplyInterpreterReading<TRole> =
  | { readonly isUnderstood: true; readonly answer: ChannelAnswerOf<TRole> }
  | { readonly isUnderstood: false; readonly reason: string };

/** What one reading takes: the pause's question and the free-text reply. */
export interface ReplyInterpreterRunnerInput<TRole> {
  readonly ask: ChannelQuestionOf<TRole>;
  readonly reply: string;
}

/** One reply read: `await read({ ask, reply: "up to 500" })` → `{ output, spend }`. */
export interface ReplyInterpreterRunner<TRole> extends UnitClock {
  (
    input: ReplyInterpreterRunnerInput<TRole>,
    options?: UnitCallOptions,
  ): Promise<UnitRun<ReplyInterpreterReading<TRole>>>;
}

/** A role and its interpreter. */
interface RoleInterpreter {
  readonly found: FoundChannelRole;
  readonly interpreter: AssembledReplyInterpreter;
}

/** The role and its interpreter, checked as at assembly. */
async function interpreterOfRole(role: Class): Promise<RoleInterpreter> {
  const found = channelRoleOf(role);
  if (found === undefined)
    throw new TestSetupError(`testReplyInterpreter(${role.name}): not a @ChannelRole`);
  const loader = new PromptLoader();
  const { interpreter, violations } = await roleInterpreterOf(found, loader);
  loader.throwIfAny();
  throwIfViolated(violations);
  if (interpreter === undefined)
    throw new TestSetupError(
      `testReplyInterpreter(${role.name}): ${found.options.name} names no replyInterpreter — it is answered with a decision only`,
    );
  return { found, interpreter };
}

/** How the role validates an answer: a question's `answer` DTO, an approval's decision. */
const validatorOf = ({ options }: FoundChannelRole): ((decision: unknown) => unknown) =>
  isQuestionRole(options)
    ? (decision) => validate(options.answer, decision)
    : (decision) => validDecisionOf(decision, { input: schemaOf(options.approves) });

/** One call of a runner, without its clock. */
type ReadReply<TRole> = (
  input: ReplyInterpreterRunnerInput<TRole>,
  options?: UnitCallOptions,
) => Promise<UnitRun<ReplyInterpreterReading<TRole>>>;

/** The runner's calls: each reads one reply by the role's interpreter, in a unit frame. */
function readingsOf<TRole extends Class>(
  role: TRole,
  site: UnitSite,
  ready: Promise<RoleInterpreter>,
): ReadReply<InstanceType<TRole>> {
  return async (
    input: ReplyInterpreterRunnerInput<InstanceType<TRole>>,
    call: UnitCallOptions = {},
  ): Promise<UnitRun<ReplyInterpreterReading<InstanceType<TRole>>>> => {
    const { found, interpreter } = await ready;
    const parts = {
      ...unitRouterDeps(site.gateway),
      interpreters: [interpreter],
      instanceOf: (cls: Class) => site.instanceOf(cls),
    };
    const caller = replyInterpreterKeyOf(interpreter.name);
    const frame = { component: interpreter.interpreter, caller, ...callTimeoutOf(call.timeout) };
    return site.run(frame, async ({ spent }) => {
      const at = currentFrame();
      if (at === undefined) throw new TypeError("a unit call runs in its frame");
      const reading = await readReplyBy(
        interpreter,
        {
          ask: input.ask,
          reply: input.reply,
          label: `testReplyInterpreter(${role.name})`,
          validate: validatorOf(found),
          beforeModelCall: () => Promise.resolve(),
          callbacks: [],
          frame: at,
          pii: { policies: new PiiPolicySet([], ""), known: {} },
        },
        parts,
      );
      spent.push(...reading.usage);
      return reading.kind === "read"
        ? { isUnderstood: true, answer: reading.decision as ChannelAnswerOf<InstanceType<TRole>> }
        : { isUnderstood: false, reason: reading.error.reason };
    });
  };
}

/**
 * `testReplyInterpreter(Role, options)`: the role's interpreter created by its own container (a code
 * one's `deps`, `overrides`, the `environment`), a model one answering from `model` —
 * `replyWith(AnswerDto, { … })` for its answer tool, `replyWith(ReplyInterpreterNotUnderstoodDto,
 * { reason })` for "not understood" (`{ cost }` its spend, `reply-interpreter:<name>`); its rules
 * checked first, as at assembly.
 */
export function testReplyInterpreter<
  TRole extends Class,
  TExecution extends ExecutionContext = ExecutionContext,
  TTenant extends TenantContext = TenantContext,
>(
  role: TRole,
  options: UnitModelOptions<unknown, TExecution, TTenant> = {},
): ReplyInterpreterRunner<InstanceType<TRole>> {
  const site = new UnitSite(options);
  const ready = interpreterOfRole(role).then((assembled) => {
    const { name, model } = assembled.interpreter;
    if (model === undefined && options.model !== undefined)
      throw new TestSetupError(
        `testReplyInterpreter(${role.name}): ${name} is decided by code (DecidedBy.Code) — it calls no model; leave out model`,
      );
    site.scriptModel(replyInterpreterKeyOf(name), name, options.model);
    return assembled;
  });
  // a runner never called reports its setup error at its first call, not as an unhandled rejection
  ready.catch(() => undefined);
  return Object.assign(readingsOf(role, site, ready), { clock: site.clock });
}
