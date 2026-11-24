/**
 * #1269 (files-pii mutation shard): what stops a file before a redactor is asked, and what an answer must
 * be to be taken — each refusal with its agent and its reason, each limit at its edge.
 */
import { describe, expect, it } from "vitest";
import { sha256Of, type FileContent } from "../../src/files/file-bytes.js";
import { FileRedactionFailedError } from "../../src/files/file-errors.js";
import type { RedactionPlan } from "../../src/files/file-redactor.js";
import { redactedViewOf } from "../../src/files/redacted-view.js";
import { PiiRefusedError } from "../../src/pii/errors.js";
import { PiiKind } from "../../src/pii/kinds.js";
import {
  AGENT,
  batchOf,
  JPEG_BYTES,
  maskOf,
  png,
  rejection,
  runtimeOf,
  type RuntimeOver,
} from "./mutation-b-redacted-view.fixture.js";

const HEADING = "### card";

const failureOf = async (promise: Promise<unknown>): Promise<FileRedactionFailedError> => {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(FileRedactionFailedError);
  return error as FileRedactionFailedError;
};

/** A redactor that records what it is asked and answers `answer`. */
function redactorAnswering(answer: (file: FileContent) => FileContent = (file) => file) {
  const asked: RedactionPlan[] = [];
  const events: string[] = [];
  const over: RuntimeOver = {
    redact: (file, plan) => {
      asked.push(plan);
      events.push("redact");
      return Promise.resolve({ file: answer(file), found: [] });
    },
  };
  return { asked, events, over };
}

const refusal = new PiiRefusedError({ kind: PiiKind.UsSsn.id, refusal: "No SSN please." });

describe("what stops a file before any redactor is asked", () => {
  it("a type no redactor takes has no redacted view, and no model is asked", async () => {
    const redactor = redactorAnswering();
    const batch = batchOf(
      runtimeOf({ ...redactor.over, supports: () => false }),
      maskOf(),
      {},
      () => redactor.events.push("budget"),
    );

    const error = await failureOf(redactedViewOf(batch, png(), HEADING));

    expect(error.reason).toBe("no redactor takes image/png");
    expect(error.agent).toBe(AGENT);
    expect(redactor.events).toEqual([]);
  });

  it("with no mask the file is shown as it is: nothing to hide", async () => {
    const redactor = redactorAnswering();

    const view = await redactedViewOf(batchOf(runtimeOf(redactor.over), undefined), png(), HEADING);

    expect(view.viewed).toEqual(png());
    expect(view.made).toBeUndefined();
    expect(redactor.events).toEqual([]);
  });

  it("a block rule's kind is refused by the policy where no model's judgement is accepted", async () => {
    const redactor = redactorAnswering();
    const mask = maskOf({ blocked: [PiiKind.UsSsn, PiiKind.CardNumber], refusal });

    const error = await rejection(
      redactedViewOf(batchOf(runtimeOf(redactor.over), mask), png(), HEADING),
    );

    expect(error).toBe(refusal);
    expect(mask.refusedFor).toEqual([PiiKind.UsSsn]);
    expect(redactor.events).toEqual([]);
  });

  it("a block rule the policy has no refusal for goes on to the redactor", async () => {
    const redactor = redactorAnswering();
    const mask = maskOf({ blocked: [PiiKind.UsSsn] });

    await redactedViewOf(batchOf(runtimeOf(redactor.over), mask), png(), HEADING);

    expect(mask.refusedFor).toEqual([PiiKind.UsSsn]);
    expect(redactor.events).toEqual(["redact"]);
  });

  it("where a model judges what an image holds, or no kind is blocked, the policy is not asked up front", async () => {
    const judged = maskOf({ blocked: [PiiKind.UsSsn], isModelChecked: true, refusal });
    const unblocked = maskOf({ blocked: [], refusal });
    const redactor = redactorAnswering();

    await redactedViewOf(batchOf(runtimeOf(redactor.over), judged), png(), HEADING);
    await redactedViewOf(batchOf(runtimeOf(redactor.over), unblocked), png(), HEADING);

    expect(judged.refusedFor).toEqual([]);
    expect(unblocked.refusedFor).toEqual([]);
    expect(redactor.events).toEqual(["redact", "redact"]);
  });

  it("values to redact that the redactor may not be told stop the file", async () => {
    const redactor = redactorAnswering();
    const mask = maskOf({ values: ["Dana Cohen"] });

    const error = await failureOf(
      redactedViewOf(
        batchOf(runtimeOf({ ...redactor.over, sendsValues: false }), mask),
        png(),
        HEADING,
      ),
    );

    expect(error.agent).toBe(AGENT);
    expect(error.reason).toBe(
      "the execution has values to redact that the redactor may not be told (defaults.files.redactionValues)",
    );
    expect(redactor.events).toEqual([]);
  });

  it("no kind and no value to look for stops the file; a kind alone, or a value alone, is enough", async () => {
    const redactor = redactorAnswering();
    const nothing = maskOf({ kinds: [], values: [] });

    const error = await failureOf(
      redactedViewOf(batchOf(runtimeOf(redactor.over), nothing), png(), HEADING),
    );
    await redactedViewOf(
      batchOf(runtimeOf(redactor.over), maskOf({ kinds: [PiiKind.CardNumber], values: [] })),
      png(),
      HEADING,
    );
    await redactedViewOf(
      batchOf(
        runtimeOf({ ...redactor.over, sendsValues: true }),
        maskOf({ kinds: [], values: ["Dana"] }),
      ),
      png(),
      HEADING,
    );

    expect(error.agent).toBe(AGENT);
    expect(error.reason).toBe(
      "the policies name no kind and no value for the redactor to look for",
    );
    expect(redactor.asked).toEqual([
      { targets: [PiiKind.CardNumber], values: [] },
      { targets: [], values: ["Dana"] },
    ]);
  });

  it("the budgets are checked once before the redactor is asked, never after", async () => {
    const redactor = redactorAnswering();

    await redactedViewOf(
      batchOf(runtimeOf(redactor.over), maskOf(), {}, () => redactor.events.push("budget")),
      png(),
      HEADING,
    );

    expect(redactor.events).toEqual(["budget", "redact"]);
  });
});

