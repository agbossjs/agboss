import type {
  CompactionHandler,
  CompactionInput,
  CompactionTurn,
} from "../compaction/compaction.decorator.js";
import { CompactionError } from "../compaction/errors.js";
import type { CustomCompactionInUse } from "../compaction/plan.js";
import { summaryTextsOf } from "../compaction/stored-summaries.js";
import type { UsageRecord } from "../finops/usage.js";
import { mappedStringsAsync } from "../pii/strings.js";
import { revealedText, type PiiTokenMap } from "../pii/tokens.js";
import type { Tern } from "../terns/index.js";
import { maskedTextOf, storedCompaction } from "./compaction-parts.js";
import type { CompactedOne, CompactionRun } from "./compaction.js";
import type { AgentExecutionDeps } from "./types.js";

/**
 * A custom compaction at run time (#382): when its turns are due — counted as a model's are — its
 * class's `compact()` (created by the container, run in the frame of the execution's start) gets
 * the summaries readers see now and the turns due, both through the application's and the
 * workflow's PII policies (S84 i), and gives the summaries readers see from now on. They are revealed
 * and stored as one record — the whole list, covering the thread from its first compacted turn — so
 * the next `compact()` reads them back as `previousSummaries`. A `compact()` that throws, or gives
 * no summary or an empty one, is `CompactionError`: the new execution fails before any of its work.
 */

/** `start <name>: <json>` / `finish <name>: <json>` (#272 S8): the component and its value. */
const LINE = /^(?:start|finish) (\S+): (.*)$/su;

/** A line's component and value; a line that is not one is its own value. */
function partsOf(line: string): { readonly name: string; readonly value: unknown } {
  const match = LINE.exec(line);
  if (match === null) return { name: "", value: line };
  const [, name = "", json = ""] = match;
  try {
    return { name, value: JSON.parse(json) as unknown };
  } catch {
    return { name, value: json };
  }
}

/** A turn of the thread as `compact()` reads it. */
function turnOf(tern: Tern): CompactionTurn {
  const start = partsOf(tern.task);
  const finish = partsOf(tern.replyWith);
  return {
    startName: start.name,
    input: start.value,
    finishName: finish.name,
    output: finish.value,
  };
}

/** What `compact()` reads, masked, and the tokens and spend of masking it. */
interface MaskedInput {
  readonly input: CompactionInput;
  readonly tokens: PiiTokenMap;
  readonly usage: readonly UsageRecord[];
}

/** Every text of the input through the policies, one after the other (each may call a model). */
async function maskedInputOf<TName extends string>(
  deps: AgentExecutionDeps<TName>,
  input: CompactionInput,
  run: CompactionRun,
): Promise<MaskedInput> {
  let tokens = run.tokens;
  const usage: UsageRecord[] = [];
  const mask = async (text: string): Promise<string> => {
    const masked = await maskedTextOf(deps, text, run, tokens);
    tokens = masked.tokens;
    usage.push(...masked.usage);
    return masked.text;
  };
  const previousSummaries: string[] = [];
  for (const summary of input.previousSummaries) previousSummaries.push(await mask(summary));
  const turnsToCompact: CompactionTurn[] = [];
  for (const turn of input.turnsToCompact) {
    const value = await mappedStringsAsync(turn.input, mask);
    const output = await mappedStringsAsync(turn.output, mask);
    turnsToCompact.push({ ...turn, input: value, output });
  }
  return { input: { previousSummaries, turnsToCompact }, tokens, usage };
}

const isHandler = (value: unknown): value is CompactionHandler =>
  typeof value === "object" &&
  value !== null &&
  "compact" in value &&
  typeof value.compact === "function";

/** What `compact()` gave, checked: a non-empty list of non-empty texts. */
function checkedSummaries(name: string, given: unknown): readonly string[] {
  const isList = Array.isArray(given) && given.length > 0;
  const texts: readonly unknown[] = isList ? given : [];
  if (texts.length === 0 || texts.some((text) => typeof text !== "string" || text.trim() === "")) {
    const message = `${name}: compact() gave no summaries or an empty one — it gives the summaries readers see`;
    throw new CompactionError(message, name, undefined);
  }
  return texts.map((text) => String(text).trim());
}

/** `compact()` in the frame of the execution's start; a failure is `CompactionError` with its cause. */
async function compacted<TName extends string>(
  deps: AgentExecutionDeps<TName>,
  compaction: CustomCompactionInUse,
  run: CompactionRun,
  input: CompactionInput,
): Promise<readonly string[]> {
  const handler: unknown = deps.container.get(compaction.type);
  try {
    if (!isHandler(handler)) throw new TypeError(`${compaction.type.name} has no compact(input)`);
    const given: unknown = await run.inFrame(() => Promise.resolve(handler.compact(input)));
    return checkedSummaries(compaction.name, given);
  } catch (error) {
    if (error instanceof CompactionError) throw error;
    const message = `${compaction.name}: compact() failed`;
    throw new CompactionError(message, compaction.name, undefined, error);
  }
}

/** A custom compaction of the records due: its summaries stored as one record, revealed. */
export async function compactWithHandler<TName extends string>(
  deps: AgentExecutionDeps<TName>,
  compaction: CustomCompactionInUse,
  run: CompactionRun,
  due: readonly Tern[],
): Promise<CompactedOne> {
  const { tenantId, threadId } = run;
  const [current] = await deps.terns.latestSummaries(tenantId, threadId, compaction.name, 1);
  const input: CompactionInput = {
    previousSummaries: current === undefined ? [] : summaryTextsOf(current.text),
    turnsToCompact: due.map(turnOf),
  };
  const masked = await maskedInputOf(deps, input, run);
  const given = await compacted(deps, compaction, run, masked.input);
  const summaries = given.map((text) => revealedText(text, masked.tokens).text);
  const stored = await storedCompaction(deps, run, {
    compaction: compaction.name,
    due,
    current,
    text: JSON.stringify(summaries),
    costUsd: 0,
    summaries: summaries.length,
    summaryQueueLength: summaries.length,
  });
  return stored === undefined
    ? { usage: masked.usage }
    : { usage: masked.usage, compacted: stored };
}
