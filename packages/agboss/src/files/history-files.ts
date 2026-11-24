import { isFileDescriptor } from "../a2a/files/a2a-file-scrub.js";
import type { FileDto } from "../dto/standard/file.js";
import type { HistoryTurn } from "../flow/runtime/history.js";
import { createHash } from "node:crypto";
import type { SourceFile, FileRuntime } from "./visit-files.js";

/**
 * The files of the thread's earlier turns (#899 §3, `FileSource.History`): the descriptors in the turn lines
 * the agent remembers — their bytes were never written into a turn, only the descriptor (`fileId` or `url`).
 * A stored one is read through the repository: it must be a file of a root execution of the same tenant and
 * thread, and it is copied under the execution that reads it, so that the copy is an ordinary file of this
 * execution — pinned, guarded and handed back in an answer like any other. A file that retention removed is
 * shown as its descriptor, `(removed)`.
 */

/** A turn's line: `start <name>: <json>` (the JSON to the end of the text: `[\s\S]*` is greedy). */
const LINE = /^(?<side>start|finish) (?<name>[^:]+): (?<json>[\s\S]*)/u;

/** A JSON text's value; none for a text that is no JSON (it holds no descriptor). */
function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // not JSON: no value
  }
  return undefined;
}

/** Every file descriptor in a JSON value, at any depth. */
function descriptorsIn(value: unknown, found: FileDto[]): void {
  if (isFileDescriptor(value)) {
    found.push(value);
    return;
  }
  // an array's values are its items, in order
  if (typeof value === "object" && value !== null)
    for (const item of Object.values(value)) descriptorsIn(item, found);
}

/** The descriptors of the turns, oldest first, each once, with where it was said. */
export function historyDescriptorsOf(history: readonly HistoryTurn[]): readonly SourceFile[] {
  const seen = new Set<string>();
  return history.flatMap((turn, index) =>
    [turn.start, turn.finish].flatMap((line) => {
      const match = LINE.exec(line);
      if (match === null) return [];
      const parts = { ...match.groups }; // every group is in a match
      const found: FileDto[] = [];
      descriptorsIn(jsonOf(String(parts.json)), found);
      return found.flatMap((descriptor) => {
        const key = `${descriptor.fileId ?? ""}|${descriptor.url ?? ""}|${descriptor.sha256 ?? ""}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [
          {
            descriptor,
            field: `turn ${String(index + 1)} ${String(parts.side)} ${String(parts.name)}`,
            producer: "an earlier turn",
          },
        ];
      });
    }),
  );
}

/** The id of a thread file's copy under the execution that reads it: the same copy for the same bytes. */
const copyIdOf = (ownerId: string, sha256: string): string =>
  `history-${createHash("sha256").update(`${ownerId}:${sha256}`).digest("hex").slice(0, 40)}`;

/** One descriptor as a source of this visit: a copy of its stored file, itself (a url), or marked removed. */
async function sourceOf(found: SourceFile, runtime: FileRuntime): Promise<SourceFile> {
  const { descriptor } = found;
  if (descriptor.fileId === undefined) return found;
  const context = runtime.context();
  const key = { tenantId: context.tenantId, fileId: descriptor.fileId };
  const meta = await context.store.findMetadata(key);
  if (meta === undefined) return { ...found, isRemoved: true };
  if (meta.ownerId === context.ownerId) return found;
  if (!(await runtime.threadOwners()).includes(meta.ownerId)) return { ...found, isRemoved: true };
  const bytes = await context.store.findBytes(key);
  if (bytes === undefined) return { ...found, isRemoved: true };
  const fileId = copyIdOf(context.ownerId, meta.sha256);
  await context.store.save({
    tenantId: meta.tenantId,
    fileId,
    ownerId: context.ownerId,
    mediaType: meta.mediaType,
    sha256: meta.sha256,
    sizeBytes: meta.sizeBytes,
    createdAt: context.clock.now(),
    ...(meta.filename === undefined ? {} : { filename: meta.filename }),
    bytes,
  });
  return { ...found, descriptor: Object.assign({}, descriptor, { fileId }) };
}

/** The agent's history files as sources of this visit, in order. */
export async function historySourcesOf(
  history: readonly HistoryTurn[],
  runtime: FileRuntime,
): Promise<readonly SourceFile[]> {
  const sources: SourceFile[] = [];
  for (const found of historyDescriptorsOf(history)) sources.push(await sourceOf(found, runtime));
  return sources;
}
