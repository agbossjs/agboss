import type { UsageRecord } from "../../finops/usage.js";
import { scrubbedFilesOfDto } from "../../a2a/files/a2a-file-scrub.js";
import { dtoOf, maskedDtoValue } from "../../dto/redact.js";
import { tokenFieldMask } from "../../pii/field-masks.js";
import { PiiRefusedError } from "../../pii/errors.js";
import type { PiiFinding } from "../../pii/masking.js";
import { errorRecordOf, type ErrorRecord } from "../../core/error-record.js";
import type { PiiPolicySet } from "../../pii/policy-set.js";
import { DetectionMode } from "../../pii/runtime-policy.js";
import { asRecord, mappedStringsAsync } from "../../pii/strings.js";
import type { PiiTokenMap } from "../../pii/tokens.js";
import { renderToolResult, type AnyTool, type ToolOutput } from "../../tools/index.js";
import type { Bytes } from "../../units/index.js";
import type { BoundedText } from "./tool-result-size.js";
import { lazyLoad } from "../../infrastructure/clock.js";
import { modelReadingMaskOf, withModelReading } from "../../pii/model-boundary.js";
import type { AgentLoopDeps } from "./deps.js";
import type { ToolTask } from "./state.js";

/**
 * PII in the tool task (#120 AC9): the arguments the model gave were revealed when its move was
 * read, so the tool gets real values; a block rule's kind in them rejects the call before `execute`.
 * Just after `execute` the result is closed: its `sensitive` fields through their actions, its text
 * through the policies — a block rule's kind in it rejects the call; the masked form is kept for
 * the model (the loop's `piiMasked`), the checkpoint keeps the result as it was.
 */

/** What blocks a call: the text the model reads instead of a result. */
export const refusedCall = (refusal: string): string =>
  `Tool error: the call was refused${refusal === "" ? "" : `: ${refusal}`}`;

/** What a call's arguments are, searched by the policies (#1295c). */
export interface ScreenedArguments {
  /** The arguments with every string masked: what an approver may see. */
  readonly masked: Record<string, unknown>;
  /** The findings of block rules. */
  readonly blocked: readonly PiiFinding[];
  /** The tokens the masking made. */
  readonly tokens: PiiTokenMap;
  readonly usage: readonly UsageRecord[];
}

/**
 * Every string of a call's arguments searched, one after the other: the masked copy, the findings
 * of block rules, the tokens and the spend. No policy: the arguments as they are.
 */
export async function screenedArguments(
  set: PiiPolicySet | undefined,
  args: Readonly<Record<string, unknown>>,
  known: PiiTokenMap,
): Promise<ScreenedArguments> {
  if (set === undefined || set.isEmpty)
    return { masked: { ...args }, blocked: [], tokens: {}, usage: [] };
  const blocked: PiiFinding[] = [];
  const usage: UsageRecord[] = [];
  let tokens: PiiTokenMap = {};
  const masked = await mappedStringsAsync(args, async (text) => {
    const search = await set.mask(text, { ...known, ...tokens }, DetectionMode.WithModel);
    blocked.push(...search.masked.blocked);
    usage.push(...search.usage);
    tokens = { ...tokens, ...search.masked.tokens };
    return search.masked.text;
  });
  return { masked: asRecord(masked), blocked, tokens, usage };
}

/** What refuses a call before it runs: the text the model reads and the error behind it. */
export interface ArgumentsRefusal {
  readonly content: string;
  readonly refusal: PiiRefusedError;
}

/** The refusal of a call whose arguments hold a blocked kind; none when it may run. */
export async function argumentsRefusalOf(
  set: PiiPolicySet | undefined,
  screened: Pick<ScreenedArguments, "blocked" | "usage">,
): Promise<ArgumentsRefusal | undefined> {
  if (set === undefined) return undefined;
  const refused = await set.refusalError(screened.blocked, screened.usage);
  return refused === undefined
    ? undefined
    : { content: refusedCall(refused.refusal), refusal: refused };
}

