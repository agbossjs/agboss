import type { Message, Part } from "@a2a-js/sdk";
import { keyTextRuleOf } from "../../core/errors.js";
import { DtoValidationError } from "../../dto/errors.js";
import { validInputOf } from "../../flow/runtime/start-input.js";
import { versionOf } from "../../terns/index.js";
import { A2A_SKILLS_EXTENSION } from "../a2a-extension-uris.js";
import { A2AMediaType, type ServedSkill } from "./a2a-skills.js";
import { contentTypeNotSupported, invalidParams } from "./a2a-wire-errors.js";

/**
 * What a message asks (#808, design §4.1.3 steps 1–3 and §4.1.4 step 4): the skill it runs —
 * `metadata[A2A_SKILLS_EXTENSION].skill`, else the only one —, its input checked against the
 * skill's start before anything is kept (no model ever turns text into a DTO), the answer of a
 * follow-up, and the hash that tells a resend from another message under the same id.
 */

/** The parts of a message, refused when one is a file. */
function readableParts(message: Message): readonly Part[] {
  for (const part of message.parts) {
    const kind = part.content?.$case;
    if (kind !== "text" && kind !== "data") throw contentTypeNotSupported();
  }
  return message.parts;
}

const textOf = (parts: readonly Part[]): string | undefined => {
  if (parts.length === 0 || parts.some((part) => part.content?.$case !== "text")) return undefined;
  return parts.map((part) => (part.content?.$case === "text" ? part.content.value : "")).join("\n");
};

const dataOf = (parts: readonly Part[]): { readonly value: unknown } | undefined => {
  const [only] = parts;
  return parts.length === 1 && only?.content?.$case === "data"
    ? { value: only.content.value as unknown }
    : undefined;
};

/** The skill a new message runs; `-32602` when it names none of several, or an unknown one. */
export function skillOfMessage(message: Message, skills: readonly ServedSkill[]): ServedSkill {
  const meta: unknown = message.metadata?.[A2A_SKILLS_EXTENSION];
  const named: unknown =
    typeof meta === "object" && meta !== null ? Reflect.get(meta, "skill") : undefined;
  const ids = { skills: skills.map((skill) => skill.id).join(",") };
  if (named === undefined) {
    const [only] = skills;
    if (skills.length === 1 && only !== undefined) return only;
    throw invalidParams("a2a.skill-required", "name the skill to run", ids);
  }
  const found = skills.find((skill) => skill.id === named);
  if (found === undefined) throw invalidParams("a2a.unknown-skill", "no such skill", ids);
  return found;
}

/** The start's input of a new message, checked: text parts for a text skill, else one `data` part. */
export function inputOfMessage(message: Message, skill: ServedSkill): unknown {
  const parts = readableParts(message);
  const text = textOf(parts);
  const payload: unknown =
    skill.inputMediaType === A2AMediaType.Text && text !== undefined
      ? { text }
      : dataOf(parts)?.value;
  const schema: Record<string, string> =
    skill.inputSchema === null ? {} : { inputSchema: JSON.stringify(skill.inputSchema) };
  if (payload === undefined)
    throw invalidParams(
      "a2a.input-shape",
      skill.inputMediaType === A2AMediaType.Text
        ? "send the text as text parts"
        : "send the input as one data part",
      { skill: skill.id, ...schema },
    );
  try {
    return validInputOf(skill.input, skill.id, payload);
  } catch (error) {
    if (!(error instanceof DtoValidationError)) throw error;
    // the issues name the caller's own fields; the text stays fixed
    const fields = error.issues.map((issue) => issue.path).join(",");
    throw invalidParams("dto.invalid", "the input does not fit the skill's input", {
      skill: skill.id,
      fields,
      ...schema,
    });
  }
}

/** What a follow-up answers a pause with. */
export type FollowUpAnswer =
  | { readonly pauseId?: string; readonly decision: unknown }
  | { readonly pauseId?: string; readonly reply: string };

/** A follow-up's answer: one `data` part `{ pauseId?, decision }`, or text parts (a reply). */
export function answerOfMessage(message: Message): FollowUpAnswer {
  const parts = readableParts(message);
  const text = textOf(parts);
  if (text !== undefined) {
    if (text.trim() === "") throw invalidParams("a2a.answer-shape", "the reply is empty");
    return { reply: text };
  }
  const data = dataOf(parts)?.value;
  if (typeof data !== "object" || data === null || !("decision" in data))
    throw invalidParams(
      "a2a.answer-shape",
      "send { pauseId?, decision } as one data part, or a text reply",
    );
  const pauseId: unknown = Reflect.get(data, "pauseId");
  if (pauseId !== undefined && typeof pauseId !== "string")
    throw invalidParams("a2a.answer-shape", "pauseId is a text");
  const decision: unknown = Reflect.get(data, "decision");
  return pauseId === undefined ? { decision } : { pauseId, decision };
}

/** A caller's id (`contextId`, `messageId`) checked as a key's text; `-32602` naming the rule. */
export function checkedCallerKey(field: string, value: string): string {
  const rule = keyTextRuleOf(value);
  if (rule !== undefined)
    throw invalidParams("a2a.invalid-id", `${field} is not a valid id`, { field, rule });
  return value;
}

/**
 * The hash of what a message asks: its skill, parts, and the context and task it names — a resend
 * has the same one, another message under the same id another. Extension metadata is left out.
 */
export const requestHashOf = (skill: string, message: Message): string =>
  versionOf({
    skill,
    parts: message.parts.map((part) => ({
      kind: part.content?.$case ?? "",
      value: part.content?.$case === "raw" ? "" : ((part.content?.value as unknown) ?? null),
      mediaType: part.mediaType,
    })),
    contextId: message.contextId,
    taskId: message.taskId,
  });
