/**
 * #899 §5, §6, §7: what the redacted view needs at start — a redactor that takes every type the agent's
 * files can be (`[files.no-redactor]`), `sharp` for the built-in, a file store for a copy that does not fit
 * the execution's state (`[files.redacted-needs-store]`) — and what the built-in's model needs to read.
 */
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { FileRedactor } from "../../src/files/file-redactor.js";
import { FileView, ModelFiles } from "../../src/files/model-files.js";
import {
  Injectable,
  PiiFileAction,
  PiiKind,
  PiiPolicy,
  type RedactionResult,
} from "../../src/index.js";
import { InMemoryA2AFileRepository } from "../../src/infrastructure/in-memory-a2a-file.repository.js";
import { kilobytes } from "../../src/units/index.js";
import { readerApplication } from "./reader.factory.js";

@PiiPolicy({
  name: "start-cards-pii-policy",
  description: "Hides cards",
  rules: [PiiKind.CardNumber.mask()],
  files: PiiFileAction.Mask,
})
class CardsPolicy {}

@Injectable()
class PngRedactor extends FileRedactor {
  supports(mediaType: string): boolean {
    return mediaType === "image/png";
  }

  redact(): Promise<RedactionResult> {
    return Promise.reject(new Error("not asked in a start test"));
  }
}

@Injectable()
class AnyImageRedactor extends FileRedactor {
  supports(mediaType: string): boolean {
    return mediaType.startsWith("image/") || mediaType === "application/pdf";
  }

  redact(): Promise<RedactionResult> {
    return Promise.reject(new Error("not asked in a start test"));
  }
}

const codesOf = async (application: ReturnType<typeof readerApplication>): Promise<string[]> => {
  const failure = await applicationOf(application.Application).then(
    () => undefined,
    (error: unknown) => error,
  );
  const violations: unknown =
    failure instanceof Error ? Reflect.get(failure, "violations") : undefined;
  return Array.isArray(violations)
    ? violations.map((violation: unknown) => String(Reflect.get(Object(violation), "code")))
    : [];
};

const REDACTED = (types: string[], size = kilobytes(60)) =>
  ModelFiles.of({
    views: [FileView.Redacted],
    allowedMediaTypes: types,
    maxFileSize: size,
    maxTotalFileSize: size,
  });

describe("[files.no-redactor]: a redactor must take every type the files can be", () => {
  it("the built-in takes png, jpeg and webp; a pdf, audio or video has none", async () => {
    const images = readerApplication({
      files: REDACTED(["image/png", "image/jpeg", "image/webp"]),
      piiPolicies: [CardsPolicy],
    });
    const pdf = readerApplication({
      files: REDACTED(["image/png", "application/pdf"]),
      piiPolicies: [CardsPolicy],
    });
    const gif = readerApplication({ files: REDACTED(["image/gif"]), piiPolicies: [CardsPolicy] });
    const media = readerApplication({
      files: REDACTED(["audio/mpeg", "video/mp4"]),
      piiPolicies: [CardsPolicy],
    });

    expect(await codesOf(images)).toEqual([]);
    expect(await codesOf(pdf)).toEqual(["files.no-redactor"]);
    expect(await codesOf(gif)).toEqual(["files.no-redactor"]);
    expect(await codesOf(media)).toEqual(["files.no-redactor"]);
  });

  it("a text format needs none: its text is masked", async () => {
    const text = readerApplication({
      files: REDACTED(["text/csv", "image/png"]),
      piiPolicies: [CardsPolicy],
    });

    expect(await codesOf(text)).toEqual([]);
  });

  it("a project's own redactor is asked what it supports: png only leaves a pdf without one", async () => {
    const own = readerApplication({
      files: REDACTED(["image/png"]),
      providers: [PngRedactor],
      piiPolicies: [CardsPolicy],
    });
    const ownPdf = readerApplication({
      files: REDACTED(["image/png", "application/pdf"]),
      providers: [PngRedactor],
      piiPolicies: [CardsPolicy],
    });
    const wide = readerApplication({
      files: REDACTED(["image/gif", "application/pdf"]),
      providers: [AnyImageRedactor],
      piiPolicies: [CardsPolicy],
    });

    expect(await codesOf(own)).toEqual([]);
    expect(await codesOf(ownPdf)).toEqual(["files.no-redactor"]);
    expect(await codesOf(wide)).toEqual([]);
  });
});

describe("[files.redacted-needs-store]: a copy over 64 KB does not fit the execution's state", () => {
  it("limits that allow a larger image need an A2AFileRepository that keeps files", async () => {
    const small = readerApplication({
      files: REDACTED(["image/png"], kilobytes(64)),
      providers: [],
      piiPolicies: [CardsPolicy],
    });
    const large = readerApplication({
      files: REDACTED(["image/png"], kilobytes(65)),
      providers: [],
      piiPolicies: [CardsPolicy],
    });
    const largeStored = readerApplication({
      files: REDACTED(["image/png"], kilobytes(200)),
      providers: [InMemoryA2AFileRepository],
      piiPolicies: [CardsPolicy],
    });

    expect(await codesOf(small)).toEqual([]);
    expect(await codesOf(large)).toEqual(["files.redacted-needs-store"]);
    expect(await codesOf(largeStored)).toEqual([]);
  });
});
