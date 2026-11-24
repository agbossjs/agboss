import type { MessageContent } from "@langchain/core/messages";
import type { Class } from "../../components/injection.js";
import { PromptLoader } from "../../components/prompt-render.js";
import { loadedMemoryOf } from "../../memory/assembly.js";
import { memoryViolations } from "../../memory/checks.js";
import {
  CompactionStrategy,
  memoryMetaOf,
  modeOf,
  WINDOW_ONLY,
  CUSTOM_COMPACTION,
  type CompactionInput,
  type MemoryCompaction,
  type MemoryMeta,
} from "../../memory/memory.decorator.js";
import { memoryError } from "../../memory/memory-error.js";
import type { ModelCompactionInUse } from "../../memory/plan.js";
import type { ModelBinding } from "../../llm/registry.js";
import { TokenLimit } from "../../config/types.js";
import { DEFAULT_MODEL_ALIAS } from "../../models/model-cascade.js";
import type { ExecutionContext } from "../../flow/context/execution-context.js";
import type { TenantContext } from "../../flow/context/tenant-context.js";
import { finishLine, startLine } from "../../flow/runtime/history.js";
import type { UsageRecord } from "../../finops/usage.js";
import { throwIfViolated } from "../../graph/rule-error.js";
import { summaryInputTextOf, summaryOf, type CompactionRun } from "../../run/compaction.js";
import { compactedBy } from "../../run/custom-compaction.js";
import { TestSetupError } from "../errors.js";
import { compactionKeyOf } from "../scripted-gateway.js";
import { callTimeoutOf, UnitSite, type UnitFrame } from "./unit-site.js";
import { unitChatSettings } from "./unit-models.js";
import type { UnitCallOptions, UnitClock, UnitModelOptions, UnitRun } from "./unit-types.js";

/** One call of a compaction's model, as it was sent: its instructions and its input message. */
export interface CompactionRequest {
  readonly instructions: string;
  readonly input: string;
}

/** What one compaction gave: the summaries readers see from now on, and what its model was sent. */
export interface CompactionResult {
  /** The summaries a reader sees after this compaction, oldest first. */
  readonly summaries: readonly string[];
  /**
   * Each call of its model, in order — one, or two when the first summary was cut at
   * `summaryMaxTokens` and it was asked to be shorter; none for `CompactionStrategy.Custom`.
   */
  readonly requests: readonly CompactionRequest[];
}

/** One compaction on its input: `await compact({ previousSummaries, turnsToCompact })`. */
export interface CompactionRunner extends UnitClock {
  (input: CompactionInput, options?: UnitCallOptions): Promise<UnitRun<CompactionResult>>;
}

/** The memory's record, its rules checked; a window-only memory writes nothing, so there is nothing to run. */
function checkedMetaOf(compaction: Class, options: Pick<UnitModelOptions, "model">): MemoryMeta {
  const meta = memoryMetaOf(compaction);
  if (meta === undefined)
    throw new TestSetupError({ message: `testCompaction(${compaction.name}): not a @Memory` });
  throwIfViolated(memoryViolations([compaction]));
  const mode = modeOf(compaction, meta);
  if (mode === WINDOW_ONLY)
    throw new TestSetupError({
      message: `testCompaction(${compaction.name}): ${meta.name} has no compaction and no compact() — it writes no summaries`,
    });
  if (mode === CUSTOM_COMPACTION && options.model !== undefined)
    throw new TestSetupError({
      message: `testCompaction(${compaction.name}): ${meta.name} compacts in code — its compact() calls no model; leave out model`,
    });
  return meta;
}

/** The turns as the compaction's model reads them: `start <name>: <json>` / `finish <name>: <json>`. */
const turnsTextOf = (input: CompactionInput): string =>
  input.turnsToCompact
    .map((turn) => `${startLine(turn.start, turn.input)}\n${finishLine(turn.finish, turn.output)}`)
    .join("\n\n");

/** The summaries after a model's compaction: a queue keeps the latest, a single summary is replaced. */
function summariesAfter(
  compaction: ModelCompactionInUse,
  input: CompactionInput,
  summary: string,
): readonly string[] {
  if (compaction.strategy === CompactionStrategy.SingleSummary) return [summary];
  return [...input.previousSummaries, summary].slice(-compaction.summaryQueueLength);
}

/** A model strategy as it runs: its loaded prompt, its queue, its token limit. */
async function inUseOf(
  compaction: Class,
  meta: MemoryMeta,
  declared: MemoryCompaction,
): Promise<ModelCompactionInUse> {
  const loader = new PromptLoader();
  const loaded = await loadedMemoryOf(compaction, loader);
  loader.throwIfAny();
  return {
    name: meta.name,
    strategy: declared.strategy,
    prompt: loaded?.prompt ?? "",
    window: 0,
    turnsBetweenCompactions: meta.turnsBetweenCompactions ?? 1,
    summaryQueueLength: declared.summaryQueueLength ?? 1,
    summaryMaxTokens: declared.summaryMaxTokens ?? TokenLimit.ModelMax,
  };
}

