import { ValidationError } from "../../core/error-families/effect-errors.js";
import { handedOverOf, recordedHandOver } from "../../app/handed-over.js";
import { HandOverSite } from "../../infrastructure/execution-audit-log.repository.js";
import { pathOf, invalidDto } from "../../dto/errors.js";
import { bareRecordOf, ComponentKind } from "../../flow/runtime/records.js";
import type { Class } from "../../components/injection.js";
import { componentOf } from "../../components/metadata.js";
import { validate } from "../../dto/schema.js";
import type { DtoClass } from "../../dto/types.js";
import {
  decisionInputOf,
  decisionTextOf,
  isToolCallDecision,
  outcomeOf,
  ToolCallOutcome,
  withToolType,
  type ToolCallContext,
  type ToolCallDecision,
} from "../../tool-interceptors/decision.js";
import type { RuntimeToolInterceptor } from "../../tool-interceptors/runtime.js";
import type { AnyTool } from "../../tools/index.js";
import type { Before, InterceptedCallScope } from "./tool-interception.js";
import { ToolCallStopKind } from "./tool-stops.js";

/**
 * The hooks of one call's interceptor chain (#384, #1295): `before` in list order, `after` in reverse.
 */
export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A failure of one interceptor: what the step's error carries. */
export class InterceptorFailure extends Error {
  override name = "InterceptorFailure";

  constructor(
    readonly interceptor: string,
    readonly error: unknown,
  ) {
    super(messageOf(error));
  }
}

/** One interceptor's method, its failure wrapped with its name. */
async function called(interceptor: RuntimeToolInterceptor, work: () => unknown): Promise<unknown> {
  try {
    return await work();
  } catch (error) {
    // a fenced write of an interceptor (#471) is a hand-over, never the interceptor's failure
    const handedOver = handedOverOf(error, undefined);
    if (handedOver !== undefined) throw recordedHandOver(handedOver, HandOverSite.ToolInterceptor);
    throw new InterceptorFailure(interceptor.name, error);
  }
}

/** The tool a chain is for, as its DTOs: what a target-bound method is given hydrated. */
export interface CallSite {
  readonly tool: AnyTool;
  readonly scope: InterceptedCallScope;
  readonly type: Class | undefined;
}

const dtosOf = (type: Class | undefined): { input?: DtoClass; output?: DtoClass } => {
  const component = type === undefined ? undefined : componentOf(type);
  return component?.kind === "tool"
    ? { input: component.meta.input, output: component.meta.output }
    : {};
};

/** The context a catch-all hook reads. */
const contextOf = (site: CallSite, input: unknown): ToolCallContext =>
  withToolType(
    {
      tool: bareRecordOf(site.tool.name, ComponentKind.Tool),
      agent: bareRecordOf(site.scope.agent, ComponentKind.Agent),
      callId: site.scope.callId,
      input,
    },
    site.type,
  );

/** A DTO instance of valid raw data; none when it is not valid. */
function hydrated(
  dto: DtoClass | undefined,
  raw: unknown,
): { readonly value: unknown } | undefined {
  if (dto === undefined) return { value: raw };
  try {
    return { value: validate(dto, raw) };
  } catch (error) {
    if (error instanceof ValidationError.DtoInvalid) return undefined;
    throw error;
  }
}

/** The method of an instance by name. */
const methodOf = (instance: object, name: string): ((...args: unknown[]) => unknown) =>
  (Reflect.get(instance, name) as (...args: unknown[]) => unknown).bind(instance);

/** What a before hook decided, read: a decision, or the failure of an interceptor that gave none. */
function decisionOf(
  interceptor: RuntimeToolInterceptor,
  hook: string,
  decision: unknown,
): ToolCallDecision<unknown> {
  if (isToolCallDecision(decision)) return decision;
  throw new InterceptorFailure(
    interceptor.name,
    new TypeError(
      `${hook} returned no ToolCallDecision — return ToolCallDecision.allow(), .allow({ input }), .reply(message) or .block(reason)`,
    ),
  );
}