describe("what an answer must be to be taken", () => {
  const take = (over: RuntimeOver, answer: FileContent) =>
    redactedViewOf(
      batchOf(
        runtimeOf({ ...over, redact: () => Promise.resolve({ file: answer, found: [] }) }),
        maskOf(),
      ),
      png(),
      HEADING,
    );
  const jpeg = (bytes: Uint8Array = JPEG_BYTES): FileContent => ({
    mediaType: "image/jpeg",
    bytes,
    sha256: sha256Of(bytes),
  });

  it("a file of another media type is taken where the redactor takes that type too, not where it does not", async () => {
    const view = await take({ supports: () => true }, jpeg());
    const error = await failureOf(take({}, jpeg()));

    expect(view.viewed.mediaType).toBe("image/jpeg");
    expect(error.reason).toBe("the redactor answered a file of another media type");
    expect(error.agent).toBe(AGENT);
  });

  it("a file of the same media type is taken whatever the redactor says it supports of its answers", async () => {
    const view = await take({}, png(Buffer.concat([png().bytes, Buffer.from("-x")])));

    expect(view.viewed.mediaType).toBe("image/png");
  });

  it("bytes that are not what the media type says, or none at all, are refused", async () => {
    const junk = await failureOf(take({}, png(Buffer.from("not a png at all"))));
    const empty = await failureOf(take({}, png(Buffer.alloc(0))));

    expect(junk.reason).toBe("the redactor's file is not what its media type says");
    expect(empty.reason).toBe("the redactor's file is not what its media type says");
    expect(junk.agent).toBe(AGENT);
  });

  it("a copy with no bytes is refused even where the type has no signature to check", async () => {
    const csv = (text: string): FileContent => {
      const bytes = Buffer.from(text);
      return { mediaType: "text/csv", bytes, sha256: sha256Of(bytes) };
    };
    const batchOf2 = (answer: FileContent) =>
      batchOf(
        runtimeOf({
          supports: () => true,
          redact: () => Promise.resolve({ file: answer, found: [] }),
        }),
        maskOf(),
      );

    const error = await failureOf(redactedViewOf(batchOf2(csv("")), csv("a,b"), HEADING));
    const kept = await redactedViewOf(batchOf2(csv("c,d")), csv("a,b"), HEADING);

    expect(error.reason).toBe("the redactor's file is not what its media type says");
    expect(kept.viewed.mediaType).toBe("text/csv");
  });

  it("a copy of exactly maxFileSize is taken and one byte more is refused", async () => {
    const bytes = Buffer.concat([png().bytes, Buffer.from("-copy")]);

    const at = await take({ maxFileSize: bytes.byteLength }, png(bytes));
    const error = await failureOf(take({ maxFileSize: bytes.byteLength - 1 }, png(bytes)));

    expect(at.viewed.bytes.byteLength).toBe(bytes.byteLength);
    expect(error.reason).toBe("the redacted copy is over maxFileSize");
    expect(error.agent).toBe(AGENT);
  });

  it("the copy's digest is that of its bytes, whatever the redactor said it was", async () => {
    const bytes = Buffer.concat([png().bytes, Buffer.from("-copy")]);

    const view = await take({}, { ...png(bytes), sha256: "not-the-digest" });

    expect(view.viewed.sha256).toBe(sha256Of(bytes));
  });
});
