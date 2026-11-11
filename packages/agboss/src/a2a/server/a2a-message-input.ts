import type { Message, Part } from "@a2a-js/sdk";
import { keyTextRuleOf } from "../../core/errors.js";
import { DtoValidationError } from "../../dto/errors.js";
import { validInputOf } from "../../flow/runtime/start-input.js";
import { versionOf } from "../../terns/index.js";
import { A2A_SKILLS_EXTENSION } from "../a2a-extension-uris.js";
import { A2AMediaType, type ServedSkill } from "./a2a-skills.js";
import { contentTypeNotSupported, invalidParams } from "./a2a-wire-errors.js";
import type { AdmittedFile } from "./a2a-file-admission.js";
import { isFilePart, nonFilePartsOf, sha256Of } from "./a2a-message-files.js";
import { withFilesOf } from "./a2a-input-files.js";
import { refuseFileDescriptorsIn } from "./a2a-forged-files.js";

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

/**
 * The skill a new message runs: the one it names, else the only one, else the expose's
 * `defaultSkill` (#860); `-32602` when it names none of several without a default, or an unknown one.
 */
export function skillOfMessage(
  message: Message,
  skills: readonly ServedSkill[],
  fallback?: ServedSkill,
): ServedSkill {
  const meta: unknown = message.metadata?.[A2A_SKILLS_EXTENSION];
  const named: unknown =
    typeof meta === "object" && meta !== null ? Reflect.get(meta, "skill") : undefined;
  const ids = { skills: skills.map((skill) => skill.id).join(",") };
  if (named === undefined) {
    const [only] = skills;
    if (skills.length === 1 && only !== undefined) return only;
    if (fallback !== undefined) return fallback;
    throw invalidParams("a2a.skill-required", "name the skill to run", ids);
  }
  const found = skills.find((skill) => skill.id === named);
  if (found === undefined) throw invalidParams("a2a.unknown-skill", "no such skill", ids);
  return found;
}

/**
 * The payload of a message's parts that are no file: its text for a text skill, else its one
 * `data` part — `{}` for a skill that takes files when only files were sent.
 */
function payloadOf(message: Message, skill: ServedSkill, files: readonly AdmittedFile[]): unknown {
  const parts = nonFilePartsOf(message.parts);
  if (parts.length !== message.parts.length && skill.inputFiles.length === 0)
    throw contentTypeNotSupported();
  const text = textOf(parts);
  if (skill.inputMediaType === A2AMediaType.Text && text !== undefined) return { text };
  if (parts.length === 0 && files.length > 0) return {};
  return dataOf(readableParts({ ...message, parts: [...parts] }))?.value;
}

/** The start's input of a new message, checked: text parts for a text skill, else one `data` part. */
export function inputOfMessage(
  message: Message,
  skill: ServedSkill,
  files: readonly AdmittedFile[] = [],
): unknown {
  const data = payloadOf(message, skill, files);
  // a skill that takes files fills its file fields from admitted file parts only — with or
  // without any sent: a data part naming one is refused (`withFilesOf`)
  const payload: unknown =
    data === undefined || skill.inputFiles.length === 0
      ? data
      : withFilesOf(data, skill.inputFiles, files);
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
  // #900: a file's descriptor is the server's, never in a caller's decision at any depth
  refuseFileDescriptorsIn(decision);
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
 * What a part adds to its message's hash: its kind, value and media type — a `raw` file's value the
 * SHA-256 of its bytes (#859), and a file's name; a text or data part as before #859.
 */
function hashedPartOf(part: Part): Readonly<Record<string, unknown>> {
  const { content } = part;
  const value =
    content?.$case === "raw" ? sha256Of(content.value) : ((content?.value as unknown) ?? null);
  const hashed = { kind: content?.$case ?? "", value, mediaType: part.mediaType };
  return isFilePart(part) ? { ...hashed, filename: part.filename } : hashed;
}

/**
 * The hash of what a message asks: its skill, parts, and the context and task it names — a resend
 * has the same one, another message under the same id another. Extension metadata is left out.
 */
export const requestHashOf = (skill: string, message: Message): string =>
  versionOf({
    skill,
    parts: message.parts.map(hashedPartOf),
    contextId: message.contextId,
    taskId: message.taskId,
  });
