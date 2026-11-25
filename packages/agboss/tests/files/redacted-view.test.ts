/**
 * #899 §5, §6, §7 (AC3, AC5): the redacted view — a project's redactor and the built-in on a real image,
 * what the model is shown, the cache, the spend, a block rule's refusal, and every way it fails closed.
 */
import { StepError } from "../../src/core/error-families/step-errors.js";
import { PiiError } from "../../src/core/error-families/limit-errors.js";
import { describe, expect } from "vitest";
import {
  FileSource,
  FileView,
  Injectable,
  ModelFiles,
  PiiFileAction,
  PiiKind,
  PiiPolicy,
  type FileContent,
  type RedactionResult,
  type RedactOptions,
} from "../../src/index.js";
import { sha256Of } from "../../src/files/file-bytes.js";
import { FileRedactor } from "../../src/files/file-redactor.js";
import { InMemoryFileRepository } from "../../src/infrastructure/in-memory-file.repository.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { usd } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { FETCHABLE, FetchTool, inline, PNG_BYTES, readerApplication } from "./reader.factory.js";

@PiiPolicy({
  name: "redact-cards-pii-policy",
  description: "Hides cards; the files are masked",
  rules: [PiiKind.CardNumber.mask()],
  files: PiiFileAction.Mask,
})
class CardsPolicy {}

@PiiPolicy({
  name: "redact-ssn-pii-policy",
  description: "Refuses a social security number",
  rules: [PiiKind.UsSsn.block("No SSN please.")],
  // a block rule refuses an image whole by default (tests/files/redaction-safety.test.ts); here a model judges
  files: PiiFileAction.RedactWithModel,
})
class SsnPolicy {}

/** What the project's redactor does this time. */
const spy: {
  calls: { file: FileContent; options: RedactOptions }[];
  found: PiiKind[];
  mode: "ok" | "throw" | "other-type" | "junk" | "empty" | "big";
} = { calls: [], found: [], mode: "ok" };

const resetSpy = () => {
  spy.calls = [];
  spy.found = [];
  spy.mode = "ok";
};

const COPY_TAIL = Buffer.from("-redacted");

/** A project's own redactor: takes png, makes "the copy" by appending a tail, as it is told. */
@Injectable()
class OwnRedactor extends FileRedactor {
  supports(mediaType: string): boolean {
    return mediaType === "image/png";
  }

  redact(file: FileContent, options: RedactOptions): Promise<RedactionResult> {
    spy.calls.push({ file, options });
    if (spy.mode === "throw") return Promise.reject(new Error("the service is down"));
    const body: Record<string, Buffer> = {
      ok: Buffer.concat([Buffer.from(file.bytes), COPY_TAIL]),
      "other-type": Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), COPY_TAIL]),
      junk: Buffer.from("not a png at all"),
      empty: Buffer.alloc(0),
      big: Buffer.concat([Buffer.from(file.bytes), Buffer.alloc(70 * 1024)]),
    };
    const bytes = body[spy.mode] ?? Buffer.alloc(0);
    return Promise.resolve({
      file: {
        mediaType: spy.mode === "other-type" ? "image/jpeg" : "image/png",
        ...(file.filename === undefined ? {} : { filename: file.filename }),
        bytes,
        sha256: sha256Of(bytes),
      },
      found: spy.found,
      cost: usd(0.02),
    });
  }
}

const REDACTED = ModelFiles.of({
  views: [FileView.Redacted],
  allowedMediaTypes: ["image/png", "text/csv"],
});
const stored = readerApplication({
  files: REDACTED,
  providers: [OwnRedactor, InMemoryFileRepository],
  piiPolicies: [CardsPolicy],
});
const toolFiles = readerApplication({
  files: ModelFiles.of({
    sources: [FileSource.Input, FileSource.ToolResults],
    views: [FileView.Redacted],
    allowedMediaTypes: ["image/png"],
  }),
  providers: [OwnRedactor, InMemoryFileRepository],
  piiPolicies: [CardsPolicy],
});
const blocking = readerApplication({
  files: REDACTED,
  providers: [OwnRedactor, InMemoryFileRepository],
  piiPolicies: [SsnPolicy],
});
const inlineMode = readerApplication({
  files: ModelFiles.of({ views: [FileView.Redacted], allowedMediaTypes: ["image/png"] }),
  providers: [OwnRedactor],
  piiPolicies: [CardsPolicy],
});
const noPolicy = readerApplication({
  files: REDACTED,
  providers: [OwnRedactor, InMemoryFileRepository],
});

const COPY = Buffer.concat([PNG_BYTES, COPY_TAIL]);
const partsOf = (request: { kind: string; parts?: readonly { sha256: string }[] }) =>
  request.kind === "chat" ? (request.parts ?? []) : [];