/** The compaction's chat model on the runner's script, its `max_tokens` the summary's limit. */
function bindingOf(site: UnitSite, inUse: ModelCompactionInUse, model: string): ModelBinding {
  const base = unitChatSettings(model);
  const settings =
    inUse.summaryMaxTokens === TokenLimit.ModelMax
      ? base
      : { ...base, maxTokens: inUse.summaryMaxTokens };
  const user = { kind: "compaction", compaction: inUse.name } as const;
  return { model: site.gateway.chatModel({ user, settings }), settings };
}

/** A run of the summary's calls outside a thread: its spend is the unit call's. */
const unitRunOf = (spent: UsageRecord[]): CompactionRun => ({
  tenantId: "",
  threadId: "",
  budgetLeftUsd: undefined,
  budgetLeftTokens: undefined,
  callbacks: [],
  tokens: {},
  inFrame: (work) => work(),
  record: (records) => {
    spent.push(...records);
    return Promise.resolve();
  },
});

/** An input message as text: a compaction's is one text part. */
const textOf = (content: MessageContent): string =>
  typeof content === "string" ? content : JSON.stringify(content);

/** The chat requests the script took since `from`, as the model got them. */
const requestsSince = (site: UnitSite, key: string, from: number): CompactionRequest[] =>
  site.book
    .scriptOf(key)
    .requests.slice(from)
    .flatMap((request) =>
      request.kind === "chat"
        ? [{ instructions: request.system, input: textOf(request.input) }]
        : [],
    );

/** One model compaction: the request built, the summary written (a cut one asked once more). */
async function modelCompaction(
  site: UnitSite,
  frame: UnitFrame,
  inUse: ModelCompactionInUse,
  binding: ModelBinding,
  input: CompactionInput,
): Promise<UnitRun<CompactionResult>> {
  const key = compactionKeyOf(inUse.name);
  const current = input.previousSummaries.at(-1);
  const text = summaryInputTextOf(inUse.strategy, {
    ...(current === undefined ? {} : { current }),
    earlier: "",
    due: turnsTextOf(input),
  });
  const from = site.book.scriptOf(key).requests.length;
  return site.run(frame, async ({ spent }) => {
    const written = (await summaryOf(binding, inUse, text, unitRunOf(spent))).text.trim();
    if (written === "") {
      const message = `${inUse.name}: the model wrote an empty summary`;
      throw memoryError({
        message,
        memory: inUse.name,
        summaryMaxTokens: inUse.summaryMaxTokens,
      });
    }
    const summaries = summariesAfter(inUse, input, written);
    return { summaries, requests: requestsSince(site, key, from) };
  });
}

/**
 * A `@Memory`'s compaction on its own (#395 PR 5, S2 Q4, #1303): its rules checked first, then one compaction of
 * `{ previousSummaries, turnsToCompact }` — the request its model is sent and the plumbing around
 * it, not whether a fact survives (that is an eval case, #396). A model strategy
 * (`SummaryQueue`, `SingleSummary`) writes its summary on the model scripted by `model`
 * (`replyWith("…")`, `{ truncated: true }` for a summary cut at `summaryMaxTokens`, `{ cost }` for
 * its spend `memory:<name>`): the request carries the turns as a reader's memory renders them —
 * a single summary its current one (the last of `previousSummaries`), a queue the turns only (the
 * earlier turns it reads as context at run time are not part of the input) —, a cut summary is
 * asked once more, shorter, then `StepError.Memory`, and `summaries` is what readers see next (a
 * queue the latest `summaryQueueLength`). A code compaction (a class with `compact(input)`, #382) runs its class's
 * `compact(input)` — created by the runner's container (`deps`, `overrides`, `environment`), in a
 * step's frame — no `model` (a `TestSetupError`), its answer checked as at run time. No PII
 * policies apply: the input is what the compaction reads.
 */
export function testCompaction<
  TExecution extends ExecutionContext = ExecutionContext,
  TTenant extends TenantContext = TenantContext,
>(
  compaction: Class,
  options: UnitModelOptions<unknown, TExecution, TTenant> = {},
): CompactionRunner {
  const meta = checkedMetaOf(compaction, options);
  const key = compactionKeyOf(meta.name);
  const site = new UnitSite(options);
  site.scriptModel(key, compaction.name, options.model);
  let model: Promise<{ inUse: ModelCompactionInUse; binding: ModelBinding }> | undefined;
  const run = async (
    input: CompactionInput,
    call: UnitCallOptions = {},
  ): Promise<UnitRun<CompactionResult>> => {
    const frame = { component: compaction, caller: key, ...callTimeoutOf(call.timeout) };
    const declared = meta.compaction;
    if (declared === undefined) {
      return site.run(frame, async () => {
        const handler = site.instanceOf(compaction);
        const summaries = await compactedBy(handler, meta.name, (work) => work(), input);
        return { summaries, requests: [] };
      });
    }
    model ??= inUseOf(compaction, meta, declared).then((inUse) => ({
      inUse,
      binding: bindingOf(site, inUse, declared.model ?? DEFAULT_MODEL_ALIAS),
    }));
    const { inUse, binding } = await model;
    return modelCompaction(site, frame, inUse, binding, input);
  };
  return Object.assign(run, { clock: site.clock });
}
