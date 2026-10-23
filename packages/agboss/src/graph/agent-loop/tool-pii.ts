import type { UsageRecord } from "../../finops/usage.js";
import { dtoOf, maskedDtoValue } from "../../dto/redact.js";
import { tokenFieldMask } from "../../pii/field-masks.js";
import type { PiiFinding } from "../../pii/masking.js";
import { maskCacheKey } from "../../pii/model-boundary.js";
import type { PiiPolicySet } from "../../pii/policy-set.js";
import { DetectionMode } from "../../pii/runtime-policy.js";
import { mappedStringsAsync } from "../../pii/strings.js";
import type { PiiTokenMap } from "../../pii/tokens.js";
import { renderToolResult, type AnyTool, type ToolOutput } from "../../tools/index.js";
import type { Bytes } from "../../units/index.js";
import type { BoundedText } from "./tool-result-size.js";

/**
 * PII in the tool task (#120 AC9): the arguments the model gave were revealed when its move was
 * read, so the tool gets real values; a block rule's kind in them rejects the call before `run`.
 * Just after `run` the result is closed: its `sensitive` fields through their actions, its text
 * through the policies — a block rule's kind in it rejects the call; the masked form is kept for
 * the model (the loop's `piiMasked`), the checkpoint keeps the result as it was.
 */

/** What blocks a call: the text the model reads instead of a result. */
const refusedCall = (refusal: string): string =>
  `Tool error: the call was refused${refusal === "" ? "" : `: ${refusal}`}`;

/** Every string of a value searched; the findings of block rules and the spend. */
async function blockedIn(
  set: PiiPolicySet,
  value: unknown,
  known: PiiTokenMap,
): Promise<{ readonly blocked: readonly PiiFinding[]; readonly usage: readonly UsageRecord[] }> {
  const blocked: PiiFinding[] = [];
  const usage: UsageRecord[] = [];
  await mappedStringsAsync(value, async (text) => {
    const search = await set.mask(text, known, DetectionMode.WithModel);
    blocked.push(...search.masked.blocked);
    usage.push(...search.usage);
    return text;
  });
  return { blocked, usage };
}

/** What refuses a call before it runs: the text the model reads and the error behind it. */
export interface ArgumentsRefusal {
  readonly content?: string;
  readonly refusal?: Error;
  readonly usage: readonly UsageRecord[];
}

/** The refusal of a call whose arguments hold a blocked kind; none when it may run. */
export async function argumentsRefusal(
  set: PiiPolicySet | undefined,
  args: Readonly<Record<string, unknown>>,
): Promise<ArgumentsRefusal> {
  if (set === undefined || set.isEmpty) return { usage: [] };
  const { blocked, usage } = await blockedIn(set, args, {});
  const refused = await set.refusalError(blocked, usage);
  return refused === undefined
    ? { usage }
    : { content: refusedCall(refused.refusal), refusal: refused, usage };
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
  readonly refusal?: Error;
}

/** The rendered result within its bound (#336), cut before any masking reads it. */
async function bounded(text: string, maxResultSize: Bytes): Promise<BoundedText> {
  const { boundedText } = await import("./tool-result-size.js");
  return boundedText(text, maxResultSize);
}

/**
 * The tool's output closed for the model (`tool` absent: an interceptor's `replyToModel` text,
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
  if (set === undefined || output.kind === "error") {
    const { kept, marker, isTruncated } = await bounded(renderToolResult(output), maxResultSize);
    return { content: `${kept}${marker}`, ...none, isTruncated };
  }
  const fields = tokenFieldMask(set.fieldKey, {});
  // a text an interceptor gave the model (#384) has no output DTO: its text through the policies
  const dto = tool === undefined ? undefined : dtoOf(tool.output);
  const value = dto === undefined ? output.value : maskedDtoValue(dto, output.value, fields.mask);
  const { kept, marker, isTruncated } = await bounded(
    renderToolResult({ kind: "ok", value }),
    maxResultSize,
  );
  const content = `${kept}${marker}`;
  if (set.isEmpty) return { ...none, content, piiTokens: fields.tokens, isTruncated };
  const { masked, usage } = await set.mask(kept, fields.tokens, DetectionMode.WithModel);
  const refused = await set.refusalError(masked.blocked, usage);
  if (refused !== undefined)
    return {
      ...none,
      content: refusedCall(refused.refusal),
      usage,
      isTruncated,
      refusal: refused,
    };
  return {
    content,
    piiTokens: { ...fields.tokens, ...masked.tokens },
    piiMasked: { [maskCacheKey(content, true)]: `${masked.text}${marker}` },
    usage,
    isTruncated,
  };
}
