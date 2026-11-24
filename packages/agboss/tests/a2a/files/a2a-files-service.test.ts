/**
 * #859: `Files`, what a step reads and keeps its task's files with — a file saved for the
 * execution's task is read back by it, inline with no store listed; never another task's or another
 * tenant's, never bytes that do not match their digest; a save is bounded and checked like an input.
 */
import { FileError } from "../../../src/core/error-families/remote-errors.js";
import { describe, expect, it } from "vitest";
import { FileRefusal, FileUnavailableReason } from "../../../src/files/file-errors.js";
import { Files } from "../../../src/a2a/files/files.service.js";
import { runInFrame } from "../../../src/flow/context/frame.js";
import { InlineFileRepository } from "../../../src/infrastructure/file.repository.js";
import { InMemoryFileRepository } from "../../../src/infrastructure/in-memory-file.repository.js";
import { InMemoryDatabase } from "../../../src/infrastructure/in-memory-database.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { inTenantFrame, inTestFrame, testFrame } from "../../helpers/frame.js";
import { PDF, TEXT } from "./support.js";
import { ComponentOptions } from "../../../src/components/component-options.js";

const clock = new VirtualClock(new Date("2026-01-05T09:00:00.000Z"));
const stored = () =>
  new Files(new InMemoryFileRepository(new InMemoryDatabase()), clock, ComponentOptions.none);
const reasonOf = async (work: Promise<unknown>) =>
  work.then(
    () => "read",
    (error: unknown) =>
      error instanceof FileError.Unavailable ? error.reason : (error as FileError.Refused).refusal,
  );

/** Runs `work` in a frame of another execution (another task) of the same tenant. */
const inOtherExecution = <T>(work: () => Promise<T>): Promise<T> => {
  const frame = testFrame();
  return runInFrame(
    { ...frame, execution: { ...frame.execution, executionId: "other-task" } },
    work,
  );
};

describe("#859: Files", () => {
  it("a saved file is kept under the task, read back by it, checked against its digest", async () => {
    const files = stored();

    const file = await inTestFrame(() =>
      files.save({ bytes: PDF, mediaType: "Application/PDF", filename: "a.pdf" }),
    );
    const bytes = await inTestFrame(() => files.read(file));

    expect(file).toMatchObject({
      mediaType: "application/pdf",
      filename: "a.pdf",
      sizeBytes: PDF.byteLength,
    });
    expect(file.fileId).toMatch(/^.+\.[0-9a-f]{64}$/);
    expect(Buffer.from(bytes)).toEqual(Buffer.from(PDF));
  });

  it("with no store listed the file rides inline in its descriptor", async () => {
    const files = new Files(new InlineFileRepository(), clock, ComponentOptions.none);

    const file = await inTestFrame(() => files.save({ bytes: TEXT, mediaType: "text/plain" }));

    expect(file.fileId).toBeUndefined();
    expect(Buffer.from(file.inline ?? "", "base64")).toEqual(Buffer.from(TEXT));
    expect(Buffer.from(await inTestFrame(() => files.read(file)))).toEqual(Buffer.from(TEXT));
  });

  it("another task's file, another tenant's, a url off every allowed origin, a wrong digest, no execution: unavailable or refused", async () => {
    const files = stored();
    const file = await inTestFrame(() => files.save({ bytes: PDF, mediaType: "application/pdf" }));
    const inline = await inTestFrame(() =>
      new Files(new InlineFileRepository(), clock, ComponentOptions.none).save({
        bytes: TEXT,
        mediaType: "text/plain",
      }),
    );

    const reasons = await Promise.all([
      reasonOf(inOtherExecution(() => files.read(file))),
      reasonOf(inTenantFrame("acme", () => files.read(file))),
      reasonOf(
        inTestFrame(async () =>
          files.read(files.fromUrl("https://f.example/a", { mediaType: "text/plain" })),
        ),
      ),
      reasonOf(
        inTestFrame(() =>
          files.read(Object.assign(structuredClone(inline), { sha256: "0".repeat(64) })),
        ),
      ),
      reasonOf(files.read(file)),
    ]);

    expect(reasons).toEqual([
      FileUnavailableReason.NotFound,
      FileUnavailableReason.NotFound,
      FileRefusal.OriginDenied,
      FileUnavailableReason.DigestMismatch,
      FileUnavailableReason.OutsideExecution,
    ]);
  });

  it("a save is refused outside an execution, of a type not taken, too large, or not what it says", async () => {
    const files = stored();
    const big = Uint8Array.from([...PDF, ...new Uint8Array(64 * 1024)]);

    const refusals = await Promise.all([
      reasonOf(files.save({ bytes: PDF, mediaType: "application/pdf" })),
      reasonOf(inTestFrame(() => files.save({ bytes: PDF, mediaType: "application/zip" }))),
      reasonOf(inTestFrame(() => files.save({ bytes: big, mediaType: "application/pdf" }))),
      reasonOf(inTestFrame(() => files.save({ bytes: TEXT, mediaType: "application/pdf" }))),
    ]);

    expect(refusals).toEqual([
      FileRefusal.OutsideExecution,
      FileRefusal.MediaType,
      FileRefusal.TooLarge,
      FileRefusal.MediaTypeMismatch,
    ]);
    expect(() => files.fromUrl("http://f.example/a", { mediaType: "text/plain" })).toThrow(
      FileError.Refused,
    );
  });
});
