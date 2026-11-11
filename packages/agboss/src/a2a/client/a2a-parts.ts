import type { Artifact, Message, Part, Task } from "@a2a-js/sdk";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../dto/standard/framework.js";
import type { DtoClass } from "../../dto/types.js";
import { A2A_SKILLS_EXTENSION } from "../a2a-extension-uris.js";
import {
  fileInputPartsOf,
  fileOutputOf,
  hasFileFieldInData,
  type StoredFileReader,
} from "./a2a-client-files.js";

/**
 * What a message carries and what an answer gives (#809, design §3 and §4.2): one `data` part
 * (`application/json`) for a DTO, `text` for a text start; an output from a COMPLETED task's
 * artifact or a message's parts — a `data` part, or text for a text finish. No model coerces text
 * into a DTO: what cannot be read is no output.
 */

/** What `send` / `reply` take: a text, a JSON value, or the parts as they are. */
export type A2AMessageInput = string | { readonly data: unknown } | readonly Part[];

export const JSON_MEDIA_TYPE = "application/json";
export const TEXT_MEDIA_TYPE = "text/plain";

export const textPartOf = (text: string): Part => ({
  content: { $case: "text", value: text },
  metadata: undefined,
  filename: "",
  mediaType: TEXT_MEDIA_TYPE,
});

export const dataPartOf = (data: unknown): Part => ({
  content: { $case: "data", value: data },
  metadata: undefined,
  filename: "",
  mediaType: JSON_MEDIA_TYPE,
});

/** The parts of an untyped message. */
export function partsOf(input: A2AMessageInput): Part[] {
  if (typeof input === "string") return [textPartOf(input)];
  if (Array.isArray(input)) return [...(input as readonly Part[])];
  return [dataPartOf((input as { readonly data: unknown }).data)];
}

const extendsClass = (dto: DtoClass, base: DtoClass): boolean =>
  dto === base || dto.prototype instanceof base;

/**
 * The parts of a typed input: `text` for a `WorkflowStartTextDto` that holds only its text, its
 * file parts and the rest as one `data` part for a DTO with file fields (#859; a stored file read
 * through `read`), else one `data` part of the (validated) DTO.
 */
export async function inputPartsOf(
  dto: DtoClass,
  input: object,
  read: StoredFileReader,
): Promise<Part[]> {
  const withFiles = await fileInputPartsOf(dto, input, read, dataPartOf);
  if (withFiles !== undefined) return withFiles;
  if (extendsClass(dto, WorkflowStartTextDto)) {
    const { text, ...rest } = input as { readonly text?: unknown };
    const isTextOnly =
      typeof text === "string" && Object.values(rest).every((value) => value === undefined);
    if (isTextOnly) return [textPartOf(text)];
  }
  return [dataPartOf(input)];
}

/** The texts of some parts, joined, or `undefined` without one. */
export function textOf(parts: readonly Part[]): string | undefined {
  const texts = parts.flatMap((part) =>
    part.content?.$case === "text" ? [part.content.value] : [],
  );
  return texts.length === 0 ? undefined : texts.join("");
}

/** The first `data` part's value, or `undefined` without one. */
export function dataOf(parts: readonly Part[]): { readonly value: unknown } | undefined {
  for (const part of parts) {
    if (part.content?.$case === "data") return { value: part.content.value as unknown };
  }
  return undefined;
}

/** Whether an artifact is an AGBoss finish's output: `metadata[skills-uri].finish` names it. */
const isFinishOutput = (artifact: Artifact): boolean => {
  const entry: unknown = artifact.metadata?.[A2A_SKILLS_EXTENSION];
  return (
    typeof entry === "object" && entry !== null && typeof Reflect.get(entry, "finish") === "string"
  );
};

/**
 * The parts of a task's artifacts, in order — of its finish's output artifact alone when it has
 * one: a peer may keep other artifacts beside it (an AGBoss server before #833 streamed the model's
 * text as one of its own, the same text).
 */
export function artifactPartsOf(artifacts: readonly Artifact[]): readonly Part[] {
  const outputs = artifacts.filter(isFinishOutput);
  return (outputs.length === 0 ? artifacts : outputs).flatMap((artifact) => artifact.parts);
}

/** The parts an answer gives: a task's artifacts, or a message's own parts. */
export const answerPartsOf = (answer: Task | Message): readonly Part[] =>
  "messageId" in answer ? answer.parts : artifactPartsOf(answer.artifacts);

/**
 * The raw output of `parts` for `dto`: the `data` part's value; for a `WorkflowFinishTextDto`
 * output also the text parts as `{ text }`. `undefined` when no part holds one.
 */
export function rawOutputOf(
  dto: DtoClass,
  parts: readonly Part[],
): { readonly value: unknown } | undefined {
  const data = dataOf(parts);
  // #859: a DTO with file fields takes the file parts into them — never a descriptor of the data
  if (hasFileFieldInData(dto, data)) return undefined;
  const withFiles = fileOutputOf(dto, parts, data);
  if (withFiles !== undefined) return withFiles;
  if (data !== undefined) return data;
  if (!extendsClass(dto, WorkflowFinishTextDto)) return undefined;
  const text = textOf(parts);
  return text === undefined ? undefined : { value: { text } };
}
