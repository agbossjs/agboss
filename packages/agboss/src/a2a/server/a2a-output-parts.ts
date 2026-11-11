import type { Part } from "@a2a-js/sdk";
import type { A2AFileRepository } from "../../infrastructure/a2a-file.repository.js";
import type { A2ATaskRecord } from "../../infrastructure/a2a-task.repository.js";
import { A2A_SKILLS_EXTENSION } from "../a2a-extension-uris.js";
import {
  A2AFileSource,
  fileSourceOf,
  type A2AFileDto,
  type A2AFileField,
} from "../files/a2a-file.dto.js";
import type { ServedOutput } from "./a2a-skills.js";

/**
 * The parts of a finish's output that holds files (#859, spec §4.1.6): one file part per file, in
 * field order — `raw` (its bytes, from the descriptor or the store) or `url` (by reference), its
 * media type and name, `metadata[A2A_SKILLS_EXTENSION].field` naming its field — then one `data`
 * part of the other fields when the DTO has any. A stored file is served only as its task's own
 * (the store's owner is the task): any other — or one gone from the store — is left out and
 * counted in the artifact's `metadata[A2A_SKILLS_EXTENSION].missingFiles`.
 */

/** A file part as the wire carries it, its field named. */
export function filePartOf(file: A2AFileDto, content: Part["content"], field: string): Part {
  return {
    content,
    metadata: { [A2A_SKILLS_EXTENSION]: { field } },
    filename: file.filename ?? "",
    mediaType: file.mediaType,
  };
}

/** A file's content on the wire; `undefined` for a stored one its task cannot serve. */
async function contentOf(
  file: A2AFileDto,
  task: A2ATaskRecord,
  store: A2AFileRepository,
): Promise<Part["content"] | undefined> {
  switch (fileSourceOf(file)) {
    case A2AFileSource.Url:
      return { $case: "url", value: file.url ?? "" };
    case A2AFileSource.Inline:
      return { $case: "raw", value: Buffer.from(file.inline ?? "", "base64") };
    case A2AFileSource.Stored:
      return storedContentOf(file, task, store);
  }
}

/** A stored file's bytes, served only as its own task's and as its descriptor says. */
async function storedContentOf(
  file: A2AFileDto,
  task: A2ATaskRecord,
  store: A2AFileRepository,
): Promise<Part["content"] | undefined> {
  const key = { tenantId: task.tenantId, fileId: file.fileId ?? "" };
  const meta = await store.findMetadata(key);
  if (meta?.ownerId !== task.taskId || meta.sha256 !== file.sha256) return undefined;
  const bytes = await store.findBytes(key);
  return bytes === undefined ? undefined : { $case: "raw", value: Buffer.from(bytes) };
}

/** The files a field of the output holds, in order. */
function filesIn(output: Readonly<Record<string, unknown>>, field: A2AFileField): A2AFileDto[] {
  const value = output[field.name];
  if (value === undefined || value === null) return [];
  // the finish's output was validated as its DTO: the field holds descriptors
  return (Array.isArray(value) ? value : [value]) as A2AFileDto[];
}

/** An output's file parts, its data part, and how many of its files could not be served. */
export interface FileOutputParts {
  readonly parts: readonly Part[];
  readonly missingFiles: number;
}

/** The output's other fields: what its data part carries. */
const dataOf = (
  output: Readonly<Record<string, unknown>>,
  fields: readonly A2AFileField[],
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(output).filter(([name]) => !fields.some((field) => field.name === name)),
  );

/** The parts of an output whose finish holds files. */
export async function fileOutputPartsOf(
  task: A2ATaskRecord,
  served: ServedOutput,
  store: A2AFileRepository,
  dataPart: (value: unknown) => Part,
): Promise<FileOutputParts> {
  const output = (task.status.output ?? {}) as Readonly<Record<string, unknown>>;
  const parts: Part[] = [];
  let missingFiles = 0;
  for (const field of served.fileFields) {
    for (const file of filesIn(output, field)) {
      const content = await contentOf(file, task, store);
      if (content === undefined) missingFiles += 1;
      else parts.push(filePartOf(file, content, field.name));
    }
  }
  if (served.hasData) parts.push(dataPart(dataOf(output, served.fileFields)));
  return { parts, missingFiles };
}
