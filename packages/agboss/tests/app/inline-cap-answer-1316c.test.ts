/**
 * #1316c: a pause's answer is held to the inline cap before it is recorded: its inline files over
 * 64 KB (or 256 KB together) are offloaded to the file store, owned by the pause's root execution,
 * or — with no store listed — refused (`FileRefusal.InlineTooLarge`) and nothing is recorded.
 */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { FileError } from "../../src/core/error-families/remote-errors.js";
import { Nested, Text } from "../../src/dto/index.js";
import { FileDto } from "../../src/dto/standard/file.js";
import { FileRefusal } from "../../src/files/file-errors.js";
import { inlineFilesOf } from "../../src/files/inline-offload.js";
import { InlineFileRepository } from "../../src/infrastructure/file.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { InMemoryFileRepository } from "../../src/infrastructure/in-memory-file.repository.js";
import { PauseKind, PauseStatus } from "../../src/infrastructure/pause-record.js";
import { recordedAnswer } from "../../src/app/resume.js";
import { ComponentOptions } from "../../src/components/component-options.js";
import { PauseRespondent } from "../../src/pause/respondent.js";

class ScanAnswerDto {
  @Text({ prompt: "a note" })
  note!: string;

  @Nested(FileDto, { prompt: "the scan" })
  scan!: FileDto;
}

const bytes = Buffer.alloc(70 * 1024, "s");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const scan = (): FileDto => ({
  mediaType: "text/plain",
  inline: bytes.toString("base64"),
  sha256,
  sizeBytes: bytes.byteLength,
});

const pause = {
  pauseId: "p-1",
  tenantId: "acme",
  threadId: "th-1",
  rootExecutionId: "root-1",
  workflow: "wf",
  step: "ask-step",
  target: "owner-tool-approval",
  channel: "owner",
  respondent: PauseRespondent.Owner,
  kind: PauseKind.ExternalTask,
  status: PauseStatus.Pending,
  ask: {},
};

function partsOver(store: InlineFileRepository | InMemoryFileRepository) {
  const resolve = vi.fn((...args: unknown[]) => Promise.resolve({ ...pause, answer: args[2] }));
  const parts = {
    pauses: {
      findByTenantIdAndPauseId: () => Promise.resolve(pause),
      resolveByTenantIdAndPauseId: resolve,
    },
    paused: { find: () => Promise.resolve(undefined) },
    answers: { savePauseAnswer: () => Promise.resolve() },
    clock: { now: () => new Date(0) },
    questions: () => ScanAnswerDto,
    tools: () => {
      throw new Error("no tools");
    },
    inline: inlineFilesOf(
      () => store,
      { now: () => new Date(0) },
      undefined,
      ComponentOptions.none,
    ),
  };
  return { parts, resolve };
}

const answerWith = (parts: object) =>
  recordedAnswer(
    parts as never,
    pause as never,
    { pauseId: "p-1", decision: { note: "n", scan: scan() } },
    { id: "dana" },
  );

describe("a pause's answer and the inline cap", () => {
  it("a file over 64 KB is offloaded under the pause's root execution before the answer is recorded", async () => {
    const store = new InMemoryFileRepository(new InMemoryDatabase());
    const { parts, resolve } = partsOver(store);

    await answerWith(parts);

    const fileId = `root-1.${sha256}`;
    expect((await store.findMetadata({ tenantId: "acme", fileId }))?.ownerId).toBe("root-1");
    const recorded = resolve.mock.calls[0]?.[2] as { decision: { scan: FileDto } };
    expect(recorded.decision.scan.fileId).toBe(fileId);
    expect(recorded.decision.scan.inline).toBeUndefined();
  });

  it("with no store it is refused with InlineTooLarge and nothing is recorded", async () => {
    const { parts, resolve } = partsOver(new InlineFileRepository());

    const failure = await answerWith(parts).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(FileError.Refused);
    expect(failure).toMatchObject({ refusal: FileRefusal.InlineTooLarge });
    expect(resolve).not.toHaveBeenCalled();
  });
});