/** A tool's result as the loop keeps it, its masked form and the tokens it made. */
export interface ClosedResult {
  readonly content: string;
  readonly piiTokens: Readonly<Record<string, string>>;
  readonly piiMasked: Readonly<Record<string, string>>;
  readonly usage: readonly UsageRecord[];
  /** Whether the rendered result was cut at its `maxResultSize` (#336). */
  readonly isTruncated: boolean;
  /** The PII refusal of the result (#120), when a block rule's kind was in it. */
  readonly refusal?: ErrorRecord;
}

/** The rendered result within its bound (#336), cut before any masking reads it. */
async function bounded(text: string, maxResultSize: Bytes): Promise<BoundedText> {
  const { boundedText } = await lazyLoad(import("./tool-result-size.js"));
  return boundedText(text, maxResultSize);
}

/** The output with its files as `redactedFileOf` shows them — with or without a PII runtime (#899 §0). */
function withFilesShown(
  dto: ReturnType<typeof dtoOf>,
  output: ToolOutput<unknown>,
): ToolOutput<unknown> {
  if (output.kind === "error" || dto === undefined) return output;
  return { kind: "ok", value: scrubbedFilesOfDto(dto, output.value) };
}

/** A result a block rule refused: the text the model reads, the spend of the search, the error as data. */
const refusedResult = (
  refused: PiiRefusedError,
  usage: readonly UsageRecord[],
  isTruncated: boolean,
): ClosedResult => ({
  content: refusedCall(refused.refusal),
  piiTokens: {},
  piiMasked: {},
  usage,
  isTruncated,
  refusal: errorRecordOf(refused),
});

/**
 * The tool's output closed for the model (`tool` absent: an interceptor's `reply` text,
 * #384); a failed call is the error text as it is. Over
 * `maxResultSize` the rendered result is cut first (#336): the policies read only the kept part, the
 * marker follows it in both forms.
 */
export async function closedResult(
  set: PiiPolicySet | undefined,
  tool: Pick<AnyTool, "output"> | undefined,
  output: ToolOutput<unknown>,
  maxResultSize: Bytes,
): Promise<ClosedResult> {
  const none = { piiTokens: {}, piiMasked: {}, usage: [] };
  // a block rule in what a model the call made on the agent's behalf would read (#708): refused
  if (output.kind === "error" && output.cause instanceof PiiRefusedError) {
    return refusedResult(output.cause, output.cause.usage, false);
  }
  // a text an interceptor gave the model (#384) has no output DTO: its text through the policies
  const dto = tool === undefined ? undefined : dtoOf(tool.output);
  if (set === undefined || output.kind === "error") {
    const { kept, marker, isTruncated } = await bounded(
      renderToolResult(withFilesShown(dto, output)),
      maxResultSize,
    );
    return { content: `${kept}${marker}`, ...none, isTruncated };
  }
  const fields = tokenFieldMask(set.fieldKey, {}, set.previous.fieldKey);
  const files = dto === undefined ? output.value : scrubbedFilesOfDto(dto, output.value);
  const value = dto === undefined ? files : maskedDtoValue(dto, files, fields.mask);
  const { kept, marker, isTruncated } = await bounded(
    renderToolResult({ kind: "ok", value }),
    maxResultSize,
  );
  const content = `${kept}${marker}`;
  if (set.isEmpty) return { ...none, content, piiTokens: fields.tokens, isTruncated };
  const { masked, usage } = await set.mask(kept, fields.tokens, DetectionMode.WithModel);
  const refused = await set.refusalError(masked.blocked, usage);
  if (refused !== undefined) return refusedResult(refused, usage, isTruncated);
  return {
    content,
    piiTokens: { ...fields.tokens, ...masked.tokens },
    piiMasked: { [set.maskCacheKeyOf(content, true)]: `${masked.text}${marker}` },
    usage,
    isTruncated,
  };
}

/**
 * The call with the agent's reading (#708): a model the call makes on the agent's behalf (its
 * knowledge base's reranker) reads through the agent's policies, its sensitive values and key.
 */
export const readingAgent = <TResult>(
  deps: Pick<AgentLoopDeps, "pii">,
  task: ToolTask,
  work: () => Promise<TResult>,
): Promise<TResult> => {
  const set = deps.pii?.withValues(task.piiValues ?? []).withFieldKey(task.piiKey);
  return withModelReading(modelReadingMaskOf(set), work);
};