describe("AC3: the model reads the redacted copy, never the original", () => {
  testWith(stored.Application)(
    "AC3: the copy's digest is in the model's request; the redactor was asked for the policy's kinds",
    async ({ app, mockModel }) => {
      resetSpy();
      const agent = mockModel(stored.Agent).thenReturn(replyWith("ok"));

      const result = await execute(app, stored.Start, {
        document: inline(PNG_BYTES, "image/png", "card.png"),
      });

      expect(partsOf(agent.onlyRequest).map((part) => part.sha256)).toEqual([sha256Of(COPY)]);
      expect(partsOf(agent.onlyRequest).map((part) => part.sha256)).not.toContain(
        sha256Of(PNG_BYTES),
      );
      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0]?.options.targets).toEqual([PiiKind.CardNumber]);
      expect(result.spend.byCaller["files:redactor"]).toBeCloseTo(0.02);
    },
  );

  testWith(stored.Application)(
    "AC3: a text format in the redacted view is its masked text, no redactor call",
    async ({ app, mockModel }) => {
      resetSpy();
      const agent = mockModel(stored.Agent).thenReturn(replyWith("ok"));

      await execute(app, stored.Start, {
        document: inline(Buffer.from("card 4242 4242 4242 4242\n"), "text/csv", "c.csv"),
      });

      expect(spy.calls).toHaveLength(0);
      expect(JSON.stringify(agent.onlyRequest)).not.toContain("4242 4242");
    },
  );

  testWith(noPolicy.Application)(
    "AC3: with nothing to hide (no policy, no sensitive value) the redacted view is the file itself",
    async ({ app, mockModel }) => {
      resetSpy();
      const agent = mockModel(noPolicy.Agent).thenReturn(replyWith("ok"));

      await execute(app, noPolicy.Start, { document: inline(PNG_BYTES, "image/png", "a.png") });

      expect(spy.calls).toHaveLength(0);
      expect(partsOf(agent.onlyRequest).map((part) => part.sha256)).toEqual([sha256Of(PNG_BYTES)]);
    },
  );
});

describe("AC5: a redacted copy is made once per execution", () => {
  testWith(toolFiles.Application)(
    "AC5: the same file in the input and in a tool's result is redacted once; every model call reads the copy",
    async ({ app, mockModel }) => {
      resetSpy();
      FETCHABLE.set("again", inline(PNG_BYTES, "image/png", "again.png"));
      const agent = mockModel(toolFiles.Agent).thenReturn(
        callTool(FetchTool, { name: "again" }),
        replyWith("ok"),
      );

      await execute(app, toolFiles.Start, {
        document: inline(PNG_BYTES, "image/png", "card.png"),
      });

      expect(spy.calls).toHaveLength(1);
      for (const request of agent.requests)
        expect(partsOf(request).every((part) => part.sha256 === sha256Of(COPY))).toBe(true);
    },
  );
});

describe("AC3: a block rule's kind found in the file refuses it", () => {
  testWith(blocking.Application)(
    "AC3: the redactor found an SSN: PiiError.Refused with the policy's text, the model is never called",
    async ({ app, mockModel }) => {
      resetSpy();
      spy.found = [PiiKind.UsSsn];
      const agent = mockModel(blocking.Agent);

      const run = execute(app, blocking.Start, {
        document: inline(PNG_BYTES, "image/png", "id.png"),
      });

      await expect(run).rejects.toBeInstanceOf(PiiError.Refused);
      await expect(run).rejects.toMatchObject({ refusal: "No SSN please." });
      expect(agent).toHaveBeenCalledTimes(0);
    },
  );

  testWith(blocking.Application)(
    "AC3: a kind no block rule names is blacked out, not refused",
    async ({ app, mockModel }) => {
      resetSpy();
      spy.found = [PiiKind.CardNumber];
      mockModel(blocking.Agent).thenReturn(replyWith("ok"));

      const result = await execute(app, blocking.Start, {
        document: inline(PNG_BYTES, "image/png", "id.png"),
      });

      expect(result.output).toEqual({ text: "ok" });
    },
  );
});

describe("AC3: it fails closed — never the unredacted file in its place", () => {
  const visit = (app: Parameters<typeof execute>[0], target: typeof stored) =>
    execute(app, target.Start, { document: inline(PNG_BYTES, "image/png", "a.png") });

  testWith(stored.Application)(
    "a service that throws fails the step; the model is never called",
    async ({ app, mockModel }) => {
      resetSpy();
      spy.mode = "throw";
      const agent = mockModel(stored.Agent);

      await expect(visit(app, stored)).rejects.toThrow();
      expect(agent).toHaveBeenCalledTimes(0);
    },
  );

  testWith(stored.Application)(
    "an answer of another type, bytes that are not a png, or an empty file is StepError.FileMaskingFailed",
    async ({ app, mockModel }) => {
      const agent = mockModel(stored.Agent);
      for (const mode of ["other-type", "junk", "empty"] as const) {
        resetSpy();
        spy.mode = mode;
        await expect(visit(app, stored)).rejects.toBeInstanceOf(StepError.FileMaskingFailed);
      }
      expect(agent).toHaveBeenCalledTimes(0);
    },
  );

  testWith(inlineMode.Application)(
    "without a file store a copy over 64 KB does not fit the execution's state",
    async ({ app, mockModel }) => {
      resetSpy();
      spy.mode = "big";
      const agent = mockModel(inlineMode.Agent);

      await expect(visit(app, inlineMode)).rejects.toBeInstanceOf(StepError.FileMaskingFailed);
      expect(agent).toHaveBeenCalledTimes(0);
    },
  );

  testWith(inlineMode.Application)(
    "without a file store a small copy is kept inline and read",
    async ({ app, mockModel }) => {
      resetSpy();
      const agent = mockModel(inlineMode.Agent).thenReturn(replyWith("ok"));

      await visit(app, inlineMode);

      expect(partsOf(agent.onlyRequest).map((part) => part.sha256)).toEqual([sha256Of(COPY)]);
    },
  );
});
