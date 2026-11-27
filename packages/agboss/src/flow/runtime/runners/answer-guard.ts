import { GuardrailSide } from "../../../components/policy-decorators.js";
import { bareRecordOf, ComponentKind } from "../records.js";
import type { AnswerFileReading } from "../../../files/file-runtime.js";
import { fileMaskOf, type FileMask } from "../../../files/file-mask.js";
import { guardedFilesOf } from "../../../files/guarded-files.js";
import { lazyLoad } from "../../../infrastructure/clock.js";
import type { UsageRecord } from "../../../finops/usage.js";
import type { LoopPii, LoopResult } from "../../../graph/agent-loop/runner.js";
import type { GraphDeps } from "../../../graph/deps.js";
import type { GuardedFile } from "../../../guardrails/guarded-text.js";
import { runGuardrails, type GuardrailsPassed } from "../../../guardrails/runtime.js";
import { maskedModelText } from "../../../pii/model-boundary.js";
import type { PiiPolicySet } from "../../../pii/policy-set.js";
import type { PiiTokenMap } from "../../../pii/tokens.js";
import { CarriedOrder, carryRecords } from "../carried-records.js";
import type { ExecutionStateType } from "../state.js";

/** What the output guardrails read of an answer: where its files are read from, and the state it was made in. */
export interface AnswerGuardContext {
  readonly reading: AnswerFileReading | undefined;
  readonly state: ExecutionStateType;
}

/**
 * The files of the agent's answer in the views its model read them (#899 §8): read through the guarded path
 * (a file it saw by number — its descriptor carries the digest it was seen with, so a file that changed since fails closed, #899 §3 — a url or a stored file of a model-written descriptor), its transcription from the
 * execution's cache or made under the agent's policies. The same file twice is shown once.
 */
export async function answerFilesViewed(
  name: string,
  result: Pick<LoopResult, "answerFiles" | "fileTranscripts" | "usage">,
  context: AnswerGuardContext & { readonly mask: FileMask | undefined },
): Promise<{ readonly files: readonly GuardedFile[]; readonly usage: readonly UsageRecord[] }> {
  const runtime = context.reading?.runtime;
  const unique = new Map(
    result.answerFiles.map((file) => [
      `${file.fileId ?? ""}|${file.url ?? ""}|${file.sha256 ?? ""}`,
      file,
    ]),
  );
  if (runtime === undefined || unique.size === 0) return { files: [], usage: [] };
  const sources = [...unique.values()].map((descriptor, index) => ({
    descriptor,
    field: `answer file ${String(index + 1)}`,
    producer: "the agent's answer",
  }));
  const { filePiecesOf } = await lazyLoad(import("../../../files/visit-files.js"));
  const built = await filePiecesOf({
    runtime,
    files: sources,
    tally: { count: 0, bytes: 0 },
    cache: result.fileTranscripts,
    first: 1,
    of: sources.length,
    mask: context.mask,
    beforeModelCall: () => {
      const { state } = context;
      // Stryker disable next-line OptionalChaining: the files are read only with the reading's runtime, so a reading is there
      context.reading?.budgets.check(state.usage, [...state.path, name], result.usage);
    },
  });
  const guarded = await guardedFilesOf(built.viewed, runtime.maxResultSize, context.mask);
  return { files: guarded.files, usage: [...built.usage, ...guarded.usage] };
}

/** What the output checks of an answer found: their usage and decisions, and the text they read. */
export interface GuardedAnswer extends GuardrailsPassed {
  /**
   * The answer as the guardrails read it, when the agent's PII policies changed it: a held stream
   * goes out as this text, never as the model's own tokens (#1311b). None: nothing was changed.
   */
  readonly text?: string;
}

/**
 * An agent with no output guardrail but a PII block rule holds its stream back: its answer is read
 * through its policies for the stream alone, which goes out masked (#1311b). No policy, no read.
 */
async function maskedForStream(
  set: Parameters<typeof maskedModelText>[0],
  reply: string,
  tokens: PiiTokenMap,
): Promise<GuardedAnswer> {
  const masked = await maskedModelText(set, reply, tokens);
  return {
    usage: masked.usage,
    decisions: [],
    ...(masked.text === reply ? {} : { text: masked.text }),
  };
}

/**
 * The agent's output guardrails (#120) on its answer — its text, or its answer's JSON with its files shown as
 * metadata — masked by its PII policies as its model would read it, and the files of the answer in the views
 * its model read (#899 §8): their spend (a block fails the execution).
 */
export async function guardedAnswer(
  name: string,
  result: LoopResult,
  pii: { readonly loop: LoopPii; readonly tokens: PiiTokenMap },
  deps: GraphDeps<string>,
  files: AnswerGuardContext,
): Promise<GuardedAnswer> {
  const guardrails = deps.guardrails?.outputOf(name) ?? [];
  const policies = deps.pii?.policiesOf(name);
  const keyed = (own: PiiPolicySet): PiiPolicySet =>
    own.withValues(pii.loop.values).withFieldKey(pii.loop.key);
  const set = policies === undefined ? undefined : keyed(policies);
  if (guardrails.length === 0) {
    return policies?.blocks === true
      ? await maskedForStream(keyed(policies), result.reply, pii.tokens)
      : { usage: [], decisions: [] };
  }
  const masked =
    set === undefined
      ? { text: result.reply, usage: [] }
      : await maskedModelText(set, result.reply, pii.tokens);
  const viewed = await answerFilesViewed(name, result, {
    ...files,
    mask: fileMaskOf(set, pii.tokens),
  });
  const checked = {
    text: masked.text,
    component: bareRecordOf(name, ComponentKind.Agent),
    side: GuardrailSide.Output,
    files: viewed.files,
  };
  const passed = await runGuardrails(guardrails, checked, deps.observer).catch((error: unknown) => {
    // an output guardrail blocked the answer: the visit's records go with its failure (#395 S6)
    const { toolCalls, judgeVerdicts, guardrailDecisions } = result;
    carryRecords(error, { toolCalls, judgeVerdicts, guardrailDecisions }, CarriedOrder.Before);
    throw error;
  });
  return {
    usage: [...masked.usage, ...viewed.usage, ...passed.usage],
    decisions: passed.decisions,
    ...(masked.text === result.reply ? {} : { text: masked.text }),
  };
}