/** The decision's end of the chain, if it is one; an `allow({ input })` is read by the caller. */
function endOf(interceptor: RuntimeToolInterceptor, decision: ToolCallDecision<unknown>) {
  const outcome = outcomeOf(decision);
  if (outcome === ToolCallOutcome.Reply)
    return { kind: "replied", message: decisionTextOf(decision) } as const;
  if (outcome === ToolCallOutcome.Block) {
    const stop = { kind: ToolCallStopKind.Blocked, interceptor: interceptor.name };
    return { kind: "stopped", stop: { ...stop, reason: decisionTextOf(decision) } } as const;
  }
  return undefined;
}

/** The arguments an `allow({ input })` gives, validated against the tool's input again. */
function rewritten(
  interceptor: RuntimeToolInterceptor,
  site: CallSite,
  decision: ToolCallDecision<unknown>,
  current: unknown,
): unknown {
  const given = decisionInputOf(decision);
  if (given === undefined) return current;
  const parsed = site.tool.input.safeParse(given.value);
  if (parsed.success) return given.value;
  const issues = parsed.error.issues.map((issue) => ({
    path: pathOf(issue.path),
    reason: issue.message,
  }));
  throw new InterceptorFailure(
    interceptor.name,
    invalidDto({ dto: `${site.tool.name} input from a before hook`, issues }),
  );
}

/** The `before` hooks, outer first, `beforeAnyTool` before the tool's own method. */
export async function before(
  chain: readonly RuntimeToolInterceptor[],
  site: CallSite,
  input: unknown,
): Promise<Before> {
  const { input: inputDto } = dtosOf(site.type);
  let current = input;
  for (const interceptor of chain) {
    const hooks: { name: string; run: () => unknown }[] = [];
    if (interceptor.instance.beforeAnyTool !== undefined) {
      const any = methodOf(interceptor.instance, "beforeAnyTool");
      hooks.push({ name: "beforeAnyTool", run: () => any(contextOf(site, current)) });
    }
    if (interceptor.beforeMethod !== undefined) {
      const name = interceptor.beforeMethod;
      const own = methodOf(interceptor.instance, name);
      hooks.push({
        name,
        run: () => {
          // a method taking no input runs before the validation; one taking it is given the DTO
          if (own.length === 0) return own();
          const dto = hydrated(inputDto, current);
          // invalid arguments go the tool's own way: the model reads the invalid-input error
          return dto === undefined ? SKIPPED : own(dto.value);
        },
      });
    }
    for (const hook of hooks) {
      const produced = await called(interceptor, hook.run);
      if (produced === SKIPPED) continue;
      const decision = decisionOf(interceptor, hook.name, produced);
      const ended = endOf(interceptor, decision);
      if (ended !== undefined) return { ended };
      current = rewritten(interceptor, site, decision, current);
    }
  }
  return { input: current };
}

const SKIPPED = Symbol("skipped");

/** The output a hook gave, validated against the tool's output. */
function validOutput(interceptor: RuntimeToolInterceptor, site: CallSite, produced: unknown) {
  const parsed = site.tool.output.safeParse(produced);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((issue) => ({
    path: pathOf(issue.path),
    reason: issue.message,
  }));
  throw new InterceptorFailure(
    interceptor.name,
    invalidDto({ dto: `${site.tool.name} output from an after hook`, issues }),
  );
}

/** The `after` hooks, inner first, the tool's own method before `afterAnyTool`. */
export async function after(
  chain: readonly RuntimeToolInterceptor[],
  site: CallSite,
  input: unknown,
  output: unknown,
): Promise<unknown> {
  const dtos = dtosOf(site.type);
  let current = output;
  for (const interceptor of [...chain].reverse()) {
    if (interceptor.afterMethod !== undefined) {
      const own = methodOf(interceptor.instance, interceptor.afterMethod);
      const given = hydrated(dtos.output, current);
      const seen = hydrated(dtos.input, input);
      if (given === undefined || seen === undefined)
        throw new InterceptorFailure(
          interceptor.name,
          new TypeError(`${site.tool.name}: its input or output does not fit its DTO`),
        );
      const produced = await called(interceptor, () => own(given.value, seen.value));
      current = validOutput(interceptor, site, produced);
    }
    if (interceptor.instance.afterAnyTool !== undefined) {
      const any = methodOf(interceptor.instance, "afterAnyTool");
      const call = { ...contextOf(site, input), output: current };
      const produced = await called(interceptor, () => any(withToolType(call, site.type)));
      current = validOutput(interceptor, site, produced);
    }
  }
  return current;
}
