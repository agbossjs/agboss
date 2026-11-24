/**
 * #1269: what the files of an agent need of the models that read them — the kind of a media type in a
 * view, the needs of the views, the built-in transcriber's needs and the types a model takes.
 */
import { describe, expect, it } from "vitest";
import {
  hasModelForm,
  isTextFormat,
  kindOfView,
  narrowedTypesOf,
  needsOf,
  transcriberNeedsOf,
} from "../../src/files/file-needs.js";
import { resolvedFilesOf, type ResolvedModelFiles } from "../../src/files/file-settings.js";
import { FileView, type ModelFilesOptions } from "../../src/files/model-files.js";

const filesOf = (options: ModelFilesOptions): ResolvedModelFiles =>
  resolvedFilesOf({
    agent: options,
    defaults: undefined,
    filePolicy: undefined,
    hasPiiPolicy: false,
  });

describe("isTextFormat and hasModelForm", () => {
  it("a text format is text/* or JSON, nothing that only contains them", () => {
    expect(isTextFormat("text/csv")).toBe(true);
    expect(isTextFormat("application/json")).toBe(true);
    expect(isTextFormat("application/jsonl")).toBe(false);
    expect(isTextFormat("x-text/plain")).toBe(false);
    expect(isTextFormat("application/pdf")).toBe(false);
    expect(isTextFormat("")).toBe(false);
  });

  it("a model form: text, image, audio, video or PDF", () => {
    for (const type of ["text/plain", "image/png", "audio/mpeg", "video/mp4", "application/pdf"])
      expect(hasModelForm(type)).toBe(true);
    for (const type of ["application/zip", "application/x-pdf", "", "font/woff"])
      expect(hasModelForm(type)).toBe(false);
  });
});

describe("kindOfView", () => {
  it("the transcription of anything and a text format in any view are text", () => {
    expect(kindOfView("image/png", FileView.Transcription)).toBe("text");
    expect(kindOfView("application/pdf", FileView.Transcription)).toBe("text");
    expect(kindOfView("text/csv", FileView.Original)).toBe("text");
    expect(kindOfView("application/json", FileView.Redacted)).toBe("text");
  });

  it("an original or redacted file keeps its own kind", () => {
    expect(kindOfView("image/png", FileView.Original)).toBe("image");
    expect(kindOfView("image/png", FileView.Redacted)).toBe("image");
    expect(kindOfView("application/pdf", FileView.Original)).toBe("file");
    expect(kindOfView("audio/mpeg", FileView.Original)).toBe("audio");
    expect(kindOfView("video/mp4", FileView.Original)).toBe("video");
  });
});

describe("needsOf", () => {
  it("one need per type in the original view, none for a type with no model form", () => {
    const files = filesOf({
      views: [FileView.Original],
      allowedMediaTypes: ["image/png", "image/jpeg", "application/zip", "text/csv"],
    });

    expect(needsOf(files)).toEqual([
      { kind: "image", mediaType: "image/png", view: FileView.Original },
      { kind: "image", mediaType: "image/jpeg", view: FileView.Original },
      { kind: "text", mediaType: "text/csv", view: FileView.Original },
    ]);
  });

  it("the transcription is one text need whatever the types", () => {
    const files = filesOf({
      views: [FileView.Transcription],
      allowedMediaTypes: ["image/png", "image/jpeg", "application/pdf"],
    });

    expect(needsOf(files)).toEqual([
      { kind: "text", mediaType: "image/png", view: FileView.Transcription },
    ]);
  });

  it("a text format read in the original and in the transcription is two needs", () => {
    const files = filesOf({
      views: [FileView.Original, FileView.Transcription],
      allowedMediaTypes: ["text/csv"],
    });

    expect(needsOf(files)).toEqual([
      { kind: "text", mediaType: "text/csv", view: FileView.Original },
      { kind: "text", mediaType: "text/csv", view: FileView.Transcription },
    ]);
  });

  it("the same need of two views of one kind is told once", () => {
    const files = filesOf({
      views: [FileView.Original, FileView.Redacted],
      allowedMediaTypes: ["image/png"],
    });

    expect(needsOf(files)).toEqual([
      { kind: "image", mediaType: "image/png", view: FileView.Original },
    ]);
  });
});

describe("transcriberNeedsOf", () => {
  it("one raw need per kind: the first type of it, no text format, no type without a model form", () => {
    const files = filesOf({
      allowedMediaTypes: [
        "text/csv",
        "application/zip",
        "image/png",
        "image/jpeg",
        "application/pdf",
        "audio/mpeg",
      ],
    });

    expect(transcriberNeedsOf(files)).toEqual([
      { kind: "image", mediaType: "image/png", view: FileView.Transcription },
      { kind: "file", mediaType: "application/pdf", view: FileView.Transcription },
      { kind: "audio", mediaType: "audio/mpeg", view: FileView.Transcription },
    ]);
  });

  it("text formats alone need no transcriber model", () => {
    expect(transcriberNeedsOf(filesOf({ allowedMediaTypes: ["text/plain"] }))).toEqual([]);
  });
});

describe("narrowedTypesOf", () => {
  it("keeps the types every view of which the model reads, and a type no model reads as a file", () => {
    const files = filesOf({
      views: [FileView.Original],
      allowedMediaTypes: ["image/png", "application/pdf", "text/csv", "application/zip"],
    });

    expect(narrowedTypesOf(files, ["image"])).toEqual(["image/png", "application/zip"]);
  });

  it("a type must be read in every view, not in one of them", () => {
    const files = filesOf({
      views: [FileView.Original, FileView.Transcription],
      allowedMediaTypes: ["image/png"],
    });

    expect(narrowedTypesOf(files, ["text"])).toEqual([]);
    expect(narrowedTypesOf(files, ["text", "image"])).toEqual(["image/png"]);
  });
});
