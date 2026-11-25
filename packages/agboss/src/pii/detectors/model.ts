import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { recordUsage, type UsageRecord } from "../../finops/usage.js";
import { PaidStepError } from "../../graph/errors.js";
import type { ModelBinding } from "../../llm/registry.js";
import { piiDetectionInstructions } from "../../prompts/pii.js";
import { SILENT_LOG, type FrameworkLog } from "../../infrastructure/logger.js";
import { PiiKind } from "../kinds.js";
import type { ModelDetection, ModelFoundRange } from "../runtime-policy.js";
import { chargedCall, reportToFrame } from "../../finops/charged-call.js";

/**
 * A policy's model detection (`model`, #120 AC3): names, street addresses and the other
 * kinds without a format, found by a chat model in free text. The model names each value as it
 * appears; the ranges are where that text occurs. Its usage is recorded under `pii:<policy>`; an
 * answer that is not the JSON asked for fails closed — nothing goes to the model unmasked. A value
 * under a kind of no id is masked all the same (`<pii>`), with a warning (#1301).
 */

/** The model did not answer what masking needs: the execution stops before the text is sent. */
export class PiiDetectionFailedError extends PaidStepError {
  static override readonly code = "pii.detection-failed" as const;
  declare readonly code: typeof PiiDetectionFailedError.code;
  override name = "PiiDetectionFailedError";
}

/** The log code of a model's answer that names a kind of no id. */
export const UNKNOWN_KIND_CODE = "pii.model-unknown-kind";

/** A kind's name as the log may show it: a kebab-case word, else not shown (it is the model's text). */
const shownKind = (raw: string): string =>
  /^[a-z][a-z0-9-]{0,39}$/u.test(raw) ? `"${raw}"` : "(not a kind name)";

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

/**
 * Every occurrence of each found text. A kind of no id is no kind (masked as `<pii>`, said once per
 * answer and kind on the log): the model found a value, and what the policy cannot place is never
 * let through (#1301).
 */
function rangesOf(
  text: string,
  answer: z.infer<typeof Answer>,
  warnUnknown: (raw: string) => void,
): ModelFoundRange[] {
  const warned = new Set<string>();
  return answer.found.flatMap((item) => {
    if (item.text.trim() === "") return [];
    const kind = PiiKind.fromId(item.kind);
    if (kind === undefined && !warned.has(item.kind)) {
      warned.add(item.kind);
      warnUnknown(item.kind);
    }
    const ranges: ModelFoundRange[] = [];
    for (let at = text.indexOf(item.text); at >= 0; at = text.indexOf(item.text, at + 1))
      ranges.push({ start: at, end: at + item.text.length, kind });
    return ranges;
  });
}

/** The model detection of one policy on its binding; `log` hears of a kind of no id. */
export function modelDetectionOf(
  policy: string,
  binding: ModelBinding,
  log: FrameworkLog = SILENT_LOG,
): ModelDetection {
  const caller = `pii:${policy}`;
  const warnUnknown = (raw: string): void => {
    log.warn(
      UNKNOWN_KIND_CODE,
      `PII policy ${policy}: the detection model named the kind ${shownKind(raw)}, which is no PiiKind — its value is masked as <pii>`,
    );
  };
  return async (text, kinds) => {
    const messages = [
      new SystemMessage(piiDetectionInstructions(kinds.map((kind) => kind.id))),
      new HumanMessage({ content: text }),
    ];
    const spec = { caller, settings: binding.settings, sent: messages, sink: reportToFrame };
    const response = await chargedCall(spec, (callbacks) =>
      binding.model.invoke(messages, { callbacks }),
    );
    const usage: UsageRecord[] = [recordUsage(caller, binding.settings, response)];
    const answer = parsedAnswer(response.content);
    if (answer === undefined)
      throw new PiiDetectionFailedError({
        message: `${policy}: the PII detection model did not answer the JSON asked for`,
        usage,
      });
    return { ranges: rangesOf(text, answer, warnUnknown), usage };
  };
}
