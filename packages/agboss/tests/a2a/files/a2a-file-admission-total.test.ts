/**
 * #1366: the total a message's files may have — the sum of their sizes is checked against the skill's
 * `maxTotalFileSize` as each file is admitted: a total at the limit is taken, one byte over is refused.
 */
import { describe, expect, it } from "vitest";
import { fileAdmissionOf } from "../../../src/a2a/server/a2a-file-admission.js";
import type { IncomingFile } from "../../../src/a2a/server/a2a-message-files.js";
import { InlineA2AFileRepository } from "../../../src/infrastructure/a2a-file.repository.js";

const fileOf = (index: number, size: number): IncomingFile => ({
  index,
  field: undefined,
  mediaType: "application/octet-stream",
  filename: undefined,
  source: { kind: "raw", bytes: new Uint8Array(size) },
});

/** The admission of `sizes` to a skill that takes 10 bytes of files in all. */
function admissionOf(...sizes: number[]) {
  const parts = {
    files: { store: new InlineA2AFileRepository() },
    clock: { now: () => new Date(0) },
  };
  const skill = { id: "skill", fileLimits: { maxTotalFileSize: 10 } };
  const caller = { tenantId: "t1", ownerId: "o1", signal: undefined };
  return fileAdmissionOf(
    parts as never,
    caller as never,
    { skill: skill as never, messageId: "m1" },
    sizes.map((size, index) => fileOf(index, size)),
  );
}

describe("#1366: the files of a message and maxTotalFileSize", () => {
  it("files that add up to the limit are admitted", async () => {
    const admitted = await admissionOf(4, 6)("task-1");

    expect(admitted.files.map((each) => each.file.sizeBytes)).toEqual([4, 6]);
  });

  it("files that add up to one byte over it are refused, the second one being the one that crosses", async () => {
    await expect(admissionOf(4, 7)("task-1")).rejects.toMatchObject({
      metadata: { code: "a2a.files-too-large" },
    });
  });

  it("one file past the limit alone is refused", async () => {
    await expect(admissionOf(11)("task-1")).rejects.toMatchObject({
      metadata: { code: "a2a.files-too-large" },
    });
  });
});
