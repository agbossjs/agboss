/**
 * #899 §3, §8: the output guardrails read the answer's files pinned to what the agent saw — a url file
 * whose server changes its content after the first read is refused (digest mismatch), never checked in its
 * new form while the answer hands on the old one.
 */
import { NO_REDACTION } from "./runtime-parts.js";
import { describe, expect, it } from "vitest";
import { seenPicker } from "../../src/files/answer-files.js";
import { sha256Of } from "../../src/files/file-bytes.js";
import { FileUnavailableReason } from "../../src/files/file-errors.js";
import { resolvedFilesOf } from "../../src/files/file-settings.js";
import { FileView, ModelFiles } from "../../src/files/model-files.js";
import type { FileRuntime } from "../../src/files/visit-files.js";
import { answerFilesViewed } from "../../src/flow/runtime/runners/answer-guard.js";
import { InMemoryFileRepository } from "../../src/infrastructure/in-memory-file.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { kilobytes, seconds } from "../../src/units/index.js";
import { PNG, scriptedTransport } from "../a2a/files/support.js";
import { DEFAULT_FILE_LIMITS } from "../../src/files/file-policy.js";

const URL_OF = "https://files.example/a.png";
const CHANGED = Buffer.concat([PNG, Buffer.from("changed")]);

const runtimeOn = (served: Record<string, { body: Uint8Array }>): FileRuntime => {
  const script = scriptedTransport(served);
  return {
    agent: "a-agent",
    settings: resolvedFilesOf({
      agent: ModelFiles.of({ views: [FileView.Original] }).options,
      defaults: undefined,
      limits: DEFAULT_FILE_LIMITS,
      hasPiiPolicy: false,
    }),
    maxResultSize: kilobytes(8),
    ...NO_REDACTION,
    transcriberKey: () => "t",
    transcribe: () => Promise.reject(new Error("none")),
    context: () => ({
      store: new InMemoryFileRepository(new InMemoryDatabase()),
      tenantId: "acme",
      ownerId: "root-1",
      signal: new AbortController().signal,
      clock: new VirtualClock(),
      transport: script.transport,
      allowedOrigins: ["https://files.example"],
      fetchTimeout: seconds(5),
      maxFileSize: kilobytes(8),
    }),
  };
};

const seenUrlFile = {
  source: { descriptor: { mediaType: "image/png", url: URL_OF }, field: "f", producer: "p" },
  digest: sha256Of(PNG),
};

const viewedOn = (
  runtime: FileRuntime,
  picked: ReturnType<ReturnType<typeof seenPicker>["pick"]>,
) => {
  if (picked.kind !== "file") throw new Error("not picked");
  const budgets = { check: () => undefined } as never;
  return answerFilesViewed(
    "a-agent",
    { answerFiles: [picked.file], fileTranscripts: {}, usage: [] },
    { reading: { runtime, budgets }, state: { usage: [], path: [] } as never, mask: undefined },
  );
};

describe("AC4: an answer file is pinned to the digest the agent saw", () => {
  const picked = seenPicker([seenUrlFile], true).pick(1);

  it("the picked url file is handed on with the sha256 of the bytes it was read as", () => {
    expect(picked.kind === "file" ? picked.file.sha256 : undefined).toBe(sha256Of(PNG));
  });

  it("unchanged: the output guardrails get the file", async () => {
    const viewed = await viewedOn(runtimeOn({ [URL_OF]: { body: PNG } }), picked);

    expect(viewed.files).toHaveLength(1);
  });

  it("changed after the first read: digest-mismatch, nothing is checked in its new form", async () => {
    const run = viewedOn(runtimeOn({ [URL_OF]: { body: CHANGED } }), picked);

    await expect(run).rejects.toMatchObject({ reason: FileUnavailableReason.DigestMismatch });
  });
});
