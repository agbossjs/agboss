import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { recordUsage, type UsageRecord } from "../../finops/usage.js";
import { PaidStepError } from "../../graph/errors.js";
import type { ModelBinding } from "../../llm/registry.js";
import { piiDetectionInstructions } from "../../prompts/pii.js";
import { PiiKind } from "../kinds.js";
import type { ModelDetection, ModelFoundRange } from "../runtime-policy.js";

/**
 * A policy's model detection (`detectWithModel`, #120 AC3): names, street addresses and the other
 * kinds without a format, found by a chat model in free text. The model names each value as it
 * appears; the ranges are where that text occurs. Its usage is recorded under `pii:<policy>`; an
 * answer that is not the JSON asked for fails closed — nothing goes to the model unmasked.
 */

/** The model did not answer what masking needs: the execution stops before the text is sent. */
export class PiiDetectionFailedError extends PaidStepError {
  static override readonly code: string = "pii.detection-failed";
  override name = "PiiDetectionFailedError";
}

const KINDS = new Set<string>(Object.values(PiiKind));

const Answer = z.object({
  found: z.array(z.object({ kind: z.string(), text: z.string() })),
});

const contentText = (content: unknown): string =>
  typeof content === "string" ? content : JSON.stringify(content);

/** The JSON object in the model's answer (code fences and text around it ignored). */
function parsedAnswer(content: unknown): z.infer<typeof Answer> | undefined {
  const text = contentText(content);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return undefined;
  try {
    const parsed = Answer.safeParse(JSON.parse(text.slice(start, end + 1)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Every occurrence of each found text, of the kinds asked for. */
function rangesOf(
  text: string,
  answer: z.infer<typeof Answer>,
  kinds: ReadonlySet<string>,
): ModelFoundRange[] {
  return answer.found.flatMap((item) => {
    if (!kinds.has(item.kind) || !KINDS.has(item.kind) || item.text.trim() === "") return [];
    const ranges: ModelFoundRange[] = [];
    for (let at = text.indexOf(item.text); at >= 0; at = text.indexOf(item.text, at + 1))
      ranges.push({ start: at, end: at + item.text.length, kind: item.kind as PiiKind });
    return ranges;
  });
}

/** The model detection of one policy on its binding. */
export function modelDetectionOf(policy: string, binding: ModelBinding): ModelDetection {
  const caller = `pii:${policy}`;
  return async (text, kinds) => {
    const messages = [
      new SystemMessage(piiDetectionInstructions(kinds)),
      new HumanMessage({ content: text }),
    ];
    const response = await binding.model.invoke(messages);
    const usage: UsageRecord[] = [recordUsage(caller, binding.settings, response)];
    const answer = parsedAnswer(response.content);
    if (answer === undefined)
      throw new PiiDetectionFailedError(
        `${policy}: the PII detection model did not answer the JSON asked for`,
        usage,
        undefined,
      );
    return { ranges: rangesOf(text, answer, new Set(kinds)), usage };
  };
}
