/**
 * #1316c: the inline cap — a file over 64 KB, and the inline files of one payload over 256 KB
 * together, are offloaded to the file store, largest first, or refused with no store.
 */
import { describe, expect, it } from "vitest";
import { FileError } from "../../src/core/error-families/remote-errors.js";
import { Files } from "../../src/a2a/files/files.service.js";
import { FileDto } from "../../src/dto/standard/file.js";
import { FileRefusal } from "../../src/files/file-errors.js";
import {
  filesToOffload,
  MAX_INLINE_FILE_BYTES,
  MAX_INLINE_PAYLOAD_BYTES,
  offloadedInlineFiles,
} from "../../src/files/inline-cap.js";
import { InlineFileRepository } from "../../src/infrastructure/file.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { InMemoryFileRepository } from "../../src/infrastructure/in-memory-file.repository.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { FilePolicy } from "../../src/files/file-policy.js";
import { Workflow } from "../../src/flow/decorators/workflow.js";
import { runInFrame } from "../../src/flow/context/frame.js";
import { hours, kilobytes } from "../../src/units/index.js";
import { fileReviewFlow } from "../a2a/fixtures/files.application.js";
import { testFrame } from "../helpers/frame.js";

const NOW = new Date("2026-01-05T09:00:00.000Z");
const fileOf = (size: number, seed: number): FileDto =>
  FileDto.fromBytes(new Uint8Array(size).fill(seed), { mediaType: "application/pdf" });

describe("#1316c: what leaves a payload", () => {
  it("every file over 64 KB; then the largest until the rest is within 256 KB", () => {
    const big = fileOf(MAX_INLINE_FILE_BYTES + 1, 1);
    const sixty = [fileOf(60_000, 2), fileOf(60_000, 3), fileOf(60_000, 4), fileOf(30_000, 6)];

    expect(filesToOffload([big, ...sixty])).toEqual([big]);
    // 5 x 60 000 = 300 000 > 262 144: one 60 000 leaves, the rest (240 000) fits
    const five = [...sixty.slice(0, 3), fileOf(60_000, 8), fileOf(60_000, 9)];
    expect(filesToOffload(five)).toHaveLength(1);
    expect(MAX_INLINE_PAYLOAD_BYTES).toBe(262_144);
    expect(
      filesToOffload([
        fileOf(10, 7),
        FileDto.fromUrl("https://f.example/a", { mediaType: "text/plain" }),
      ]),
    ).toEqual([]);
  });
});

describe("#1316c: offloading", () => {
  it("with a store: the descriptor holds a fileId, the bytes are kept under the owner; small ones stay inline", async () => {
    const store = new InMemoryFileRepository(new InMemoryDatabase());
    const big = fileOf(MAX_INLINE_FILE_BYTES + 1, 1);
    const small = fileOf(10, 2);

    await offloadedInlineFiles([big, small], { store, tenantId: "t", ownerId: "run-1", now: NOW });

    expect(big.inline).toBeUndefined();
    expect(big.fileId).toBe(`run-1.${big.sha256 ?? ""}`);
    expect(small.inline).toBeDefined();
    expect((await store.findBytes({ tenantId: "t", fileId: big.fileId ?? "" }))?.byteLength).toBe(
      MAX_INLINE_FILE_BYTES + 1,
    );
  });

  it("with no store: FileError.Refused InlineTooLarge, nothing changed", async () => {
    const big = fileOf(MAX_INLINE_FILE_BYTES + 1, 1);

    const error = await offloadedInlineFiles([big], {
      store: new InlineFileRepository(),
      tenantId: "t",
      ownerId: "run-1",
      now: NOW,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FileError.Refused);
    expect((error as FileError.Refused).refusal).toBe(FileRefusal.InlineTooLarge);
    expect(big.inline).toBeDefined();
  });

  it("Files.save with no store refuses a file over 64 KB; at 64 KB it rides inline", async () => {
    @FilePolicy({ ttl: hours(1), maxFileSize: kilobytes(200), maxTotalFileSize: kilobytes(200) })
    class Roomy {}
    @Workflow({ name: "roomy-workflow", version: "1.0.0", flow: fileReviewFlow, filePolicy: Roomy })
    class RoomyWorkflow {}
    const files = new Files(new InlineFileRepository(), new VirtualClock(NOW));
    const frame = testFrame();
    const workflow = { ...frame.execution.workflow, type: RoomyWorkflow } as never;
    const save = (size: number) =>
      runInFrame({ ...frame, execution: { ...frame.execution, workflow } }, () =>
        files.save({ bytes: new Uint8Array(size), mediaType: "text/plain" }),
      );

    const over = await save(MAX_INLINE_FILE_BYTES + 1).catch((caught: unknown) => caught);

    expect((over as FileError.Refused).refusal).toBe(FileRefusal.InlineTooLarge);
    expect((await save(MAX_INLINE_FILE_BYTES)).inline).toBeDefined();
  });
});
